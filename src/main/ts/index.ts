import { readFile, writeFile, rm, open } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import semver from 'semver';
import { isVulnerable, jsonRecords, object, type Advisory } from './audit.js';
import { descriptors, npmDescriptor, parseLockfile } from './lockfile.js';
import { createPlan, parsePolicy, type Plan, type UpdatePolicy } from './plan.js';
import { withManifestBackups } from './manifest.js';
import { restoreDescriptorHeaders } from './patch.js';
import { auditResult, createRunner, publishedVersions, requireSuccess, yarnCommands, type Runner, type InstallMode } from './yarn.js';

export { parseAudit, type Advisory } from './audit.js';
export { createPlan, type Plan, type Change, type Skipped, type UpdatePolicy } from './plan.js';
export { createRunner, type Runner, type InstallMode } from './yarn.js';

export interface FixOptions {
  cwd?: string;
  dryRun?: boolean;
  mode?: InstallMode;
  policy?: UpdatePolicy;
  runner?: Runner;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}
export interface FixResult extends Plan {
  policy: UpdatePolicy;
  yarnVersion: string;
  changed: boolean;
  dryRun: boolean;
  before: Advisory[];
  remaining: Advisory[];
  warnings: string[];
}

async function optionalRead(path: string): Promise<Buffer | undefined> {
  try { return await readFile(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function restore(files: Map<string, Buffer | undefined>): Promise<void> {
  const errors: unknown[] = [];
  for (const [path, content] of files) {
    try {
      if (content === undefined) await rm(path, { force: true });
      else await writeFile(path, content);
    } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'Could not restore project files');
}

/** Run at the workspace root. Yarn owns dependency resolution, fetching and graph normalization. */
export async function fixAudit(options: FixOptions = {}): Promise<FixResult> {
  const policy = parsePolicy(options.policy);
  const cwd = resolve(options.cwd ?? process.cwd());
  const manifestPath = join(cwd, 'package.json');
  const lockPath = join(cwd, 'yarn.lock');
  const [originalManifest, originalLock] = await Promise.all([readFile(manifestPath), readFile(lockPath)]);
  const manifest: unknown = JSON.parse(originalManifest.toString());
  if (!object(manifest)) throw new Error('Invalid package.json');
  const lock = parseLockfile(originalLock.toString());
  const existing = manifest.resolutions ?? {};
  if (!object(existing) || Object.values(existing).some(value => typeof value !== 'string')) {
    throw new Error('Invalid package.json resolutions');
  }
  const runner = options.runner ?? createRunner();
  const run = (args: string[]) => runner(args, {
    cwd, signal: options.signal,
    env: { ...process.env, YARN_ENABLE_SCRIPTS: 'false', YARN_ENABLE_TELEMETRY: '0', YARN_ENABLE_IMMUTABLE_INSTALLS: 'false' },
  });
  const yarnVersion = requireSuccess(await run(['--version']), 'Yarn version').trim();
  const commands = yarnCommands(yarnVersion, options.mode);
  const auditArgs = commands.audit;
  const warnings: string[] = [];
  if (commands.major < 4) {
    const versionsByName = new Map<string, Set<string>>();
    for (const entry of Object.values(lock)) {
      const locator = entry.resolution && npmDescriptor(entry.resolution);
      if (!locator || !entry.version) continue;
      const versions = versionsByName.get(locator.name) ?? new Set<string>();
      versions.add(entry.version);
      versionsByName.set(locator.name, versions);
    }
    const duplicates = [...versionsByName].filter(([, versions]) => versions.size > 1).map(([name]) => name).sort();
    if (duplicates.length) warnings.push(`Yarn ${yarnVersion} legacy audit sends only one version per package name; findings may be incomplete for: ${duplicates.join(', ')}`);
  }
  options.onProgress?.(`Auditing with Yarn ${yarnVersion}`);
  const before = auditResult(await run(auditArgs));
  const versions: Record<string, string[]> = {};
  for (const name of new Set(before.map(advisory => advisory.name))) {
    options.onProgress?.(`Looking up published versions of ${name}`);
    versions[name] = publishedVersions(requireSuccess(await run(['npm', 'info', name, '--fields', 'versions', '--json']), 'Package metadata'), name);
  }
  const plan = createPlan(lock, before, versions, existing as Record<string, string>, policy);
  const result: FixResult = { ...plan, policy, yarnVersion, changed: false, dryRun: !!options.dryRun, before, remaining: before, warnings };
  if (options.dryRun || !plan.changes.length) return result;

  const guardPath = join(cwd, '.yarn-berry-audit-fix.lock');
  const guard = await open(guardPath, 'wx');
  try {
    // Do not overwrite edits made while the registry was being queried.
    if (!(await readFile(manifestPath)).equals(originalManifest) || !(await readFile(lockPath)).equals(originalLock)) {
      throw new Error('Project changed during planning; retry with an idle project');
    }
    const manifests = new Set([manifestPath]);
    const preserved = new Map<string, Buffer | undefined>();
    preserved.set(join(cwd, '.yarnrc.yml'), await optionalRead(join(cwd, '.yarnrc.yml')));
    if (manifest.workspaces !== undefined) {
      const workspaces = requireSuccess(await run(['workspaces', 'list', '--json']), 'Workspace discovery');
      for (const workspace of jsonRecords(workspaces)) {
        if (!object(workspace) || typeof workspace.location !== 'string') throw new Error('Invalid workspace response');
        const path = resolve(cwd, workspace.location, 'package.json');
        const local = relative(cwd, path);
        if (isAbsolute(local) || local === '..' || local.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
          throw new Error('Workspace is outside the project root');
        }
        manifests.add(path);
      }
    }
    // Yarn may write install state even in update-lockfile mode. Retain its previous contents on rollback.
    const statePath = requireSuccess(await run(['config', 'get', 'installStatePath', '--json']), 'Install state location');
    const stateLocation: unknown = JSON.parse(statePath);
    if (typeof stateLocation !== 'string') throw new Error('Invalid installStatePath');
    const stateFile = resolve(cwd, stateLocation);
    const originalState = await optionalRead(stateFile);
    try {
      options.signal?.throwIfAborted();
      options.onProgress?.(`Installing ${plan.changes.length} compatible temporary resolutions`);
      await withManifestBackups(manifests, async () => {
        await writeFile(manifestPath, JSON.stringify({ ...manifest, resolutions: { ...existing, ...plan.resolutions } }, null, 2) + '\n');
        requireSuccess(await run(commands.install), 'Temporary resolutions install');
      });
      await restore(preserved);
      options.onProgress?.('Restoring original dependency request headers in the lockfile');
      const generatedLock = await readFile(lockPath, 'utf8');
      await writeFile(lockPath, restoreDescriptorHeaders(generatedLock, plan.changes));
      options.onProgress?.('Auditing the restored project');
      result.remaining = auditResult(await run(auditArgs));
      const finalLock = descriptors(parseLockfile(await readFile(lockPath, 'utf8')));
      result.changes = plan.changes.map(change => {
        const entry = finalLock.get(change.descriptor);
        // A descriptor can disappear when its parent was itself upgraded.
        if (!entry) return { ...change, removed: true };
        if (!entry.version || !semver.satisfies(entry.version, npmDescriptor(change.descriptor)!.range) ||
            isVulnerable(entry.version, [...before, ...result.remaining].filter(a => a.name === change.name))) {
          throw new Error(`Fix did not survive manifest restoration: ${change.descriptor}`);
        }
        return { ...change, to: entry.version };
      });
      result.changed = !(await readFile(lockPath)).equals(originalLock);
      if (options.mode === 'update-lockfile') await restore(new Map([[stateFile, originalState]]));
      return result;
    } catch (error) {
      try {
        await restore(new Map([...preserved, [lockPath, originalLock], [stateFile, originalState]]));
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Fix failed and rollback was incomplete');
      }
      throw error;
    }
  } finally {
    await guard.close();
    await rm(guardPath, { force: true });
  }
}

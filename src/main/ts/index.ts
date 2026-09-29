import { readFile, writeFile, rm, open } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute, sep } from 'node:path';
import semver from 'semver';
import { isVulnerable, jsonRecords, object, type Advisory } from './audit.js';
import { createAuditor } from './auditor.js';
import { addCatalogResolutions, catalogDescriptors } from './catalog.js';
import { descriptors, npmDescriptor, parseLockfile, type Lockfile } from './lockfile.js';
import { createPlan, parsePolicy, type Change, type Plan, type UpdatePolicy } from './plan.js';
import { withManifestBackups } from './manifest.js';
import { restoreDescriptorHeaders } from './patch.js';
import { verifiedPlan } from './planning.js';
import { createRunner, parseAuditRegistry, publishedVersions, requireSuccess, yarnCommands, type Runner, type InstallMode } from './yarn.js';

export { parseAudit, type Advisory } from './audit.js';
export { createPlan, type Plan, type Change, type Skipped, type UpdatePolicy } from './plan.js';
export { createRunner, type Runner, type InstallMode } from './yarn.js';

export interface FixOptions {
  cwd?: string;
  dryRun?: boolean;
  mode?: InstallMode;
  policy?: UpdatePolicy;
  auditRegistry?: string;
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

type Run = (args: string[]) => ReturnType<Runner>;

async function workspaceManifests(cwd: string, manifest: Record<string, unknown>, run: Run): Promise<Set<string>> {
  const manifests = new Set([join(cwd, 'package.json')]);
  if (manifest.workspaces === undefined) return manifests;
  const workspaces = requireSuccess(await run(['workspaces', 'list', '--json']), 'Workspace discovery');
  for (const workspace of jsonRecords(workspaces)) {
    if (!object(workspace) || typeof workspace.location !== 'string') throw new Error('Invalid workspace response');
    const path = resolve(cwd, workspace.location, 'package.json');
    const local = relative(cwd, path);
    if (isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`)) {
      throw new Error('Workspace is outside the project root');
    }
    manifests.add(path);
  }
  return manifests;
}

function verifiedChanges(lock: Lockfile, changes: Change[], advisories: Advisory[]): Change[] {
  const entries = descriptors(lock);
  return changes.map(change => {
    const entry = entries.get(change.descriptor);
    // A descriptor can disappear when its parent was itself upgraded.
    if (!entry) return { ...change, removed: true };
    if (!entry.version || !semver.satisfies(entry.version, npmDescriptor(change.descriptor)!.range) ||
        isVulnerable(entry.version, advisories.filter(a => a.name === change.name))) {
      throw new Error(`Fix did not survive manifest restoration: ${change.descriptor}`);
    }
    return { ...change, to: entry.version };
  });
}

/** Run at the workspace root. Yarn owns dependency resolution, fetching and graph normalization. */
export async function fixAudit(options: FixOptions = {}): Promise<FixResult> {
  const policy = parsePolicy(options.policy);
  const auditRegistry = parseAuditRegistry(options.auditRegistry);
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
  const auditor = createAuditor({
    registry: auditRegistry, yarnVersion, major: commands.major,
    run: () => run(commands.audit), signal: options.signal, onProgress: options.onProgress,
  });
  options.onProgress?.(`Auditing with Yarn ${yarnVersion}`);
  const before = await auditor.read(lock);
  const versions: Record<string, string[]> = {};
  for (const name of new Set(before.map(advisory => advisory.name))) {
    options.onProgress?.(`Looking up published versions of ${name}`);
    versions[name] = publishedVersions(requireSuccess(await run(['npm', 'info', name, '--fields', 'versions', '--json']), 'Package metadata'), name);
  }
  const { plan, advisories } = await verifiedPlan(before,
    findings => createPlan(lock, findings, versions, existing as Record<string, string>, policy),
    packages => auditor.candidates(packages), options.onProgress);
  const catalogs = await catalogDescriptors(lock, run, new Set(plan.changes.map(change => change.name)));
  addCatalogResolutions(plan, catalogs);
  const result: FixResult = { ...plan, policy, yarnVersion, changed: false, dryRun: !!options.dryRun, before, remaining: before, warnings: auditor.warnings };
  if (options.dryRun || !plan.changes.length) return result;

  const guardPath = join(cwd, '.yarn-berry-audit-fix.lock');
  const guard = await open(guardPath, 'wx');
  try {
    // Do not overwrite edits made while the registry was being queried.
    if (!(await readFile(manifestPath)).equals(originalManifest) || !(await readFile(lockPath)).equals(originalLock)) {
      throw new Error('Project changed during planning; retry with an idle project');
    }
    const preserved = new Map<string, Buffer | undefined>();
    preserved.set(join(cwd, '.yarnrc.yml'), await optionalRead(join(cwd, '.yarnrc.yml')));
    const manifests = await workspaceManifests(cwd, manifest, run);
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
      await writeFile(lockPath, restoreDescriptorHeaders(generatedLock, plan.changes, catalogs));
      options.onProgress?.('Auditing the restored project');
      const finalLock = parseLockfile(await readFile(lockPath, 'utf8'));
      result.remaining = await auditor.read(finalLock);
      result.changes = verifiedChanges(finalLock, plan.changes, [...advisories, ...result.remaining]);
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

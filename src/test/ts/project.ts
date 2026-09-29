import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { stringifySyml } from '@yarnpkg/parsers';
import { descriptors, parseLockfile, type Lockfile } from '../../main/ts/lockfile.js';
import { createRunner, requireSuccess, type Runner } from '../../main/ts/yarn.js';
import { readFixture, readFixtureManifest } from './build-fixtures.js';

export function projectRunner(cwd: string, yarn: string) {
  const actual = createRunner([process.execPath, yarn]);
  const runner: Runner = (args, options) => actual(args, {
    ...options, env: { ...options.env, YARN_IGNORE_PATH: '1', YARN_ENABLE_IMMUTABLE_INSTALLS: 'false', YARN_ENABLE_SCRIPTS: 'false' },
  });
  const run = (args: string[]) => runner(args, { cwd, env: process.env });
  return { cwd, runner, run };
}

export async function writeYarnConfig(cwd: string, registry: string, linker = 'node-modules') {
  await writeFile(join(cwd, '.yarnrc.yml'), stringifySyml({
    npmRegistryServer: registry, unsafeHttpWhitelist: ['127.0.0.1'], enableGlobalCache: false,
    globalFolder: join(cwd, '.global'), enableTelemetry: false, enableScripts: false,
    compressionLevel: 'mixed', nodeLinker: linker,
  }));
}

export async function prepareProject(cwd: string, registry: string, yarn: string, {
  repo = 'packasso', workspace = false, rootRange = '^3.1.2',
}: { repo?: string; workspace?: boolean; rootRange?: string } = {}) {
  const source = parseLockfile((await readFixture(`qiwi/${repo}/yarn.lock`)).toString());
  const lock = Object.fromEntries(Object.entries(source).filter(([key, entry]) => key === '__metadata' ||
    ['minimatch@npm:3.1.2', 'minimatch@npm:9.0.3', 'brace-expansion@npm:1.1.11',
      'brace-expansion@npm:2.0.1', 'balanced-match@npm:1.0.2', 'concat-map@npm:0.0.1'].includes(entry.resolution ?? '')));
  await writeFile(join(cwd, 'package.json'), JSON.stringify({
    name: 'fixture', private: true, ...(workspace ? { workspaces: ['packages/*'] } : {}), dependencies: { minimatch: rootRange },
  }, null, '\t') + '\n');
  if (workspace) {
    await mkdir(join(cwd, 'packages/child'), { recursive: true });
    await writeFile(join(cwd, 'packages/child/package.json'), '{ "name": "child", "dependencies": { "minimatch": "^9.0.3" } }\n');
  }
  await writeFile(join(cwd, 'yarn.lock'), stringifySyml(lock));
  await writeYarnConfig(cwd, registry);
  const project = projectRunner(cwd, yarn);
  // Normalize native schemas and cache checksums before testing a repair.
  requireSuccess(await project.run(['install']), 'Prepare native fixture');
  await rm(join(cwd, 'node_modules'), { recursive: true, force: true });
  if (workspace) await rm(join(cwd, 'packages/child/node_modules'), { recursive: true, force: true });
  return project;
}

/** Retain real workspace identities, paths, links and selected dependency ranges. */
export async function prepareMonorepo(cwd: string, registry: string, yarn: string, source: string, dependencies: string[], linker: string) {
  const provenance = await readFixtureManifest();
  const files = Object.keys(provenance).filter(file => file.startsWith(`${source}/`) && file.endsWith('/package.json'));
  const originals = await Promise.all(files.map(async file => ({
    file: file.slice(source.length + 1), manifest: JSON.parse((await readFixture(file)).toString()),
  })));
  const names = new Set(originals.map(({ manifest }) => manifest.name).filter(Boolean));
  const keep = new Set([...names, ...dependencies]);
  const requests = new Set<string>();
  const manifests = new Map<string, Buffer>();
  for (const { file, manifest } of originals) {
    const projected: Record<string, unknown> = Object.fromEntries(['name', 'version', 'private', 'workspaces']
      .filter(field => manifest[field] !== undefined).map(field => [field, manifest[field]]));
    // Build hooks and unrelated dependencies belong to the upstream application, not this install oracle.
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      if (!manifest[field]) continue;
      const selected = Object.fromEntries(Object.entries(manifest[field] as Record<string, string>).filter(([name]) => keep.has(name)));
      if (Object.keys(selected).length) projected[field] = selected;
      if (field !== 'peerDependencies') for (const [name, range] of Object.entries(selected)) {
        if (!names.has(name)) requests.add(`${name}@${range.includes(':') ? range : `npm:${range}`}`);
      }
    }
    const contents = Buffer.from(JSON.stringify(projected, null, 2) + '\n');
    await mkdir(dirname(join(cwd, file)), { recursive: true });
    await writeFile(join(cwd, file), contents);
    manifests.set(file, contents);
  }
  const lock = parseLockfile((await readFixture(`${source}/yarn.lock`)).toString());
  const entries = descriptors(lock);
  const selected = new Set<Lockfile[string]>();
  const visit = (descriptor: string) => {
    const entry = entries.get(descriptor);
    if (!entry) throw new Error(`Missing upstream descriptor: ${descriptor}`);
    if (selected.has(entry)) return;
    selected.add(entry);
    for (const [name, range] of Object.entries(entry.dependencies ?? {})) {
      if (typeof range !== 'string') throw new Error('Invalid upstream dependency');
      visit(`${name}@${range.includes(':') ? range : `npm:${range}`}`);
    }
  };
  for (const descriptor of requests) visit(descriptor);
  const subset = Object.fromEntries(Object.entries(lock).filter(([key, entry]) => key === '__metadata' || selected.has(entry)));
  await writeFile(join(cwd, 'yarn.lock'), stringifySyml(subset));
  await writeYarnConfig(cwd, registry, linker);
  const project = projectRunner(cwd, yarn);
  requireSuccess(await project.run(['install']), 'Prepare upstream workspace subgraph');
  return { ...project, manifests };
}

import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { stringifySyml } from '@yarnpkg/parsers';
import { fixAudit } from '../../main/ts/index.js';
import { withResolutionAliases } from '../../main/ts/resolution-aliases.js';
import { descriptors, parseLockfile } from '../../main/ts/lockfile.js';
import { requireSuccess } from '../../main/ts/yarn.js';
import { startRegistry } from './registry.js';
import { prepareProject } from './project.js';
import { managers } from './pm.js';

const require = createRequire(import.meta.url);
let registry: Awaited<ReturnType<typeof startRegistry>>;
beforeAll(async () => { registry = await startRegistry(); });
afterAll(async () => { await registry?.close(); });
afterEach(() => vi.unstubAllEnvs());

it.each(managers)('applies both compatible branches in one native Yarn $version install', async ({ alias, schema }) => {
  const cwd = await mkdtemp(join(tmpdir(), 'ybaf-aliases-'));
  try {
    const { runner, run } = await prepareProject(cwd, registry.url, require.resolve(`${alias}/bin/yarn.js`), { repo: 'masker', workspace: true });
    const original = await readFile(join(cwd, 'package.json'));
    const changes = [
      { name: 'brace-expansion', descriptor: 'brace-expansion@npm:^1.1.7', from: '1.1.11', to: '1.1.18' },
      { name: 'brace-expansion', descriptor: 'brace-expansion@npm:^2.0.1', from: '2.0.1', to: '2.1.4' },
    ];
    await withResolutionAliases(cwd, changes, async pluginPath => {
      requireSuccess(await runner(['install', ...(schema > 4 ? ['--mode=update-lockfile'] : [])], {
        cwd, env: { ...process.env, YARN_PLUGINS: pluginPath },
      }), 'Resolution aliases install');
    });
    expect(await readFile(join(cwd, 'package.json'))).toEqual(original);
    const fixed = await readFile(join(cwd, 'yarn.lock'));
    const entries = descriptors(parseLockfile(fixed.toString()));
    for (const change of changes) expect(entries.get(change.descriptor)?.version).toBe(change.to);
    requireSuccess(await run(['install', '--immutable']), 'Immutable install after aliases');
    expect(await readFile(join(cwd, 'yarn.lock'))).toEqual(fixed);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

it('scopes aliases to the repaired project when another Yarn process inherits the plugin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ybaf-plugin-scope-'));
  try {
    const cwd = join(directory, 'root');
    const other = join(directory, 'other');
    await Promise.all([mkdir(cwd), mkdir(other)]);
    const yarn = require.resolve('pm-yarn-berry-v10/bin/yarn.js');
    const root = await prepareProject(cwd, registry.url, yarn);
    const nested = await prepareProject(other, registry.url, yarn);
    const original = await readFile(join(other, 'yarn.lock'));
    const changes = [{ name: 'brace-expansion', descriptor: 'brace-expansion@npm:^1.1.7', from: '1.1.11', to: '1.1.18' }];
    await withResolutionAliases(cwd, changes, async pluginPath => {
      for (const project of [nested, root]) requireSuccess(await project.runner(['install'], {
        cwd: project.cwd, env: { ...process.env, YARN_PLUGINS: pluginPath },
      }), 'Scoped plugin install');
    });
    expect(await readFile(join(other, 'yarn.lock'))).toEqual(original);
    expect(descriptors(parseLockfile(await readFile(join(cwd, 'yarn.lock'), 'utf8'))).get(changes[0]!.descriptor)?.version).toBe('1.1.18');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it.each(managers.filter(({ schema }) => [4, 6, 10].includes(schema)))('preserves user plugins, resolutions, exact pins and npm aliases with Yarn $version', async ({ alias }) => {
  const cwd = await mkdtemp(join(tmpdir(), 'ybaf user plugins '));
  try {
    const { runner, run } = await prepareProject(cwd, registry.url, require.resolve(`${alias}/bin/yarn.js`), { repo: 'masker', workspace: true });
    for (const [name, range] of [['range', '^1.1.7'], ['exact', '1.1.18'], ['alias', 'npm:brace-expansion@1.1.11']]) {
      const path = join(cwd, 'packages', name!);
      await mkdir(path);
      await writeFile(join(path, 'package.json'), JSON.stringify({ name, dependencies: { [name === 'alias' ? 'old-brace' : 'brace-expansion']: range } }));
    }
    const root = join(cwd, 'package.json');
    const manifest = JSON.parse(await readFile(root, 'utf8'));
    manifest.resolutions = { 'balanced-match': 'npm:1.0.2' };
    await writeFile(root, JSON.stringify(manifest));
    requireSuccess(await run(['install']), 'Prepare exact pins and npm aliases');
    const original = await readFile(root);
    for (const name of ['environment', 'configuration']) {
      const source = `module.exports = { name: ${JSON.stringify(name)}, factory: require => ({ hooks: { validateProject() {
        const fs = require('fs');
        if (fs.readFileSync(${JSON.stringify(root)}, 'utf8') !== ${JSON.stringify(original.toString())}) throw new Error('Manifest was changed before install');
        fs.writeFileSync(${JSON.stringify(join(cwd, `${name}.ran`))}, 'ok');
      } } }) };`;
      await writeFile(join(cwd, `${name}.cjs`), source);
    }
    const config = join(cwd, '.yarnrc.yml');
    await writeFile(config, await readFile(config, 'utf8') + '\nplugins:\n  - path: ./configuration.cjs\n');
    const originalConfig = await readFile(config);
    const envPlugin = join(cwd, 'environment.cjs');
    vi.stubEnv('YARN_PLUGINS', envPlugin);
    let temporaryPlugin = '';
    const report = await fixAudit({ cwd, auditRegistry: registry.url, runner: async (args, options) => {
      if (args[0] === 'install') {
        expect(options.env.YARN_PLUGINS).toContain(`${envPlugin};`);
        temporaryPlugin = options.env.YARN_PLUGINS!.slice(envPlugin.length + 1);
      }
      return runner(args, options);
    } });
    expect(report.changes.map(change => change.to)).toEqual(['1.1.18', '2.1.4']);
    expect(report.skipped).toContainEqual(expect.objectContaining({ descriptor: 'old-brace@npm:brace-expansion@1.1.11' }));
    expect(report.remaining.length).toBeGreaterThan(0);
    expect(await readFile(root)).toEqual(original);
    expect(await readFile(config)).toEqual(originalConfig);
    expect(process.env.YARN_PLUGINS).toBe(envPlugin);
    await expect(readFile(temporaryPlugin)).rejects.toMatchObject({ code: 'ENOENT' });
    for (const name of ['environment', 'configuration']) expect(await readFile(join(cwd, `${name}.ran`), 'utf8')).toBe('ok');
    const fixed = await readFile(join(cwd, 'yarn.lock'));
    const entries = descriptors(parseLockfile(fixed.toString()));
    expect(entries.get('brace-expansion@npm:1.1.18')?.version).toBe('1.1.18');
    expect(entries.get('old-brace@npm:brace-expansion@1.1.11')?.version).toBe('1.1.11');
    requireSuccess(await run(['install', '--immutable']), 'Immutable install with user plugins and pins');
    expect(await readFile(join(cwd, 'yarn.lock'))).toEqual(fixed);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

it('lets Yarn generate long combined headers for many compatible workspace ranges', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ybaf-long-keys-'));
  try {
    const { runner, run } = await prepareProject(cwd, registry.url, require.resolve('pm-yarn-berry-v10/bin/yarn.js'), { repo: 'masker', workspace: true });
    const lockPath = join(cwd, 'yarn.lock');
    const lock = parseLockfile(await readFile(lockPath, 'utf8'));
    const entry = descriptors(lock).get('brace-expansion@npm:^1.1.7')!;
    for (let index = 0; index < 40; index++) {
      const range = `>=1.0.${index} <2`;
      const directory = join(cwd, `packages/range-${index}`);
      await mkdir(directory);
      await writeFile(join(directory, 'package.json'), JSON.stringify({ name: `range-${index}`, dependencies: { 'brace-expansion': range } }));
      lock[`brace-expansion@npm:${range}`] = entry;
    }
    await writeFile(lockPath, stringifySyml(lock));
    requireSuccess(await run(['install']), 'Prepare many compatible ranges');
    let generated = Buffer.alloc(0);
    const report = await fixAudit({ cwd, auditRegistry: registry.url, runner: async (args, options) => {
      const result = await runner(args, options);
      if (args[0] === 'install') generated = await readFile(lockPath);
      return result;
    } });
    expect(report.changes).toHaveLength(42);
    expect(report.remaining).toEqual([]);
    expect(await readFile(lockPath)).toEqual(generated);
    expect(generated.toString()).toContain('? "brace-expansion@');
    requireSuccess(await run(['install', '--immutable', '--check-resolutions']), 'Immutable install with long combined headers');
    expect(await readFile(lockPath)).toEqual(generated);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

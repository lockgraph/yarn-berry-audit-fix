import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { stringifySyml } from '@yarnpkg/parsers';
import { fixAudit, createRunner, type InstallMode } from '../../main/ts/index.js';
import { descriptors, parseLockfile } from '../../main/ts/lockfile.js';
import { requireSuccess, type Runner } from '../../main/ts/yarn.js';
import { startRegistry } from './registry.js';
import { managers } from './pm.js';
import { readFixture } from './build-fixtures.js';

const require = createRequire(import.meta.url);
let registry: Awaited<ReturnType<typeof startRegistry>>;
const directories: string[] = [];
beforeAll(async () => { registry = await startRegistry(); });
afterAll(async () => {
  await registry?.close();
  await Promise.all(directories.map(path => rm(path, { recursive: true, force: true })));
});

async function project(repo: string, yarn: string, workspace = false, rootRange = '^3.1.2') {
  const cwd = await mkdtemp(join(tmpdir(), 'berry-audit-fix-'));
  directories.push(cwd);
  const raw = (await readFixture(`qiwi/${repo}/yarn.lock`)).toString();
  const source = parseLockfile(raw);
  // An actual dependency subgraph, retaining upstream descriptors, dependencies and checksums.
  const lock = Object.fromEntries(Object.entries(source).filter(([key, entry]) => key === '__metadata' ||
    ['minimatch@npm:3.1.2', 'minimatch@npm:9.0.3', 'brace-expansion@npm:1.1.11',
      'brace-expansion@npm:2.0.1', 'balanced-match@npm:1.0.2', 'concat-map@npm:0.0.1'].includes(entry.resolution ?? '')));
  const dependencies = { minimatch: rootRange };
  const manifest = { name: 'fixture', private: true, ...(workspace ? { workspaces: ['packages/*'] } : {}), dependencies };
  await writeFile(join(cwd, 'package.json'), JSON.stringify(manifest, null, '\t') + '\n');
  if (workspace) {
    await mkdir(join(cwd, 'packages/child'), { recursive: true });
    await writeFile(join(cwd, 'packages/child/package.json'), '{ "name": "child", "dependencies": { "minimatch": "^9.0.3" } }\n');
  }
  await writeFile(join(cwd, 'yarn.lock'), stringifySyml(lock));
  await writeFile(join(cwd, '.yarnrc.yml'), `npmRegistryServer: "${registry.url}"\nunsafeHttpWhitelist:\n  - 127.0.0.1\nenableGlobalCache: false\nglobalFolder: "${cwd}/.global"\nenableTelemetry: false\nenableScripts: false\ncompressionLevel: mixed\nnodeLinker: node-modules\n`);
  const actual = createRunner([process.execPath, require.resolve(`${yarn}/bin/yarn.js`)]);
  const runner: Runner = (args, options) => actual(args, {
    ...options, env: { ...options.env, YARN_IGNORE_PATH: '1', YARN_ENABLE_IMMUTABLE_INSTALLS: 'false', YARN_ENABLE_SCRIPTS: 'false' },
  });
  const run = (args: string[]) => runner(args, { cwd, env: process.env });
  // Each producer must normalize both schema and cache checksums. Lockfile-only
  // would retain foreign checksums when downgrading the upstream Yarn 4 fixture.
  requireSuccess(await run(['install']), 'Prepare native fixture');
  await rm(join(cwd, 'node_modules'), { recursive: true, force: true });
  if (workspace) await rm(join(cwd, 'packages/child/node_modules'), { recursive: true, force: true });
  return { cwd, runner, run };
}

describe.each(managers)('Yarn $version / lockfile v$schema', ({ alias: yarn, version, schema }) => {
  const modes: (InstallMode | undefined)[] = schema === 4 ? [undefined] : [undefined, 'update-lockfile'];
  const cases = modes.flatMap(mode => [false, true].map(workspace => ({ mode, workspace })));
  it.each(cases)('repairs reported qiwi transitives and survives immutable install (workspaces=$workspace, mode=$mode)', async ({ workspace, mode }) => {
    const { cwd, runner, run } = await project(workspace || schema >= 8 ? 'masker' : 'packasso', yarn, workspace);
    expect(requireSuccess(await run(['--version']), 'Pinned Yarn version').trim()).toBe(version);
    expect(parseLockfile(await readFile(join(cwd, 'yarn.lock'), 'utf8')).__metadata?.version).toBe(String(schema));
    // Cover both an existing installed tree and an initially absent one.
    const preinstalled = mode && !workspace;
    if (preinstalled) requireSuccess(await run(['install']), 'Existing installed tree');
    const state = await readFile(join(cwd, '.yarn/install-state.gz')).catch(() => undefined);
    const original = await readFile(join(cwd, 'package.json'));
    const originalStat = await stat(join(cwd, 'package.json'));
    const backupName = `package.json-${createHash('sha256').update(original).digest('hex')}.backup`;
    const child = workspace ? await readFile(join(cwd, 'packages/child/package.json')) : undefined;
    let lastYarnLock = await readFile(join(cwd, 'yarn.lock'));
    let installs = 0;
    const observedRunner: Runner = async (args, options) => {
      if (args[0] !== 'install') return runner(args, options);
      expect(args).toEqual(mode ? ['install', '--mode=update-lockfile'] : ['install']);
      // Before the only install, the input lockfile is unchanged.
      expect(await readFile(join(cwd, 'yarn.lock'))).toEqual(lastYarnLock);
      expect(await readFile(join(cwd, backupName))).toEqual(original);
      expect((await stat(join(cwd, backupName))).ino).toBe(originalStat.ino);
      installs++;
      const output = await runner(args, options);
      lastYarnLock = await readFile(join(cwd, 'yarn.lock'));
      return output;
    };
    const report = await fixAudit({ cwd, runner: observedRunner, mode });
    expect(installs).toBe(1);
    const records = (text: string) => new Map(Object.values(parseLockfile(text)).map(entry => [entry.resolution ?? '__metadata', entry]));
    expect(records(await readFile(join(cwd, 'yarn.lock'), 'utf8'))).toEqual(records(lastYarnLock.toString()));
    expect(report.changed).toBe(true);
    expect(report.yarnVersion).toBe(version);
    expect(parseLockfile(await readFile(join(cwd, 'yarn.lock'), 'utf8')).__metadata?.version).toBe(String(schema));
    const incompleteLegacy = workspace && schema < 8;
    const legacy3 = incompleteLegacy && schema !== 4;
    const expected = !workspace || schema === 4 ? ['1.1.18'] : legacy3 ? ['2.1.4'] : ['1.1.18', '2.1.4'];
    expect(report.changes.map(change => change.to)).toEqual(expected);
    expect(report.remaining).toHaveLength(legacy3 ? 5 : 0);
    expect(report.warnings).toHaveLength(incompleteLegacy ? 1 : 0);
    if (incompleteLegacy) expect(report.warnings[0]).toContain('brace-expansion');
    expect(await readFile(join(cwd, 'package.json'))).toEqual(original);
    expect((await stat(join(cwd, 'package.json'))).ino).toBe(originalStat.ino);
    if (workspace) expect(await readFile(join(cwd, 'packages/child/package.json'))).toEqual(child);
    if (mode) expect(await readFile(join(cwd, '.yarn/install-state.gz')).catch(() => undefined)).toEqual(state);
    if (mode && !preinstalled) expect(await readdir(cwd)).not.toContain('node_modules');
    else {
      const rootRequire = createRequire(join(cwd, 'package.json'));
      const minimatchRequire = createRequire(rootRequire.resolve('minimatch/package.json'));
      expect(minimatchRequire('brace-expansion/package.json').version).toBe(mode || legacy3 ? '1.1.11' : '1.1.18');
      if (workspace) {
        const childRequire = createRequire(join(cwd, 'packages/child/package.json'));
        const nestedRequire = createRequire(childRequire.resolve('minimatch'));
        expect(nestedRequire('brace-expansion/package.json').version).toBe(schema === 4 ? '2.0.1' : '2.1.4');
      }
    }
    expect(await readdir(cwd)).not.toContain('.yarn-berry-audit-fix.lock');
    expect((await readdir(cwd)).filter(name => name.endsWith('.backup'))).toEqual([]);
    if (workspace) expect((await readdir(join(cwd, 'packages/child'))).filter(name => name.endsWith('.backup'))).toEqual([]);
    const fixedLock = await readFile(join(cwd, 'yarn.lock'));
    const args = ['install', '--immutable', ...(version.startsWith('4.') ? ['--check-resolutions'] : [])];
    requireSuccess(await run(args), 'Immutable install after fix');
    expect(await readFile(join(cwd, 'yarn.lock'))).toEqual(fixedLock);
    const again = await fixAudit({ cwd, runner, mode });
    if (legacy3) {
      // Legacy audit exposed the other branch only after the first update.
      expect(again.changes.map(change => change.to)).toEqual(['1.1.18']);
      expect(again.remaining).toEqual([]);
      expect((await fixAudit({ cwd, runner, mode })).changed).toBe(false);
    } else {
      expect(again.changed).toBe(false);
      expect(again.before).toEqual([]);
      expect(await readFile(join(cwd, 'yarn.lock'))).toEqual(fixedLock);
    }
  });

  it('updates an existing PnP installation in default mode', async () => {
    const { cwd, runner, run } = await project('packasso', yarn);
    const config = join(cwd, '.yarnrc.yml');
    await writeFile(config, (await readFile(config, 'utf8')).replace('nodeLinker: node-modules', 'nodeLinker: pnp'));
    requireSuccess(await run(['install']), 'Prepare PnP installation');
    const check = ['node', '-e', 'const r=require("module").createRequire(require.resolve("minimatch")); console.log(r("brace-expansion/package.json").version)'];
    expect(requireSuccess(await run(check), 'Original PnP package').trim()).toBe('1.1.11');
    const report = await fixAudit({ cwd, runner });
    expect(report.changed).toBe(true);
    expect(requireSuccess(await run(check), 'Fixed PnP package').trim()).toBe('1.1.18');
    const lock = await readFile(join(cwd, 'yarn.lock'));
    requireSuccess(await run(['install', '--immutable']), 'Immutable PnP install');
    expect(await readFile(join(cwd, 'yarn.lock'))).toEqual(lock);
  });
});

it('installs the highest compatible fix when a lower stable fix also satisfies the initial audit', async () => {
  const { cwd, runner, run } = await project('packasso', 'yarn-4');
  let audits = 0;
  const initialAdvisory: Runner = (args, options) => {
    if (args[0] === 'npm' && args[1] === 'audit' && ++audits === 1) {
      // With this advisory both 1.1.12 and 1.1.18 qualify; the final audit still uses the full snapshot.
      return Promise.resolve({ code: 1, stdout: JSON.stringify({ 'brace-expansion': [{ id: 1, vulnerable_versions: '<1.1.12' }] }), stderr: '' });
    }
    return runner(args, options);
  };
  const report = await fixAudit({ cwd, runner: initialAdvisory, policy: 'highest' });
  expect(report.policy).toBe('highest');
  expect(report.changes.map(change => change.to)).toEqual(['1.1.18']);
  expect(report.remaining).toEqual([]);
  const require = createRequire(join(cwd, 'package.json'));
  expect(createRequire(require.resolve('minimatch'))('brace-expansion/package.json').version).toBe('1.1.18');
  requireSuccess(await run(['install', '--immutable', '--check-resolutions']), 'Immutable install after highest-policy fix');
});

it('repairs the second semver branch with Yarn 2 when its audit can represent it', async () => {
  const { cwd, runner, run } = await project('masker', 'pm-yarn-2', false, '^9.0.3');
  const report = await fixAudit({ cwd, runner });
  expect(report.changes.map(change => change.to)).toEqual(['2.1.4']);
  expect(report.remaining).toEqual([]);
  expect(report.warnings).toEqual([]);
  requireSuccess(await run(['install', '--immutable']), 'Yarn 2 immutable second branch');
});

it('rejects lockfile-only mode on real Yarn 2 before audit or any project writes', async () => {
  const { cwd, runner } = await project('packasso', 'pm-yarn-2');
  const paths = ['package.json', 'yarn.lock', '.yarnrc.yml'];
  const before = await Promise.all(paths.map(path => readFile(join(cwd, path))));
  const calls: string[][] = [];
  const observed: Runner = async (args, options) => { calls.push(args); return runner(args, options); };
  await expect(fixAudit({ cwd, runner: observed, mode: 'update-lockfile' })).rejects.toThrow('does not support --mode=update-lockfile');
  expect(calls).toEqual([['--version']]);
  expect(await Promise.all(paths.map(path => readFile(join(cwd, path))))).toEqual(before);
  expect((await readdir(cwd)).filter(name => name.endsWith('.backup') || name === '.yarn-berry-audit-fix.lock')).toEqual([]);
});

it('demonstrates that naive temporary resolutions lose original compatible descriptors', async () => {
  const { cwd, run } = await project('masker', 'yarn-4');
  const original = await readFile(join(cwd, 'package.json'));
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ ...JSON.parse(original.toString()), resolutions: { 'brace-expansion': '1.1.18' } }));
  requireSuccess(await run(['install', '--mode=update-lockfile']), 'Naive install');
  await writeFile(join(cwd, 'package.json'), original);
  const lock = descriptors(parseLockfile(await readFile(join(cwd, 'yarn.lock'), 'utf8')));
  expect(lock.has('brace-expansion@npm:^1.1.7')).toBe(false);
  const check = await run(['install', '--immutable']);
  expect(check.code).not.toBe(0);
  expect(check.stdout).toContain('YN0028');
});

it('keeps exact vulnerable pins unchanged and reports them', async () => {
  const { cwd, runner, run } = await project('masker', 'yarn-4');
  const manifest = { name: 'fixture', dependencies: { 'brace-expansion': '1.1.11' } };
  await writeFile(join(cwd, 'package.json'), JSON.stringify(manifest));
  requireSuccess(await run(['install', '--mode=update-lockfile']), 'Pinned fixture');
  const lock = await readFile(join(cwd, 'yarn.lock'));
  const result = await fixAudit({ cwd, runner });
  expect(result.changes).toEqual([]);
  expect(result.skipped).toHaveLength(1);
  expect(result.remaining.length).toBeGreaterThan(0);
  expect(await readFile(join(cwd, 'yarn.lock'))).toEqual(lock);
});

it.each(['install', 'audit'])('restores original files when the %s fails', async failedStage => {
  const { cwd, runner } = await project('masker', 'yarn-4', true);
  const paths = ['package.json', 'yarn.lock', '.yarnrc.yml', 'packages/child/package.json', '.yarn/install-state.gz'];
  const before = await Promise.all(paths.map(path => readFile(join(cwd, path)).catch(() => undefined)));
  const originalStat = await stat(join(cwd, 'package.json'));
  let audits = 0;
  const failing: Runner = async (args, options) => {
    if (args[0] === 'install' && failedStage === 'install') return { code: 1, stdout: 'simulated registry failure', stderr: '' };
    if (args[0] === 'npm' && args[1] === 'audit' && ++audits === 2 && failedStage === 'audit') {
      return { code: 2, stdout: '', stderr: 'simulated registry failure' };
    }
    return runner(args, options);
  };
  await expect(fixAudit({ cwd, runner: failing })).rejects.toThrow(failedStage === 'install' ? 'Temporary resolutions install failed' : 'Audit failed');
  const after = await Promise.all(paths.map(path => readFile(join(cwd, path)).catch(() => undefined)));
  expect(after).toEqual(before);
  expect((await stat(join(cwd, 'package.json'))).ino).toBe(originalStat.ino);
  expect((await readdir(cwd)).filter(name => name.endsWith('.backup'))).toEqual([]);
  expect((await readdir(join(cwd, 'packages/child'))).filter(name => name.endsWith('.backup'))).toEqual([]);
});

it('dry-run performs no project writes and returns both compatible branches', async () => {
  const { cwd, runner } = await project('masker', 'yarn-4', true);
  const before = await readFile(join(cwd, 'yarn.lock'));
  const manifest = await readFile(join(cwd, 'package.json'));
  const result = await fixAudit({ cwd, runner, dryRun: true });
  expect(result.changes).toHaveLength(2);
  expect(result.changed).toBe(false);
  expect(await readFile(join(cwd, 'yarn.lock'))).toEqual(before);
  expect(await readFile(join(cwd, 'package.json'))).toEqual(manifest);
  expect((await readdir(cwd)).filter(name => name.endsWith('.backup'))).toEqual([]);
});

it('rolls back if the final audit reports the selected version as vulnerable', async () => {
  const { cwd, runner } = await project('masker', 'yarn-4');
  const originalLock = await readFile(join(cwd, 'yarn.lock'));
  const originalManifest = await readFile(join(cwd, 'package.json'));
  let audits = 0;
  const newAdvisory: Runner = async (args, options) => {
    if (args[0] === 'npm' && args[1] === 'audit' && ++audits === 2) {
      return { code: 1, stdout: JSON.stringify({ value: 'brace-expansion', children: { ID: 9999999, 'Vulnerable Versions': '*' } }), stderr: '' };
    }
    return runner(args, options);
  };
  await expect(fixAudit({ cwd, runner: newAdvisory })).rejects.toThrow('Fix did not survive manifest restoration');
  expect(await readFile(join(cwd, 'yarn.lock'))).toEqual(originalLock);
  expect(await readFile(join(cwd, 'package.json'))).toEqual(originalManifest);
});

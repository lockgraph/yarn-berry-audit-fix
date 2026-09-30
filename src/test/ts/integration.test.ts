import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fixAudit, type InstallMode } from '../../main/ts/index.js';
import { descriptors, parseLockfile } from '../../main/ts/lockfile.js';
import { requireSuccess, type Runner } from '../../main/ts/yarn.js';
import { startRegistry } from './registry.js';
import { managers } from './pm.js';
import { prepareProject } from './project.js';

const require = createRequire(import.meta.url);
const networkFetch = globalThis.fetch;
beforeEach(() => vi.stubGlobal('fetch', (url: string, options: RequestInit) =>
  networkFetch(url.replace('https://registry.npmjs.org', registry.url), options)));
afterEach(() => vi.unstubAllGlobals());
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
  return prepareProject(cwd, registry.url, require.resolve(`${yarn}/bin/yarn.js`), { repo, workspace, rootRange });
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
      expect(await readFile(join(cwd, 'package.json'))).toEqual(original);
      expect(await readFile(join(cwd, backupName))).toEqual(original);
      expect((await stat(join(cwd, backupName))).ino).toBe(originalStat.ino);
      installs++;
      const output = await runner(args, options);
      lastYarnLock = await readFile(join(cwd, 'yarn.lock'));
      return output;
    };
    const report = await fixAudit({ cwd, runner: observedRunner, mode });
    expect(installs).toBe(1);
    // The complete lockfile is Yarn's output, including its original request headers.
    expect(await readFile(join(cwd, 'yarn.lock'))).toEqual(lastYarnLock);
    expect(report.changed).toBe(true);
    expect(report.yarnVersion).toBe(version);
    expect(parseLockfile(await readFile(join(cwd, 'yarn.lock'), 'utf8')).__metadata?.version).toBe(String(schema));
    const incompleteLegacy = workspace && schema < 8;
    const legacy3 = incompleteLegacy && schema !== 4;
    const expected = !workspace || schema === 4 ? ['1.1.18'] : legacy3 ? ['2.1.4'] : ['1.1.18', '2.1.4'];
    expect(report.changes.map(change => change.to)).toEqual(expected);
    expect(report.remaining).toEqual([]);
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
    if (incompleteLegacy) {
      // Legacy audit depends on traversal order; bulk must find the unreported branch.
      const complete = await fixAudit({ cwd, runner, mode, auditRegistry: registry.url });
      expect(complete.changes.map(change => change.to)).toEqual([legacy3 ? '1.1.18' : '2.1.4']);
      expect(complete.remaining).toEqual([]);
      expect((await fixAudit({ cwd, runner, mode, auditRegistry: registry.url })).changed).toBe(false);
    } else {
      const again = await fixAudit({ cwd, runner, mode });
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

  it('uses a separate audit registry without redirecting package metadata or downloads', async () => {
    const { cwd, runner, run } = await project('masker', yarn, true);
    const paths = ['package.json', 'yarn.lock', '.yarnrc.yml'];
    const original = await Promise.all(paths.map(path => readFile(join(cwd, path))));
    const audit = await startRegistry();
    const offset = registry.requests.length;
    const calls: string[][] = [];
    const observed: Runner = (args, options) => { calls.push(args); return runner(args, options); };
    try {
      const result = await fixAudit({ cwd, runner: observed, auditRegistry: audit.url });
      expect(result.changed).toBe(true);
      expect(result.before.length).toBeGreaterThan(0);
      expect(result.remaining).toEqual([]);
      expect(result.changes.map(change => change.to)).toEqual(['1.1.18', '2.1.4']);
      expect(result.warnings).toEqual([]);
      expect(calls.some(args => args[1] === 'audit')).toBe(false);
      const endpoint = '/-/npm/v1/security/advisories/bulk';
      expect(audit.requests).toEqual([endpoint, endpoint, endpoint]);
      const packageRequests = registry.requests.slice(offset);
      expect(packageRequests).toContain('/brace-expansion');
      expect(packageRequests.some(path => path.endsWith('.tgz'))).toBe(true);
      expect(packageRequests.some(path => path.startsWith('/-/npm/v1/security/'))).toBe(false);
      expect(await readFile(join(cwd, 'package.json'))).toEqual(original[0]);
      expect(await readFile(join(cwd, '.yarnrc.yml'))).toEqual(original[2]);
      const fixed = await readFile(join(cwd, 'yarn.lock'));
      requireSuccess(await run(['install', '--immutable']), 'Immutable install after direct bulk audit');
      expect(await readFile(join(cwd, 'yarn.lock'))).toEqual(fixed);
    } finally { await audit.close(); }
  });
});

it.each(['pm-yarn-2', 'pm-yarn-berry-v6', 'pm-yarn-berry-v10'])('falls back after native HTTP 400 and repairs both workspace branches with %s', async yarn => {
  const broken = await startRegistry({ rejectAudit: true });
  const audit = await startRegistry();
  const cwd = await mkdtemp(join(tmpdir(), 'berry-bulk-fallback-'));
  directories.push(cwd);
  const fetch = globalThis.fetch;
  const payloads: unknown[] = [];
  vi.stubGlobal('fetch', (url: string, options: RequestInit) => {
    expect(url).toBe('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk');
    payloads.push(JSON.parse(String(options.body)));
    return fetch(`${audit.url}/-/npm/v1/security/advisories/bulk`, options);
  });
  try {
    const { runner, run } = await prepareProject(cwd, broken.url, require.resolve(`${yarn}/bin/yarn.js`), { repo: 'masker', workspace: true });
    const paths = ['package.json', 'packages/child/package.json', '.yarnrc.yml'];
    const original = await Promise.all(paths.map(path => readFile(join(cwd, path))));
    const result = await fixAudit({ cwd, runner });
    expect(result.changes.map(change => change.to)).toEqual(['1.1.18', '2.1.4']);
    expect(result.remaining).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining('using bulk audit')]);
    expect(broken.requests.filter(path => path.startsWith('/-/npm/v1/security/'))).toHaveLength(1);
    expect(payloads).toHaveLength(3);
    expect(payloads[0]).toMatchObject({ 'brace-expansion': ['1.1.11', '2.0.1'] });
    expect(payloads[1]).toMatchObject({ 'brace-expansion': ['1.1.18', '2.1.4'] });
    expect(await Promise.all(paths.map(path => readFile(join(cwd, path))))).toEqual(original);
    const fixed = await readFile(join(cwd, 'yarn.lock'));
    requireSuccess(await run(['install', '--immutable']), 'Immutable install after bulk fallback');
    expect(await readFile(join(cwd, 'yarn.lock'))).toEqual(fixed);
  } finally { await Promise.all([broken.close(), audit.close()]); }
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
  const fetchFailure = vi.fn().mockResolvedValueOnce(new Response('{}')).mockRejectedValue(new Error('Bulk registry unavailable'));
  vi.stubGlobal('fetch', fetchFailure);
  await expect(fixAudit({ cwd, runner: failing })).rejects.toThrow(failedStage === 'install' ? 'Resolution aliases install failed' : 'Yarn audit and bulk fallback failed');
  expect(fetchFailure).toHaveBeenCalledTimes(failedStage === 'install' ? 1 : 2);
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
  await expect(fixAudit({ cwd, runner: newAdvisory })).rejects.toThrow('Fix did not produce a safe compatible resolution');
  expect(await readFile(join(cwd, 'yarn.lock'))).toEqual(originalLock);
  expect(await readFile(join(cwd, 'package.json'))).toEqual(originalManifest);
});

it.each(['pm-yarn-berry-v8', 'pm-yarn-berry-v9', 'pm-yarn-berry-v10'].flatMap(yarn =>
  [false, true].map(ordinary => ({ yarn, ordinary }))))('repairs default and named catalogs with $yarn (ordinary ranges=$ordinary)', async ({ yarn, ordinary }) => {
  const { cwd, runner, run } = await project('masker', yarn, true);
  const manifests = ['package.json', 'packages/child/package.json'];
  for (const [index, file] of manifests.entries()) {
    const path = join(cwd, file);
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    if (!ordinary) delete manifest.dependencies.minimatch;
    manifest.dependencies['brace-expansion'] = index ? 'catalog:modern' : 'catalog:';
    await writeFile(path, JSON.stringify(manifest));
  }
  const config = join(cwd, '.yarnrc.yml');
  await writeFile(config, await readFile(config, 'utf8') + '\ncatalog:\n  brace-expansion: ^1.1.7\ncatalogs:\n  modern:\n    brace-expansion: ^2.0.1\n');
  requireSuccess(await run(['install']), 'Prepare catalog dependencies');
  const paths = [...manifests, '.yarnrc.yml'];
  const original = await Promise.all(paths.map(path => readFile(join(cwd, path))));
  const report = await fixAudit({ cwd, runner });
  expect(report.changes.map(change => change.to)).toEqual(['1.1.18', '2.1.4']);
  expect(report.resolutions['brace-expansion@catalog:']).toBe('npm:1.1.18');
  expect(report.resolutions['brace-expansion@catalog:modern']).toBe('npm:2.1.4');
  expect(report.remaining).toEqual([]);
  expect(await Promise.all(paths.map(path => readFile(join(cwd, path))))).toEqual(original);
  const rootRequire = createRequire(join(cwd, 'package.json'));
  const childRequire = createRequire(join(cwd, 'packages/child/package.json'));
  expect(rootRequire('brace-expansion/package.json').version).toBe('1.1.18');
  expect(childRequire('brace-expansion/package.json').version).toBe('2.1.4');
  const fixed = await readFile(join(cwd, 'yarn.lock'));
  requireSuccess(await run(['install', '--immutable', '--check-resolutions']), 'Immutable catalog install');
  expect(await readFile(join(cwd, 'yarn.lock'))).toEqual(fixed);
  expect((await fixAudit({ cwd, runner })).changed).toBe(false);
});

it.each(['pm-yarn-2', 'pm-yarn-berry-v6', 'pm-yarn-berry-v10'])('rejects a newly vulnerable candidate before the only install with %s', async yarn => {
  const { cwd, runner, run } = await project('masker', yarn);
  const originalLock = await readFile(join(cwd, 'yarn.lock'));
  const originalManifest = await readFile(join(cwd, 'package.json'));
  let audits = 0;
  let installs = 0;
  const observed: Runner = async (args, options) => {
    if (args[1] === 'audit' && ++audits === 1) {
      return { code: 1, stdout: JSON.stringify({ 'brace-expansion': [{ id: 1, vulnerable_versions: '<1.1.12' }] }), stderr: '' };
    }
    if (args[0] === 'install') {
      installs++;
      expect(await readFile(join(cwd, 'package.json'))).toEqual(originalManifest);
      const plugin = await readFile(options.env.YARN_PLUGINS!, 'utf8');
      expect(plugin).toContain('"to":"1.1.18"');
      expect(plugin).not.toContain('"to":"1.1.12"');
    }
    return runner(args, options);
  };
  const payloads: unknown[] = [];
  vi.stubGlobal('fetch', async (url: string, options: RequestInit) => {
    expect(url).toBe('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk');
    expect(await readFile(join(cwd, 'yarn.lock'))).toEqual(originalLock);
    expect(await readFile(join(cwd, 'package.json'))).toEqual(originalManifest);
    payloads.push(JSON.parse(String(options.body)));
    return networkFetch(`${registry.url}/-/npm/v1/security/advisories/bulk`, options);
  });
  const report = await fixAudit({ cwd, runner: observed });
  expect(payloads).toEqual([{ 'brace-expansion': ['1.1.12'] }, { 'brace-expansion': ['1.1.18'] }]);
  expect(installs).toBe(1);
  expect(report.changes.map(change => change.to)).toEqual(['1.1.18']);
  expect(report.remaining).toEqual([]);
  requireSuccess(await run(['install', '--immutable']), 'Immutable install after candidate replanning');
});

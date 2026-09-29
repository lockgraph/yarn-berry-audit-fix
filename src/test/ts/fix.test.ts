import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringifySyml } from '@yarnpkg/parsers';
import { fixAudit } from '../../main/ts/index.js';
import type { Runner } from '../../main/ts/yarn.js';

const directories: string[] = [];
beforeEach(() => vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}'))));
const originalManifest = '{"name":"fixture","dependencies":{"foo":"^1"}}\n';
const originalLock = stringifySyml({
  __metadata: { version: '8' },
  'fixture@workspace:.': { resolution: 'fixture@workspace:.', dependencies: { foo: 'npm:^1' } },
  'foo@npm:^1': { version: '1.0.0', resolution: 'foo@npm:1.0.0' },
});
const success = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });

async function project() {
  const cwd = await mkdtemp(join(tmpdir(), 'berry-fix-errors-'));
  directories.push(cwd);
  await writeFile(join(cwd, 'package.json'), originalManifest);
  await writeFile(join(cwd, 'yarn.lock'), originalLock);
  // A command boundary double lets tests inject faults while exercising real file backup and rollback.
  const runner = vi.fn<Runner>(async args => {
    if (args[0] === '--version') return { code: 0, stdout: '4.18.1', stderr: '' };
    if (args[0] === 'config') return success('.yarn/install-state.gz');
    if (args[1] === 'audit') return { ...success({ foo: [{ id: 1, vulnerable_versions: '<1.2.3' }] }), code: 1 };
    if (args[1] === 'info') return success({ name: 'foo', versions: ['1.0.0', '1.2.3'] });
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  });
  return { cwd, runner };
}

async function expectRestored(cwd: string) {
  expect(await readFile(join(cwd, 'package.json'), 'utf8')).toBe(originalManifest);
  expect(await readFile(join(cwd, 'yarn.lock'), 'utf8')).toBe(originalLock);
  expect((await readdir(cwd)).filter(name => name.endsWith('.backup') || name === '.yarn-berry-audit-fix.lock')).toEqual([]);
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

it.each([null, [], { resolutions: [] }, { resolutions: { foo: 123 } }])('rejects invalid manifests before running Yarn: %j', async manifest => {
  const { cwd, runner } = await project();
  const text = JSON.stringify(manifest);
  await writeFile(join(cwd, 'package.json'), text);
  await expect(fixAudit({ cwd, runner })).rejects.toThrow('Invalid package.json');
  expect(runner).not.toHaveBeenCalled();
  expect(await readFile(join(cwd, 'package.json'), 'utf8')).toBe(text);
});

it.each(['package.json', 'yarn.lock'])('preserves concurrent edits to %s made during planning', async file => {
  const { cwd, runner } = await project();
  const delegate = runner.getMockImplementation()!;
  runner.mockImplementation(async (args, options) => {
    if (args[1] === 'info') await writeFile(join(cwd, file), 'Concurrent user edit');
    return delegate(args, options);
  });
  await expect(fixAudit({ cwd, runner })).rejects.toThrow('Project changed during planning');
  expect(await readFile(join(cwd, file), 'utf8')).toBe('Concurrent user edit');
  expect(runner.mock.calls.some(([args]) => args[0] === 'install')).toBe(false);
  expect(await readdir(cwd)).not.toContain('.yarn-berry-audit-fix.lock');
});

it.each([{}, { location: 123 }, { location: '../outside' }])('rejects malformed or escaping workspace locations: %j', async workspace => {
  const { cwd, runner } = await project();
  const manifest = JSON.stringify({ ...JSON.parse(originalManifest), workspaces: ['packages/*'] });
  await writeFile(join(cwd, 'package.json'), manifest);
  const delegate = runner.getMockImplementation()!;
  runner.mockImplementation((args, options) => args[0] === 'workspaces' ? Promise.resolve(success(workspace)) : delegate(args, options));
  await expect(fixAudit({ cwd, runner })).rejects.toThrow(/Invalid workspace response|outside the project root/);
  expect(await readFile(join(cwd, 'package.json'), 'utf8')).toBe(manifest);
  expect(await readdir(cwd)).not.toContain('.yarn-berry-audit-fix.lock');
});

it('does not treat unreadable Yarn configuration as a missing file', async () => {
  const { cwd, runner } = await project();
  await mkdir(join(cwd, '.yarnrc.yml'));
  await expect(fixAudit({ cwd, runner })).rejects.toMatchObject({ code: 'EISDIR' });
  await expectRestored(cwd);
});

it('rejects invalid install state locations before replacing manifests', async () => {
  const { cwd, runner } = await project();
  const delegate = runner.getMockImplementation()!;
  runner.mockImplementation((args, options) => args[0] === 'config' ? Promise.resolve(success(null)) : delegate(args, options));
  await expect(fixAudit({ cwd, runner })).rejects.toThrow('Invalid installStatePath');
  await expectRestored(cwd);
});

it('honors an abort before starting the temporary install and releases the project guard', async () => {
  const { cwd, runner } = await project();
  const controller = new AbortController();
  const failure = new Error('Cancelled by user');
  controller.abort(failure);
  await expect(fixAudit({ cwd, runner, signal: controller.signal })).rejects.toBe(failure);
  expect(runner.mock.calls.some(([args]) => args[0] === 'install')).toBe(false);
  await expectRestored(cwd);
});

it('reports both the install failure and rollback errors while restoring other files', async () => {
  const { cwd, runner } = await project();
  const delegate = runner.getMockImplementation()!;
  const config = join(cwd, '.yarnrc.yml');
  await writeFile(config, 'enableScripts: false\n');
  runner.mockImplementation(async (args, options) => {
    if (args[0] !== 'install') return delegate(args, options);
    await rm(config);
    await mkdir(config);
    await writeFile(join(cwd, 'yarn.lock'), 'Partially written lockfile');
    return { code: 2, stdout: '', stderr: 'Install failed' };
  });
  const failure: unknown = await fixAudit({ cwd, runner }).catch(error => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure).toMatchObject({
    message: 'Fix failed and rollback was incomplete',
    errors: [{ message: expect.stringContaining('Install failed') }, { errors: [{ code: 'EISDIR' }] }],
  });
  await expectRestored(cwd);
});

it.each([false, true])('leaves every file untouched when candidate audit fails (dryRun=%s)', async dryRun => {
  const { cwd, runner } = await project();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Candidate audit unavailable')));
  await expect(fixAudit({ cwd, runner, dryRun })).rejects.toThrow('Candidate audit unavailable');
  expect(runner.mock.calls.some(([args]) => args[0] === 'install' || args[0] === 'config')).toBe(false);
  await expectRestored(cwd);
});

it('honors cancellation during candidate auditing before creating backups or running an install', async () => {
  const { cwd, runner } = await project();
  const controller = new AbortController();
  const error = new Error('Cancelled candidate audit');
  vi.stubGlobal('fetch', (_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
    options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
    controller.abort(error);
  }));
  await expect(fixAudit({ cwd, runner, signal: controller.signal })).rejects.toBe(error);
  expect(runner.mock.calls.some(([args]) => args[0] === 'install')).toBe(false);
  await expectRestored(cwd);
});

it('returns an audited dry-run plan after discovering a vulnerability in the first candidate', async () => {
  const { cwd, runner } = await project();
  const delegate = runner.getMockImplementation()!;
  runner.mockImplementation((args, options) => args[1] === 'info'
    ? Promise.resolve(success({ name: 'foo', versions: ['1.0.0', '1.2.3', '1.2.4'] })) : delegate(args, options));
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ foo: [{ id: 2, vulnerable_versions: '1.2.3' }] })))
    .mockResolvedValueOnce(new Response('{}'));
  vi.stubGlobal('fetch', fetch);
  const result = await fixAudit({ cwd, runner, dryRun: true });
  expect(result.changes.map(change => change.to)).toEqual(['1.2.4']);
  expect(result.before).toHaveLength(1);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(runner.mock.calls.some(([args]) => args[0] === 'install')).toBe(false);
  await expectRestored(cwd);
});

it.each([0, 1])('rejects incomplete batched metadata before any project writes (exit code %s)', async code => {
  const { cwd, runner } = await project();
  const delegate = runner.getMockImplementation()!;
  runner.mockImplementation((args, options) => {
    if (args[1] === 'audit') return Promise.resolve(success({
      foo: [{ id: 1, vulnerable_versions: '<1.2.3' }],
      '@scope/bar': [{ id: 2, vulnerable_versions: '<1.2.3' }],
    }));
    if (args[1] === 'info') return Promise.resolve({ ...success({ name: 'foo', versions: ['1.0.0', '1.2.3'] }), code });
    return delegate(args, options);
  });
  await expect(fixAudit({ cwd, runner })).rejects.toThrow(code ? 'Package metadata failed' : 'No published versions returned for @scope/bar');
  const calls = runner.mock.calls.map(([args]) => args);
  expect(calls.filter(args => args[1] === 'info')).toEqual([
    ['npm', 'info', '--fields', 'name,versions', '--json', '--', 'foo', '@scope/bar'],
  ]);
  expect(calls.some(args => args[0] === 'install')).toBe(false);
  expect(globalThis.fetch).not.toHaveBeenCalled();
  await expectRestored(cwd);
});

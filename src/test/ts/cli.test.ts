import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { createRunner, fixAudit, type FixResult } from '../../main/ts/index.js';

vi.mock('../../main/ts/index.js', () => ({ createRunner: vi.fn(), fixAudit: vi.fn() }));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
const signals = ['SIGINT', 'SIGTERM'] as const;
let listeners: NodeJS.SignalsListener[][];
const advisory = { id: '1', name: 'foo', vulnerable: '<1.2.3' };
const change = { name: 'foo', descriptor: 'foo@npm:^1', from: '1.0.0', to: '1.2.3' };
const report = (overrides: Partial<FixResult> = {}): FixResult => ({
  changes: [], skipped: [], resolutions: {}, policy: 'lowest', yarnVersion: '4.18.1',
  changed: false, dryRun: false, before: [], remaining: [], warnings: [], ...overrides,
});

beforeEach(() => {
  vi.resetModules();
  vi.mocked(fixAudit).mockReset().mockResolvedValue(report());
  vi.mocked(createRunner).mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = undefined;
  listeners = signals.map(signal => process.listeners(signal));
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  signals.forEach((signal, index) => expect(process.listeners(signal)).toEqual(listeners[index]));
});

async function run(...args: string[]) {
  process.argv = [process.execPath, 'yarn-berry-audit-fix', ...args];
  await import('../../main/ts/cli.js');
}

it.each(['--help', '-h'])('shows %s without inspecting or changing a project', async flag => {
  await run(flag);
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining('--policy=lowest|highest'));
  expect(fixAudit).not.toHaveBeenCalled();
  expect(process.exitCode).toBeUndefined();
});

it.each(['--mode=unknown', '--policy=unknown', '--unknown', '--cwd'])('rejects invalid arguments: %s', async flag => {
  await run(flag);
  expect(fixAudit).not.toHaveBeenCalled();
  expect(console.error).toHaveBeenCalledWith(expect.any(String));
  expect(process.exitCode).toBe(2);
});

it('prints a clean result and uses the default runner and update policy', async () => {
  await run();
  expect(fixAudit).toHaveBeenCalledWith(expect.objectContaining({ policy: 'lowest', runner: undefined }));
  expect(createRunner).not.toHaveBeenCalled();
  expect(console.log).toHaveBeenCalledExactlyOnceWith('0 advisory record(s) remaining.');
  expect(process.exitCode).toBe(0);
});

it('passes options to the fixer and keeps progress and warnings out of JSON output', async () => {
  const result = report({ policy: 'highest', dryRun: true, changes: [change], before: [advisory], remaining: [advisory], warnings: ['Legacy audit is incomplete'] });
  const runner = vi.fn();
  vi.mocked(createRunner).mockReturnValue(runner);
  vi.mocked(fixAudit).mockImplementation(async options => {
    options?.onProgress?.('Auditing');
    return result;
  });
  await run('--cwd', 'project', '--yarn-path', 'yarn.cjs', '--dry-run', '--mode=update-lockfile', '--policy=highest', '--json');
  expect(createRunner).toHaveBeenCalledWith([process.execPath, resolve('yarn.cjs')]);
  expect(fixAudit).toHaveBeenCalledWith(expect.objectContaining({ cwd: 'project', runner, dryRun: true, mode: 'update-lockfile', policy: 'highest' }));
  expect(console.log).toHaveBeenCalledExactlyOnceWith(JSON.stringify(result, null, 2));
  expect(console.error).toHaveBeenCalledWith('Auditing');
  expect(console.error).toHaveBeenCalledWith('Warning: Legacy audit is incomplete');
  expect(process.exitCode).toBe(0);
});

it('describes proposed fixes without failing a dry run that still has advisories', async () => {
  vi.mocked(fixAudit).mockResolvedValue(report({ dryRun: true, changes: [change], remaining: [advisory] }));
  await run('--dry-run');
  expect(console.log).toHaveBeenCalledWith('Would fix foo@npm:^1: 1.0.0 -> 1.2.3');
  expect(console.log).toHaveBeenCalledWith('1 advisory record(s) in the initial audit.');
  expect(process.exitCode).toBe(0);
});

it('reports installed fixes, removed dependencies and skipped requests with a nonzero result for remaining advisories', async () => {
  vi.mocked(fixAudit).mockResolvedValue(report({ changed: true, changes: [change, { ...change, descriptor: 'foo@npm:~1', removed: true }],
    skipped: [{ name: 'foo', descriptor: 'foo@npm:1.0.0', version: '1.0.0', reason: 'Exact pin' }], remaining: [advisory] }));
  await run('--mode=update-lockfile');
  expect(console.log).toHaveBeenCalledWith('Fixed foo@npm:^1: 1.0.0 -> 1.2.3');
  expect(console.log).toHaveBeenCalledWith('Fixed foo@npm:~1: 1.0.0 -> removed from graph');
  expect(console.log).toHaveBeenCalledWith('Skipped foo@npm:1.0.0: Exact pin');
  expect(console.log).toHaveBeenCalledWith('package.json restored; run yarn install to update the installed tree.');
  expect(process.exitCode).toBe(1);
});

it.each([new Error('Registry unavailable'), 'Registry unavailable'])('reports operational failures: %s', async failure => {
  vi.mocked(fixAudit).mockRejectedValue(failure);
  await run();
  expect(console.error).toHaveBeenCalledExactlyOnceWith('Registry unavailable');
  expect(process.exitCode).toBe(2);
});

it.each(signals)('aborts the fixer on %s and removes its signal handlers', async signal => {
  vi.mocked(fixAudit).mockImplementation(async options => {
    process.emit(signal);
    expect(options?.signal?.aborted).toBe(true);
    throw options?.signal?.reason;
  });
  await run();
  expect(console.error).toHaveBeenCalledExactlyOnceWith('Interrupted');
  expect(process.exitCode).toBe(130);
});

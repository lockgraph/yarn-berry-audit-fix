import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { createRunner, fixAudit, type FixResult } from '../../main/ts/index.js';

vi.mock('../../main/ts/index.js', () => ({ createRunner: vi.fn(), fixAudit: vi.fn() }));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
const signals = ['SIGINT', 'SIGTERM'] as const;
let listeners: NodeJS.SignalsListener[][];
let warningListeners: NodeJS.WarningListener[];
const advisory = { id: '1', name: 'foo', vulnerable: '<1.2.3' };
const change = { name: 'foo', descriptor: 'foo@npm:^1', from: '1.0.0', to: '1.2.3', advisories: [] };
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
  warningListeners = process.listeners('warning');
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  signals.forEach((signal, index) => expect(process.listeners(signal)).toEqual(listeners[index]));
  expect(process.listeners('warning')).toEqual(warningListeners);
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

it.each(['--mode=unknown', '--policy=unknown', '--unknown', '--cwd', '--audit-registry'])('rejects invalid arguments: %s', async flag => {
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
  await run('--cwd', 'project', '--yarn-path', 'yarn.cjs', '--dry-run', '--mode=update-lockfile', '--policy=highest', '--audit-registry', 'https://audit.example.org', '--json');
  expect(createRunner).toHaveBeenCalledWith([process.execPath, resolve('yarn.cjs')]);
  expect(fixAudit).toHaveBeenCalledWith(expect.objectContaining({ cwd: 'project', runner, dryRun: true, mode: 'update-lockfile', policy: 'highest', auditRegistry: 'https://audit.example.org' }));
  expect(console.log).toHaveBeenCalledOnce();
  const json = JSON.parse(vi.mocked(console.log).mock.calls[0]![0]);
  expect(json).toMatchObject({ ...result, status: 'dry-run', summary: { applied: 0, planned: 1 } });
  expect(json.meta).toEqual({ schemaVersion: 1, toolVersion: expect.any(String), generatedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/) });
  expect(console.error).toHaveBeenCalledWith('Auditing');
  expect(console.error).toHaveBeenCalledWith('Warning: Legacy audit is incomplete');
  expect(process.exitCode).toBe(0);
});

it('describes proposed fixes without failing a dry run that still has advisories', async () => {
  vi.mocked(fixAudit).mockResolvedValue(report({ dryRun: true, changes: [change], before: [advisory], remaining: [advisory] }));
  await run('--dry-run');
  expect(console.log).toHaveBeenCalledWith('Dry run: 1 planned fix(es) across 1 package(s); 0 skipped request(s). No files changed.');
  expect(console.log).toHaveBeenCalledWith('Would fix foo@npm:^1: 1.0.0 -> 1.2.3');
  expect(console.log).toHaveBeenCalledWith('1 advisory record(s) in the initial audit.');
  expect(process.exitCode).toBe(0);
});

it('counts dependency requests separately from package names in the dry-run digest', async () => {
  vi.mocked(fixAudit).mockResolvedValue(report({ dryRun: true,
    changes: [change, { ...change, descriptor: 'foo@npm:~1.0.0' }],
    skipped: [{ name: 'foo', descriptor: 'foo@npm:1.0.0', version: '1.0.0', reason: 'Exact pin' }],
    before: [advisory], remaining: [advisory],
  }));
  await run('--dry-run', '--mode=update-lockfile');
  expect(console.log).toHaveBeenCalledWith('Dry run: 2 planned fix(es) across 1 package(s); 1 skipped request(s). No files changed.');
  expect(console.log).toHaveBeenCalledWith('Skipped foo@npm:1.0.0: Exact pin');
  expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('run yarn install'));
});

it.each([{ before: [] }, { before: [advisory] }])('shows a dry-run digest even when no fixes are possible: $before', async ({ before }) => {
  vi.mocked(fixAudit).mockResolvedValue(report({ dryRun: true, before, remaining: before }));
  await run('--dry-run');
  expect(console.log).toHaveBeenCalledWith('Dry run: 0 planned fix(es) across 0 package(s); 0 skipped request(s). No files changed.');
  expect(console.log).toHaveBeenCalledWith(`${before.length} advisory record(s) in the initial audit.`);
  expect(process.exitCode).toBe(0);
});

it.each(['--help', '-h', '--version', '-v'])('silences %s without inspecting a project', async flag => {
  await run(flag, '--silent');
  expect(fixAudit).not.toHaveBeenCalled();
  expect(console.log).not.toHaveBeenCalled();
  expect(console.error).not.toHaveBeenCalled();
  expect(process.exitCode).toBeUndefined();
});

it.each([
  { args: [], remaining: [], code: 0 },
  { args: [], remaining: [advisory], code: 1 },
  { args: ['--json'], remaining: [advisory], code: 1 },
  { args: ['--ignore-unfixed'], remaining: [advisory], code: 0 },
  { args: ['--dry-run'], remaining: [advisory], code: 0 },
  { args: ['--dry-run', '--json'], remaining: [advisory], code: 0 },
])('silences results, progress and warnings while preserving exit code $code: $args', async ({ args, remaining, code }) => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  vi.mocked(fixAudit).mockImplementation(async options => {
    options?.onProgress?.('Auditing');
    process.emit('warning', new Error('Runtime warning'));
    return report({ dryRun: !!options?.dryRun, remaining, warnings: ['Audit warning'],
      changes: [{ ...change, advisories: [{ ...advisory, ghsaId: 'GHSA-v6h2-p8h4-qcjw' }] }],
    });
  });
  await run('--silent', ...args);
  expect(fixAudit).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
  expect(console.log).not.toHaveBeenCalled();
  expect(console.error).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(code);
});

it.each([
  ['--unknown', '--silent'], ['--silent', '--unknown'], ['--silent', '--cwd'],
  ['--silent', '--mode=unknown'], ['--silent', '--policy=unknown'], ['--silent', '--audit-registry=not-a-url'],
])('fails quietly on invalid arguments: %j', async (...args) => {
  await run(...args);
  expect(fixAudit).not.toHaveBeenCalled();
  expect(console.log).not.toHaveBeenCalled();
  expect(console.error).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(2);
});

it.each([undefined, 'SIGINT', 'SIGTERM'] as const)('fails quietly on execution errors and interruption: %s', async signal => {
  vi.mocked(fixAudit).mockImplementation(async options => {
    if (signal) process.emit(signal);
    throw options?.signal?.reason ?? new Error('Install failed');
  });
  await run('--silent', '--ignore-unfixed');
  expect(console.log).not.toHaveBeenCalled();
  expect(console.error).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(signal ? 130 : 2);
});

it('does not treat a string option value as the silent flag', async () => {
  await run('--cwd=--silent');
  expect(console.log).toHaveBeenCalled();
  expect(fixAudit).toHaveBeenCalledWith(expect.objectContaining({ cwd: '--silent' }));
});

it('does not treat a positional argument after -- as the silent flag', async () => {
  await run('--', '--silent');
  expect(console.error).toHaveBeenCalled();
  expect(process.exitCode).toBe(2);
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

it.each(['--version', '-v'])('prints the installed version with %s without accessing the target project', async flag => {
  const { readFile } = await import('node:fs/promises');
  const { version } = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'));
  await run(flag, '--cwd', '/missing-project');
  expect(console.log).toHaveBeenCalledExactlyOnceWith(version);
  expect(fixAudit).not.toHaveBeenCalled();
  expect(process.exitCode).toBeUndefined();
});

it.each([false, true])('keeps remaining advisories visible but exits successfully with --ignore-unfixed (json=%s)', async json => {
  const result = report({ remaining: [advisory], skipped: [{ name: 'foo', descriptor: 'foo@npm:1.0.0', version: '1.0.0', reason: 'Exact pin' }] });
  vi.mocked(fixAudit).mockResolvedValue(result);
  await run('--ignore-unfixed', ...(json ? ['--json'] : []));
  if (json) expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0])).toMatchObject({ ...result, status: 'unfixed' });
  else expect(console.log).toHaveBeenCalledWith('1 advisory record(s) remaining.');
  expect(process.exitCode).toBe(0);
});

it('never suppresses execution failures or invalid options with --ignore-unfixed', async () => {
  vi.mocked(fixAudit).mockRejectedValue(new Error('Install failed'));
  await run('--ignore-unfixed');
  expect(console.error).toHaveBeenCalledWith('Install failed');
  expect(process.exitCode).toBe(2);
});

it('never suppresses interruption with --ignore-unfixed', async () => {
  vi.mocked(fixAudit).mockImplementation(async options => {
    process.emit('SIGINT');
    throw options?.signal?.reason;
  });
  await run('--ignore-unfixed');
  expect(process.exitCode).toBe(130);
});

it('prints CVEs and CVSS scores under their applied bump', async () => {
  const affected = { ...advisory, cves: ['CVE-2025-5889'], cvss: { score: 3.1 } };
  vi.mocked(fixAudit).mockResolvedValue(report({ changes: [{ ...change, advisories: [affected] }] }));
  await run();
  expect(console.log).toHaveBeenCalledWith('Fixed foo@npm:^1: 1.0.0 -> 1.2.3');
  expect(console.log).toHaveBeenCalledWith('  CVE-2025-5889 (CVSS 3.1)');
});

it('does not contact GitHub when using a custom audit registry', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  vi.mocked(fixAudit).mockResolvedValue(report({ changes: [{ ...change, advisories: [{ ...advisory, ghsaId: 'GHSA-v6h2-p8h4-qcjw' }] }] }));
  await run('--audit-registry=https://audit.example.org');
  expect(fetch).not.toHaveBeenCalled();
  expect(console.log).toHaveBeenCalledWith('  GHSA-v6h2-p8h4-qcjw');
});

it('includes supplementary CVE metadata in JSON while reporting display lookup failures as warnings', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Unavailable', { status: 503 }));
  vi.mocked(fixAudit).mockResolvedValue(report({ changes: [{ ...change, advisories: [{ ...advisory, ghsaId: 'GHSA-v6h2-p8h4-qcjw' }] }] }));
  await run('--json');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Some CVE/CVSS details could not be loaded'));
  expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0]).changes[0].advisories[0].ghsaId).toBe('GHSA-v6h2-p8h4-qcjw');
  expect(process.exitCode).toBe(0);
});

it('includes JSON metadata and resolved CVEs using a custom registry without public metadata requests', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const affected = { ...advisory, cves: ['CVE-2025-5889'], cvss: { score: 3.1 } };
  vi.mocked(fixAudit).mockResolvedValue(report({ changed: true, before: [affected], changes: [{ ...change, advisories: [affected] }] }));
  await run('--json', '--audit-registry=https://audit.example.org');
  expect(fetch).not.toHaveBeenCalled();
  expect(console.log).toHaveBeenCalledOnce();
  expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0])).toMatchObject({
    status: 'clean', summary: { applied: 1 }, resolved: [affected], cves: { resolved: ['CVE-2025-5889'], complete: true },
  });
});

it.each([['--unknown', '--json'], ['--json', '--policy=unknown']])('returns a machine-readable argument error: %j', async (...args) => {
  await run(...args);
  expect(console.log).toHaveBeenCalledOnce();
  expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0])).toMatchObject({ meta: { schemaVersion: 1 }, status: 'error', error: { message: expect.any(String) } });
  expect(console.error).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(2);
});

it.each([undefined, 'SIGINT'] as const)('returns a machine-readable operational failure or interruption: %s', async signal => {
  vi.mocked(fixAudit).mockImplementation(async options => {
    if (signal) process.emit(signal);
    throw options?.signal?.reason ?? new Error('Install failed');
  });
  await run('--json', '--ignore-unfixed');
  expect(console.log).toHaveBeenCalledOnce();
  expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0])).toMatchObject({
    meta: { schemaVersion: 1 }, status: signal ? 'interrupted' : 'error', error: { message: signal ? 'Interrupted' : 'Install failed' },
  });
  expect(console.error).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(signal ? 130 : 2);
});

it('silences JSON errors without changing their exit status', async () => {
  await run('--json', '--unknown', '--silent');
  expect(console.log).not.toHaveBeenCalled();
  expect(console.error).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(2);
});

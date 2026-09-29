import { afterEach, describe, expect, it, vi } from 'vitest';
import { bulkAudit, bulkPackages, publicAuditRegistry } from '../../main/ts/bulk.js';
import { createAuditor } from '../../main/ts/auditor.js';
import type { Lockfile } from '../../main/ts/lockfile.js';

const lock: Lockfile = {
  __metadata: {},
  'foo@npm:^1': { version: '1.0.0', resolution: 'foo@npm:1.0.0' },
  'foo@npm:^2': { version: '2.0.0', resolution: 'foo@npm:2.0.0' },
};
const failure = { code: 1, stdout: 'YN0035: Bad Request (400)', stderr: '' };
const advisory = { id: 1, vulnerable_versions: '<1.1.0' };
const response = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('bulk inventory', () => {
  it('deduplicates versions by resolved identity, including scopes, aliases, patches and virtual packages', () => {
    const packages = bulkPackages({
      ...lock,
      'alias@npm:foo@^1': lock['foo@npm:^1']!,
      'scoped@npm:@scope/pkg@^1': { version: '1.0.0', resolution: '@scope/pkg@npm:1.0.0::__archiveUrl=https%3A%2F%2Fexample.org' },
      patch: { version: '3.0.0', resolution: 'foo@patch:foo@npm%3A3.0.0#optional!builtin<compat/foo>::version=3.0.0&hash=123' },
      virtual: { version: '4.0.0', resolution: 'foo@virtual:abcd#patch:foo@npm%3A4.0.0#./fix.patch::version=4.0.0' },
      virtualScoped: { version: '2.0.0', resolution: '@scope/pkg@virtual:abcd#npm:2.0.0' },
      workspace: { version: '0.0.0-use.local', resolution: 'root@workspace:.' },
      git: { version: '1.0.0', resolution: 'other@https://github.com/example/other.git#commit=123' },
      patchedGit: { version: '1.0.0', resolution: 'other@patch:other@https%3A%2F%2Fgithub.com%2Fexample%2Fother.git%23commit=123#./fix.patch' },
    });
    expect(packages).toEqual({ foo: ['1.0.0', '2.0.0', '3.0.0', '4.0.0'], '@scope/pkg': ['1.0.0', '2.0.0'] });
  });
  it.each([undefined, 'not-a-version'])('rejects invalid npm versions instead of silently omitting them: %s', version => {
    expect(() => bulkPackages({ foo: { resolution: 'foo@npm:1.0.0', version } })).toThrow('Invalid npm package version');
  });
  it('rejects malformed patches and excessively nested locators', () => {
    expect(() => bulkPackages({ foo: { version: '1.0.0', resolution: 'foo@patch:%xx#./a.patch' } })).toThrow(URIError);
    expect(() => bulkPackages({ foo: { version: '1.0.0', resolution: `foo@${'virtual:abcd#'.repeat(21)}npm:1.0.0` } })).toThrow('Too many nested');
  });
});

describe('bulk transport', () => {
  it('posts all locked versions to a base path and parses npm advisories', async () => {
    const fetch = vi.fn().mockImplementation(() => response({ foo: [advisory] }));
    vi.stubGlobal('fetch', fetch);
    expect(await bulkAudit(lock, 'https://example.org/npm')).toEqual([{ id: '1', name: 'foo', vulnerable: '<1.1.0' }]);
    expect(fetch).toHaveBeenCalledWith('https://example.org/npm/-/npm/v1/security/advisories/bulk', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ foo: ['1.0.0', '2.0.0'] }), redirect: 'error',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
    }));
  });
  it('does not contact a registry for a workspace-only project', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await bulkAudit({ __metadata: {}, root: { resolution: 'root@workspace:.' } }, publicAuditRegistry)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([[], null, { advisories: {} }, { type: 'info', data: 'clean' }, { foo: [{}] }])('rejects a malformed successful response: %j', async body => {
    vi.stubGlobal('fetch', () => response(body));
    await expect(bulkAudit(lock, publicAuditRegistry)).rejects.toThrow(/Invalid/);
  });
  it.each(['', 'not json'])('rejects an empty or non-JSON response: %j', async text => {
    vi.stubGlobal('fetch', async () => new Response(text));
    await expect(bulkAudit(lock, publicAuditRegistry)).rejects.toThrow(SyntaxError);
  });
  it('retains registry diagnostics on HTTP errors', async () => {
    vi.stubGlobal('fetch', async () => new Response('Service unavailable', { status: 503 }));
    await expect(bulkAudit(lock, publicAuditRegistry)).rejects.toThrow('HTTP 503): Service unavailable');
  });
  it('cancels an in-flight request and removes the caller abort listener', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    vi.stubGlobal('fetch', (_url: string, { signal }: RequestInit) => new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason));
    }));
    const pending = bulkAudit(lock, publicAuditRegistry, controller.signal);
    const reason = new Error('Cancelled');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    await expect(bulkAudit(lock, publicAuditRegistry, controller.signal)).rejects.toBe(reason);
  });
  it('times out a stalled request without requiring newer Node signal APIs', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', (_url: string, { signal }: RequestInit) => new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason));
    }));
    const pending = expect(bulkAudit(lock, publicAuditRegistry)).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('native audit fallback', () => {
  it('uses bulk after HTTP 400 and reads the repaired graph without retrying native audit', async () => {
    const run = vi.fn().mockResolvedValue(failure);
    const progress = vi.fn();
    const fetch = vi.fn().mockImplementation(() => response({}));
    vi.stubGlobal('fetch', fetch);
    const auditor = createAuditor({ run, yarnVersion: '3.8.7', major: 3, onProgress: progress });
    expect(await auditor.read(lock)).toEqual([]);
    await auditor.read({ ...lock, 'foo@npm:^1': { version: '1.1.0', resolution: 'foo@npm:1.1.0' } });
    expect(run).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({ foo: ['1.1.0', '2.0.0'] });
    expect(auditor.warnings).toEqual([expect.stringContaining('using bulk audit')]);
    expect(progress).toHaveBeenCalledWith(auditor.warnings[0]);
  });
  it('bypasses native audit with an explicit registry even on Yarn 2', async () => {
    const run = vi.fn();
    vi.stubGlobal('fetch', () => response({}));
    const auditor = createAuditor({ run, yarnVersion: '2.4.3', major: 2, registry: 'https://audit.example.org' });
    await auditor.read(lock);
    expect(run).not.toHaveBeenCalled();
    expect(auditor.warnings).toEqual([]);
  });
  it('keeps native audit and reports its multi-version limitation once', async () => {
    const run = vi.fn().mockResolvedValue({ code: 1, stdout: JSON.stringify({ foo: [advisory] }), stderr: '' });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const auditor = createAuditor({ run, yarnVersion: '3.8.7', major: 3 });
    await auditor.read(lock);
    await auditor.read(lock);
    expect(fetch).not.toHaveBeenCalled();
    expect(auditor.warnings).toEqual([expect.stringContaining('only one version')]);
  });
  it('retains both errors if the native audit and fallback fail', async () => {
    vi.stubGlobal('fetch', async () => new Response('Denied', { status: 403 }));
    const auditor = createAuditor({ run: async () => failure, yarnVersion: '3.8.7', major: 3 });
    await expect(auditor.read(lock)).rejects.toMatchObject({
      message: expect.stringContaining('Yarn audit and bulk fallback failed'),
      errors: [{ message: expect.stringContaining('Bad Request (400)') }, { message: expect.stringContaining('HTTP 403') }],
    });
  });
  it('never falls back after a caller cancellation', async () => {
    const controller = new AbortController();
    const reason = new Error('Cancelled by caller');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const auditor = createAuditor({
      run: async () => { controller.abort(reason); throw reason; },
      yarnVersion: '4.18.1', major: 4, signal: controller.signal,
    });
    await expect(auditor.read(lock)).rejects.toBe(reason);
    expect(fetch).not.toHaveBeenCalled();
  });
});

import { afterEach, expect, it, vi } from 'vitest';
import { enrichChanges } from '../../main/ts/advisory-enrichment.js';
import type { ReportedChange } from '../../main/ts/report.js';

const ghsaId = 'GHSA-v6h2-p8h4-qcjw';
const change: ReportedChange = { name: 'foo', descriptor: 'foo@npm:^1', from: '1.0.0', to: '1.1.0', advisories: [{ id: '1', name: 'foo', vulnerable: '<1.1.0', ghsaId }] };
const response = { ghsa_id: ghsaId, cve_id: 'CVE-2025-5889', cvss: { score: 3.1 } };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('looks up each GHSA once, shares metadata across descriptors, and preserves the original report', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(response)));
  vi.stubGlobal('fetch', fetch);
  const warnings: string[] = [];
  const result = await enrichChanges([change, { ...change, descriptor: 'foo@npm:~1' }], warnings);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith(`https://api.github.com/advisories/${ghsaId}`, expect.objectContaining({ redirect: 'error' }));
  expect(result.map(item => item.advisories[0])).toEqual(Array(2).fill({ ...change.advisories[0], cves: ['CVE-2025-5889'], cvss: { score: 3.1 } }));
  expect(change.advisories[0]?.cves).toBeUndefined();
  expect(warnings).toEqual([]);
});

it('keeps existing scores and skips complete metadata or findings with no GHSA', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(response)));
  vi.stubGlobal('fetch', fetch);
  const complete = { ...change, advisories: [{ ...change.advisories[0]!, cves: [], cvss: { score: 0 } }] };
  expect(await enrichChanges([complete, { ...change, advisories: [{ id: '2', name: 'foo', vulnerable: '*' }] }], [])).toHaveLength(2);
  expect(fetch).not.toHaveBeenCalled();
  const result = await enrichChanges([{ ...change, advisories: [{ ...change.advisories[0]!, cvss: { score: 7.5 } }] }], []);
  expect(result[0]?.advisories[0]?.cvss).toEqual({ score: 7.5 });
});

it.each([403, 429, 503])('stops taking queued lookups on HTTP %s without failing the repair', async status => {
  const fetch = vi.fn().mockImplementation(async () => new Response('Unavailable', { status }));
  vi.stubGlobal('fetch', fetch);
  const many = Array.from({ length: 12 }, (_, index) => ({ ...change, advisories: [{ ...change.advisories[0]!, ghsaId: `GHSA-v6h2-p8h4-qc${index}` }] }));
  const warnings: string[] = [];
  expect(await enrichChanges(many, warnings)).toEqual(many);
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(warnings).toHaveLength(1);
});

it.each(['not JSON', 'null', '{"ghsa_id":"wrong"}'])('warns about malformed metadata without losing findings: %s', data => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(data)));
  const warnings: string[] = [];
  return enrichChanges([change], warnings).then(result => {
    expect(result).toEqual([change]);
    expect(warnings).toHaveLength(1);
  });
});

it('bounds the total enrichment time and removes the abort listener', async () => {
  vi.useFakeTimers();
  const caller = new AbortController();
  const remove = vi.spyOn(caller.signal, 'removeEventListener');
  vi.stubGlobal('fetch', (_url: string, { signal }: RequestInit) => new Promise((_resolve, reject) => {
    signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
  }));
  const warnings: string[] = [];
  const pending = enrichChanges([change], warnings, caller.signal);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await pending).toEqual([change]);
  expect(warnings).toHaveLength(1);
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  expect(vi.getTimerCount()).toBe(0);
});

it('propagates user cancellation rather than downgrading it to a display warning', async () => {
  const caller = new AbortController();
  vi.stubGlobal('fetch', (_url: string, { signal }: RequestInit) => new Promise((_resolve, reject) => {
    signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
  }));
  const warnings: string[] = [];
  const pending = enrichChanges([change], warnings, caller.signal);
  const error = new Error('Interrupted');
  caller.abort(error);
  await expect(pending).rejects.toBe(error);
  await expect(enrichChanges([change], warnings, caller.signal)).rejects.toBe(error);
  expect(warnings).toEqual([]);
});

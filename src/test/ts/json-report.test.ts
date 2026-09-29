import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createJsonFailure, createJsonReport } from '../../main/ts/json-report.js';
import type { FixResult } from '../../main/ts/index.js';

const advisory = { id: '1', name: 'foo', vulnerable: '<1.2.3', ghsaId: 'GHSA-v6h2-p8h4-qcjw', cves: ['CVE-2025-5889'], cvss: { score: 3.1 } };
const change = { name: 'foo', descriptor: 'foo@npm:^1', from: '1.0.0', to: '1.2.3', advisories: [advisory] };
const report = (overrides: Partial<FixResult> = {}): FixResult => ({
  changes: [], skipped: [], resolutions: {}, policy: 'lowest', yarnVersion: '4.18.1',
  changed: false, dryRun: false, before: [], remaining: [], warnings: [], ...overrides,
});
afterEach(() => vi.useRealTimers());

it('includes the format version, installed tool version and UTC generation time in successful and failed reports', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-29T23:45:12.345+03:00'));
  const { version } = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'));
  const meta = { schemaVersion: 1, toolVersion: version, generatedAt: '2026-09-29T20:45:12.345Z' };
  expect((await createJsonReport(report())).meta).toEqual(meta);
  expect(await createJsonFailure('Install failed', false)).toEqual({ meta, status: 'error', error: { message: 'Install failed' } });
  expect(await createJsonFailure('Interrupted', true)).toEqual({ meta, status: 'interrupted', error: { message: 'Interrupted' } });
});

it('counts applied requests separately from unique resolved advisories, including removed transitive packages', async () => {
  const child = { ...advisory, name: 'child', id: '2', ghsaId: undefined, cves: ['CVE-2025-10000'] };
  const input = report({ changed: true,
    changes: [change, { ...change, descriptor: 'foo@npm:~1.0.0' }],
    before: [advisory, advisory, child],
  });
  const original = structuredClone(input);
  const result = await createJsonReport(input);
  expect(result.status).toBe('clean');
  expect(result.summary).toEqual({ applied: 2, planned: 0, skipped: 0, advisories: { before: 2, resolved: 2, remaining: 0, introduced: 0 } });
  expect(result.resolved.map(item => item.name)).toEqual(['child', 'foo']);
  expect(result.cves).toEqual({ resolved: ['CVE-2025-10000', 'CVE-2025-5889'], remaining: [], introduced: [], complete: true });
  expect(input).toEqual(original);
  expect(result.changes).toEqual(input.changes);
});

it('does not declare a CVE resolved when another branch remains vulnerable, even if numeric advisory IDs change', async () => {
  const remaining = { ...advisory, id: '999', cves: undefined, cvss: undefined };
  const result = await createJsonReport(report({ changed: true, changes: [change], before: [advisory], remaining: [remaining] }));
  expect(result.status).toBe('unfixed');
  expect(result.summary.applied).toBe(1);
  expect(result.resolved).toEqual([]);
  expect(result.introduced).toEqual([]);
  expect(result.cves).toEqual({ resolved: [], remaining: advisory.cves, introduced: [], complete: true });
  expect(result.remaining[0]?.cvss).toEqual(advisory.cvss);
});

it('retains a CVE shared by another package even when one of its advisories is resolved', async () => {
  const other = { ...advisory, name: 'bar', id: '2', ghsaId: undefined };
  const result = await createJsonReport(report({ changed: true, changes: [change], before: [advisory, other], remaining: [other] }));
  expect(result.resolved).toEqual([advisory]);
  expect(result.cves.resolved).toEqual([]);
  expect(result.cves.remaining).toEqual(advisory.cves);
});

it('shares known CVE identities across packages covered by the same GHSA', async () => {
  const other = { ...advisory, name: 'bar', id: '2', cves: undefined };
  const result = await createJsonReport(report({ before: [advisory, other], remaining: [other] }));
  expect(result.resolved.map(item => item.name)).toEqual(['foo']);
  expect(result.cves.resolved).toEqual([]);
  expect(result.cves.remaining).toEqual(advisory.cves);
  expect(result.cves.complete).toBe(true);
});

it('matches numeric IDs when only one audit includes the GHSA alias and shares CVEs supplied on individual changes', async () => {
  const initial = { id: '1', name: 'foo', vulnerable: '<1.2.3' };
  const result = await createJsonReport(report({ changes: [change], before: [initial], remaining: [{ ...initial, ghsaId: advisory.ghsaId }] }));
  expect(result.resolved).toEqual([]);
  expect(result.introduced).toEqual([]);
  expect(result.remaining[0]?.cves).toEqual(advisory.cves);
  expect(result.cves.complete).toBe(true);
});

it('reports newly observed advisories and CVEs separately from resolved ones', async () => {
  const introduced = { ...advisory, id: '2', ghsaId: undefined, cves: ['CVE-2026-10000'] };
  const result = await createJsonReport(report({ changed: true, changes: [change], before: [advisory], remaining: [introduced] }));
  expect(result.status).toBe('unfixed');
  expect(result.summary.advisories).toEqual({ before: 1, resolved: 1, remaining: 1, introduced: 1 });
  expect(result.introduced).toEqual([introduced]);
  expect(result.cves).toEqual({ resolved: advisory.cves, remaining: introduced.cves, introduced: introduced.cves, complete: true });
});

it('keeps dry-run changes as plans and never reports their CVEs as already resolved', async () => {
  const result = await createJsonReport(report({ dryRun: true, changes: [change], before: [advisory], remaining: [advisory] }));
  expect(result.status).toBe('dry-run');
  expect(result.changed).toBe(false);
  expect(result.summary).toEqual({ applied: 0, planned: 1, skipped: 0, advisories: { before: 1, resolved: 0, remaining: 1, introduced: 0 } });
  expect(result.cves.resolved).toEqual([]);
  expect(result.cves.introduced).toEqual([]);
  expect(result.changes[0]?.advisories[0]?.cves).toEqual(advisory.cves);
});

it('retains unfixable requests and their reasons when no changes were applied', async () => {
  const skipped = { name: 'foo', descriptor: 'foo@npm:1.0.0', version: '1.0.0', reason: 'No published safe version satisfies the original dependency range' };
  const result = await createJsonReport(report({ skipped: [skipped], before: [advisory], remaining: [advisory] }));
  expect(result.status).toBe('unfixed');
  expect(result.summary).toMatchObject({ applied: 0, planned: 0, skipped: 1 });
  expect(result.skipped).toEqual([skipped]);
  expect(result.cves.remaining).toEqual(advisory.cves);
});

it.each([{ cves: undefined, complete: false }, { cves: [], complete: true }])('distinguishes missing CVE metadata from a known absence of CVEs: $complete', async ({ cves, complete }) => {
  const finding = { ...advisory, cves };
  const result = await createJsonReport(report({ before: [finding], remaining: [finding] }));
  expect(result.status).toBe('unfixed');
  expect(result.cves).toEqual({ resolved: [], remaining: [], introduced: [], complete });
  expect(result.remaining[0]?.ghsaId).toBe(advisory.ghsaId);
});

it('provides empty arrays and zero counts for a clean no-op run', async () => {
  const result = await createJsonReport(report());
  expect(result.status).toBe('clean');
  expect(result.summary).toEqual({ applied: 0, planned: 0, skipped: 0, advisories: { before: 0, resolved: 0, remaining: 0, introduced: 0 } });
  expect(result.cves).toEqual({ resolved: [], remaining: [], introduced: [], complete: true });
});

import { expect, it } from 'vitest';
import { parseAudit } from '../../main/ts/audit.js';
import { advisoryDetails } from '../../main/ts/advisory-details.js';
import { changeLines, describeChanges } from '../../main/ts/report.js';

const ghsaId = 'GHSA-v6h2-p8h4-qcjw';
const url = `https://github.com/advisories/${ghsaId}`;
const details = { cves: ['CVE-2025-5889'], ghsaId, severity: 'low', cvss: { score: 3.1, vector: 'CVSS:3.1/AV:N/AC:H/PR:L/UI:N/S:U/C:N/I:N/A:L' } };
const raw = { id: 1, module_name: 'foo', vulnerable_versions: '<1.2.3', cves: details.cves, url, severity: 'low', cvss: { score: 3.1, vectorString: details.cvss.vector } };
const advisory = { id: '1', name: 'foo', vulnerable: '<1.2.3', url, ...details };
const change = { name: 'foo', descriptor: 'foo@npm:^1', from: '1.0.0', to: '1.2.3' };

it.each([JSON.stringify({ advisories: { 1: raw } }), JSON.stringify({ foo: [raw] }), JSON.stringify({ type: 'auditAdvisory', data: { advisory: raw } })])('preserves supplied CVEs and CVSS metadata across audit formats', text => {
  expect(parseAudit(text)).toEqual([advisory]);
});

it('retains Yarn 4 severity and GHSA identity without inventing CVE or score', () => {
  expect(parseAudit(JSON.stringify({ value: 'foo', children: { ID: 1, URL: url, Severity: 'low', 'Vulnerable Versions': '<1.2.3' } })))
    .toEqual([{ id: '1', name: 'foo', vulnerable: '<1.2.3', url, ghsaId, severity: 'low' }]);
});

it('normalizes GitHub metadata, including no assigned CVE and a zero CVSS score', () => {
  expect(advisoryDetails({ ghsa_id: ghsaId, cve_id: null, cvss: { score: 0 } })).toEqual({ ghsaId, cves: [], cvss: { score: 0 } });
  expect(advisoryDetails({ cve_id: 'cve-2025-5889', cvss_severities: { cvss_v3: { score: 7.5, vector_string: 'CVSS:3.1/...' } } }))
    .toEqual({ cves: ['CVE-2025-5889'], cvss: { score: 7.5, vector: 'CVSS:3.1/...' } });
  expect(advisoryDetails({ cvss_severities: { cvss_v4: { score: 9.3 } } })).toEqual({ cvss: { score: 9.3 } });
});

it.each([undefined, null, [], { score: 'high' }, { score: -1 }, { score: 11 }, { score: NaN }, { score: Infinity }])('ignores invalid optional scores: %j', cvss => {
  expect(advisoryDetails({ cvss, cves: [123, 'unknown'], ghsa_id: 'not-a-ghsa' })).toEqual({});
});

it('deduplicates valid CVEs and rejects malformed optional identifiers', () => {
  expect(advisoryDetails({ cves: ['CVE-2025-5889', 'cve-2025-5889', 'junk'] })).toEqual({ cves: ['CVE-2025-5889'] });
  expect(advisoryDetails({ cves: 'CVE-2025-5889', github_advisory_id: 123 })).toEqual({});
});

it('attributes only vulnerabilities removed by this bump, excluding other branches and candidate-only findings', () => {
  const findings = [advisory, advisory,
    { ...advisory, id: '2', ghsaId: undefined, vulnerable: '>=2 <3' },
    { ...advisory, id: '3', ghsaId: undefined, vulnerable: '1.2.2' },
    { ...advisory, id: '4', ghsaId: undefined, name: 'bar' },
    { ...advisory, id: '5', ghsaId: undefined, vulnerable: '*' },
  ];
  expect(describeChanges([change], findings)).toEqual([{ ...change, advisories: [advisory] }]);
  const removed = describeChanges([{ ...change, removed: true }], findings)[0]!;
  expect(removed.advisories.map(item => item.id)).toEqual(['1', '5']);
});

it('prints CVE scores for actual and proposed changes and uses an explicit fallback for missing data', () => {
  const reported = { ...change, advisories: [advisory] };
  expect(changeLines(reported, false)).toEqual(['Fixed foo@npm:^1: 1.0.0 -> 1.2.3', '  CVE-2025-5889 (CVSS 3.1)']);
  expect(changeLines(reported, true)[0]).toBe('Would fix foo@npm:^1: 1.0.0 -> 1.2.3');
  expect(changeLines({ ...reported, removed: true }, false)[0]).toContain('removed from graph');
  expect(changeLines({ ...change, advisories: [{ id: '2', name: 'foo', vulnerable: '*', ghsaId }] }, false)[1]).toBe(`  ${ghsaId}`);
  expect(changeLines({ ...change, advisories: [{ ...advisory, cves: [], cvss: { score: 7.5 } }] }, false)[1]).toBe(`  ${ghsaId}`);
  expect(changeLines({ ...change, advisories: [{ id: '2', name: 'foo', vulnerable: '*', cves: [], cvss: { score: 0 } }] }, false)[1]).toBe('  advisory 2');
  expect(changeLines({ ...change, advisories: [{ ...advisory, cvss: { score: 0 } }] }, false)[1]).toBe('  CVE-2025-5889 (CVSS 0.0)');
  expect(changeLines({ ...change, advisories: [{ ...advisory, cvss: undefined }] }, false)[1]).toBe('  CVE-2025-5889 (CVSS unavailable)');
});

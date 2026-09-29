import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { parseAudit } from '../../main/ts/audit.js';
import { createPlan } from '../../main/ts/plan.js';
import { parseLockfile, type Lockfile } from '../../main/ts/lockfile.js';
import { auditResult, publishedVersions, supportedYarn } from '../../main/ts/yarn.js';
import { readFixture, readFixtureManifest } from './build-fixtures.js';

const advisory = { id: '1', name: 'foo', vulnerable: '<1.2.3' };
const entry = (version: string, name = 'foo') => ({ version, resolution: `${name}@npm:${version}`, checksum: 'original', dependencies: { child: 'npm:^1' } });
const lock: Lockfile = { __metadata: { version: '8' }, 'foo@npm:^1.0.0, foo@npm:~1.2.0': entry('1.2.0') };

describe('audit normalization', () => {
  it('reads legacy Yarn 3 JSON, including formatted JSON', () => {
    expect(parseAudit(JSON.stringify({ advisories: { '1': { id: 1, module_name: 'foo', vulnerable_versions: '<1.2.3', patched_versions: '>=1.2.3' } } }, null, 2)))
      .toEqual([{ ...advisory, patched: '>=1.2.3' }]);
  });
  it('reads Yarn 4 NDJSON and deduplicates advisories', () => {
    const line = JSON.stringify({ value: 'foo', children: { ID: 1, 'Vulnerable Versions': '<1.2.3' } });
    expect(parseAudit(`${line}\n${line}\n`)).toEqual([advisory]);
  });
  it('reads registry bulk data', () => {
    expect(parseAudit(JSON.stringify({ foo: [{ id: 1, vulnerable_versions: '<1.2.3' }] }))).toEqual([advisory]);
  });
  it.each(['{}', '{"advisories":{}}', '', '{"type":"info","data":"No audit suggestions"}'])('accepts clean reports: %s', text => {
    expect(auditResult({ code: 0, stdout: text, stderr: '' })).toEqual([]);
  });
  it.each(['not json', '{"error":"registry unavailable"}', '{"foo":[{"id":1,"vulnerable_versions":"banana"}]}', '{"type":"error","data":"HTTP 503"}'])('rejects unknown or broken reports: %s', text => {
    expect(() => parseAudit(text)).toThrow();
  });
  it('distinguishes an audit finding from an operational failure', () => {
    expect(auditResult({ code: 1, stdout: '{"foo":[{"id":1,"vulnerable_versions":"<1.2.3"}]}', stderr: '' })).toEqual([advisory]);
    expect(() => auditResult({ code: 1, stdout: '{}', stderr: 'network error' })).toThrow('network error');
    expect(() => auditResult({ code: 2, stdout: '', stderr: 'usage error' })).toThrow('usage error');
  });
});

describe('compatible planning', () => {
  it('uses the lowest published version satisfying each original descriptor and every advisory', () => {
    const plan = createPlan(lock, [advisory, { ...advisory, id: '2', vulnerable: '>=1.2.3 <1.2.5' }], { foo: ['2.0.0', '1.2.5-beta.1', '1.3.0', '1.2.5', '1.2.3'] });
    expect(plan.changes).toEqual([
      { name: 'foo', descriptor: 'foo@npm:^1.0.0', from: '1.2.0', to: '1.2.5' },
      { name: 'foo', descriptor: 'foo@npm:~1.2.0', from: '1.2.0', to: '1.2.5' },
    ]);
  });
  it('never overrides a pinned or incompatible request', () => {
    const pinned = { ...lock, 'foo@npm:1.2.0': entry('1.2.0') };
    const plan = createPlan(pinned, [advisory], { foo: ['1.2.3', '2.0.0'] });
    expect(plan.changes).toHaveLength(2);
    expect(plan.skipped).toEqual([expect.objectContaining({ descriptor: 'foo@npm:1.2.0' })]);
    expect(createPlan(lock, [advisory], { foo: ['2.0.0'] }).changes).toEqual([]);
  });
  it('preserves separate major branches and does not confuse patched ranges across branches', () => {
    const branches = { ...lock, 'foo@npm:^2': entry('2.0.0') };
    const advisories = [{ ...advisory, patched: '>=1.2.3 <2' }, { ...advisory, id: '2', vulnerable: '>=2 <2.0.3', patched: '>=2.0.3' }];
    expect(createPlan(branches, advisories, { foo: ['1.2.3', '2.0.3'] }).changes.map(c => c.to)).toEqual(['1.2.3', '1.2.3', '2.0.3']);
  });
  it.each(['foo', 'parent/foo', 'foo@npm:^1.0.0'])('preserves existing user resolutions: %s', key => {
    expect(createPlan(lock, [advisory], { foo: ['1.2.3'] }, { [key]: '1.2.0' }).changes).toEqual([]);
  });
  it('reports unfixable and unsupported descriptors', () => {
    expect(createPlan(lock, [{ ...advisory, vulnerable: '*' }], { foo: ['9.0.0'] }).skipped).toHaveLength(2);
    const special = { __metadata: {}, 'foo@npm:latest': entry('1.2.0'), 'foo@patch:foo@npm%3A1.2.0#./fix.patch': entry('1.2.0') };
    expect(createPlan(special, [advisory], { foo: ['1.2.3'] }).skipped).toHaveLength(2);
  });
  it('handles scoped packages and explicit tarball locations', () => {
    const scoped = { __metadata: {}, '@scope/foo@npm:^1': { ...entry('1.2.0', '@scope/foo'), resolution: '@scope/foo@npm:1.2.0::__archiveUrl=https%3A%2F%2Fexample.org%2Fa.tgz' } };
    expect(createPlan(scoped, [{ ...advisory, name: '@scope/foo' }], { '@scope/foo': ['1.2.3'] }).changes).toHaveLength(1);
  });
});

describe('lockfile input', () => {
  it('rejects Classic lockfiles', () => { expect(() => parseLockfile('# yarn lockfile v1\n')).toThrow('Berry'); });
});

describe('compatibility and metadata', () => {
  it.each(['2.4.0', '2.4.3', '3.0.0', '3.5.1', '4.0.1', '4.2.2', '4.18.1'])('supports Yarn %s', version => { expect(supportedYarn(version)).toBeGreaterThanOrEqual(2); });
  it.each(['1.22.22', '2.3.4', '4.0.0', '4.0.0-rc.14', '5.0.0', 'garbage'])('rejects unsupported Yarn %s', version => { expect(() => supportedYarn(version)).toThrow('Unsupported'); });
  it('rejects missing package metadata', () => { expect(() => publishedVersions('{}', 'foo')).toThrow('No published'); });
});

const provenance = await readFixtureManifest();
const repositories = [...new Set(Object.keys(provenance).filter(name => name.startsWith('qiwi/')).map(name => name.split('/')[1]!))];
describe.each(repositories)('upstream fixture %s', repo => {
  it('matches the pinned GitHub sources byte for byte', async () => {
    for (const [file, data] of Object.entries(provenance).filter(([name]) => name.startsWith(`qiwi/${repo}/`))) {
      expect(createHash('sha256').update(await readFixture(file)).digest('hex')).toBe(data.sha256);
    }
  });
  it('plans both vulnerable major branches on the full upstream lockfile', async () => {
    const raw = (await readFixture(`qiwi/${repo}/yarn.lock`)).toString();
    const audit = (await readFixture('audit/brace-expansion-bulk.json')).toString();
    const plan = createPlan(parseLockfile(raw), parseAudit(audit), { 'brace-expansion': ['1.1.12', '2.0.2', '1.1.18', '2.1.4'] });
    expect(plan.changes.map(change => change.to)).toEqual(['1.1.18', '2.1.4']);
    expect(plan.skipped).toEqual([]);
  });
});

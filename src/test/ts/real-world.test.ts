import { describe, expect, it } from 'vitest';
import semver from 'semver';
import { createPlan, parseAudit, type UpdatePolicy } from '../../main/ts/index.js';
import { npmDescriptor, parseLockfile } from '../../main/ts/lockfile.js';
import { readFixture, readFixtureManifest } from './build-fixtures.js';
import { bulk } from './registry.js';

const provenance = await readFixtureManifest();
const projects = Object.entries(provenance).filter(([, fixture]) => fixture.project).map(([file, fixture]) => ({
  file, source: file.slice(0, -'/yarn.lock'.length), ...fixture.project!,
}));
const versions: Record<string, string[]> = {};
for (const [file, fixture] of Object.entries(provenance)) if (fixture.format === 'npm-metadata') {
  const metadata = JSON.parse((await readFixture(file)).toString());
  versions[metadata.name] = fixture.versions!;
}
const advisories = parseAudit(JSON.stringify(bulk));

it('covers the supported native schemas with pinned upstream monorepos', () => {
  expect([...new Set(projects.map(project => project.schema))].sort((a, b) => a - b)).toEqual([4, 5, 6, 8, 9, 10]);
  expect(projects).toHaveLength(8);
});

describe.each(projects)('$source / original schema $schema', ({ file, source, schema }) => {
  it.each(['lowest', 'highest'] as UpdatePolicy[])('plans only compatible fixes under the %s policy', async policy => {
    const lock = parseLockfile((await readFixture(file)).toString());
    expect(lock.__metadata?.version).toBe(String(schema));
    expect(Object.values(lock).some(entry => entry.resolution?.includes('@workspace:'))).toBe(true);
    const manifest = JSON.parse((await readFixture(`${source}/package.json`)).toString());
    const plan = createPlan(lock, advisories, versions, manifest.resolutions, policy);
    for (const change of plan.changes) {
      expect(semver.gt(change.to, change.from)).toBe(true);
      expect(semver.prerelease(change.to)).toBeNull();
      expect(semver.satisfies(change.to, npmDescriptor(change.descriptor)!.range)).toBe(true);
      expect(advisories.filter(advisory => advisory.name === change.name).some(advisory => semver.satisfies(change.to, advisory.vulnerable))).toBe(false);
    }
    // These pinned snapshots contain reported vulnerable descriptors, including protected requests.
    expect(plan.changes.length + plan.skipped.length).toBeGreaterThan(0);
  });

});

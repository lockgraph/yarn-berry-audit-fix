import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import semver from 'semver';
import { fixAudit, createPlan, parseAudit, type UpdatePolicy } from '../../main/ts/index.js';
import { descriptors, npmDescriptor, parseLockfile } from '../../main/ts/lockfile.js';
import { restoreDescriptorHeaders } from '../../main/ts/patch.js';
import { requireSuccess, type InstallMode } from '../../main/ts/yarn.js';
import { readFixture, readFixtureManifest } from './build-fixtures.js';
import { prepareMonorepo } from './project.js';
import { bulk, startRegistry } from './registry.js';

const require = createRequire(import.meta.url);
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

  it('restores a temporary header while preserving the entire native lockfile byte for byte', async () => {
    const raw = (await readFixture(file)).toString();
    const lock = parseLockfile(raw);
    const requests = new Set(Object.values(lock).flatMap(entry => Object.entries(entry.dependencies ?? {})
      .filter((pair): pair is [string, string] => typeof pair[1] === 'string')
      .map(([name, range]) => `${name}@${range.includes(':') ? range : `npm:${range}`}`)));
    const candidate = Object.entries(lock).find(([key, entry]) => {
      const request = npmDescriptor(key);
      return !key.includes(', ') && request && entry.version && requests.has(key) && semver.satisfies(entry.version, request.range) &&
        entry.resolution === `${request.name}@npm:${entry.version}` && !descriptors(lock).has(entry.resolution) && raw.includes(`\n${JSON.stringify(key)}:\n`);
    });
    expect(candidate, 'Expected a genuine range descriptor for the header round-trip').toBeDefined();
    const [descriptor, entry] = candidate!;
    const name = npmDescriptor(descriptor)!.name;
    // Change only the request header, as temporary resolutions do. Version selection is checked separately.
    const temporary = raw.replace(`\n${JSON.stringify(descriptor)}:\n`, `\n${JSON.stringify(entry.resolution)}:\n`);
    expect(temporary).not.toBe(raw);
    const restored = restoreDescriptorHeaders(temporary, [{ name, descriptor, from: entry.version!, to: entry.version! }]);
    expect(restored).toBe(raw);
  });
});

describe('native upstream workspace subgraphs', () => {
  let registry: Awaited<ReturnType<typeof startRegistry>>;
  beforeAll(async () => { registry = await startRegistry(); });
  afterAll(async () => { await registry?.close(); });
  for (const fixture of projects.filter(project => project.nativeDependencies)) {
    const cases = (['node-modules', 'pnp'] as const).flatMap(linker =>
      (fixture.schema === 4 ? [undefined] : [undefined, 'update-lockfile'] as (InstallMode | undefined)[]).map(mode => ({ linker, mode })));
    it.each(cases)(`${fixture.source}: preserves real workspace links ($linker, $mode)`, async ({ linker, mode }) => {
      const cwd = await mkdtemp(join(tmpdir(), 'berry-real-world-'));
      try {
        const project = await prepareMonorepo(cwd, registry.url, require.resolve(`${fixture.manager}/bin/yarn.js`), fixture.source, fixture.nativeDependencies!, linker);
        const workspaces = requireSuccess(await project.run(['workspaces', 'list', '--json']), 'Discover real workspaces').trim().split('\n').map(line => JSON.parse(line));
        expect(workspaces).toHaveLength(project.manifests.size);
        expect(workspaces.length).toBeGreaterThan(3);
        const report = await fixAudit({ cwd, runner: project.runner, mode, policy: 'highest' });
        expect(report.changed).toBe(true);
        expect(report.changes.some(change => change.name === 'semver')).toBe(true);
        expect(report.remaining).toEqual([]);
        for (const [file, contents] of project.manifests) expect(await readFile(join(cwd, file))).toEqual(contents);
        expect((await readdir(cwd)).some(file => file.endsWith('.backup') || file === '.yarn-berry-audit-fix.lock')).toBe(false);
        const fixed = await readFile(join(cwd, 'yarn.lock'));
        requireSuccess(await project.run(['install', '--immutable']), 'Immutable real monorepo install');
        expect(await readFile(join(cwd, 'yarn.lock'))).toEqual(fixed);
        const workspace = fixture.source.endsWith('berry-3') ? ['workspace', '@yarnpkg/core'] : [];
        const installed = requireSuccess(await project.run([...workspace, 'node', '-p', 'require("semver/package.json").version']), 'Installed workspace dependency').trim();
        expect(installed).toBe('7.8.5');
        expect((await fixAudit({ cwd, runner: project.runner, mode })).changed).toBe(false);
      } finally { await rm(cwd, { recursive: true, force: true }); }
    });
  }
});

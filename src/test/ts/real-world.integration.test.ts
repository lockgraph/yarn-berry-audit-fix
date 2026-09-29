import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fixAudit } from '../../main/ts/index.js';
import { requireSuccess, type InstallMode } from '../../main/ts/yarn.js';
import { readFixtureManifest } from './build-fixtures.js';
import { prepareMonorepo } from './project.js';
import { startRegistry } from './registry.js';

const require = createRequire(import.meta.url);
const provenance = await readFixtureManifest();
const projects = Object.entries(provenance).filter(([, fixture]) => fixture.project).map(([file, fixture]) => ({
  source: file.slice(0, -'/yarn.lock'.length), ...fixture.project!,
}));

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

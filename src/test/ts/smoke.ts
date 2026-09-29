import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRunner, requireSuccess } from '../../main/ts/yarn.js';
import { lookupVersions } from '../../main/ts/metadata.js';
import type { FixResult } from '../../main/ts/index.js';
import { prepareProject } from './project.js';
import { startRegistry } from './registry.js';

const cli = createRunner([process.execPath, resolve('target/main/cli.js')]);
const runCLI = (args: string[]) => cli(args, { cwd: process.cwd(), env: { ...process.env, YARN_IGNORE_PATH: '1' } });
assert.match(requireSuccess(await runCLI(['--help']), 'CLI help'), /--policy=lowest\|highest/);
assert.match(requireSuccess(await runCLI(['-h']), 'CLI short help'), /--ignore-unfixed/);
const packageManifest = JSON.parse(await readFile('package.json', 'utf8'));
for (const flag of ['--version', '-v']) assert.equal(requireSuccess(await runCLI([flag, '--cwd', 'missing-project']), 'CLI version').trim(), packageManifest.version);
for (const flag of ['--policy=unknown', '--mode=unknown', '--audit-registry=not-a-url']) assert.equal((await runCLI([flag])).code, 2);
async function assertSilent(args: string[], code: number) {
  const result = await runCLI([...args, '--silent']);
  assert.equal(result.code, code);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
}
for (const flag of ['--help', '-h', '--version', '-v']) await assertSilent([flag], 0);
await assertSilent(['--unknown'], 2);
await assertSilent(['--cwd', 'missing-project'], 2);

const registry = await startRegistry();
try {
  const cases = [
    { alias: 'pm-yarn-2', mode: undefined, workspace: false },
    { alias: 'pm-yarn-berry-v6', mode: undefined, workspace: false },
    { alias: 'pm-yarn-berry-v10', mode: undefined, workspace: true },
    { alias: 'pm-yarn-berry-v10', mode: 'update-lockfile', workspace: true },
  ];
  for (const { alias, mode, workspace } of cases) {
    const cwd = await mkdtemp(join(tmpdir(), 'berry-smoke-'));
    try {
      const yarn = resolve('target/smoke-managers', `${alias}.cjs`);
      const project = await prepareProject(cwd, registry.url, yarn, { repo: workspace ? 'masker' : 'packasso', workspace });
      const files = ['package.json', 'yarn.lock', '.yarnrc.yml', ...(workspace ? ['packages/child/package.json'] : [])];
      const original = await Promise.all(files.map(file => readFile(join(cwd, file))));
      const originalEntries = await readdir(cwd);
      const state = await readFile(join(cwd, '.yarn/install-state.gz'));
      const metadata = await lookupVersions(['brace-expansion', 'semver'], project.run);
      assert.ok(metadata['brace-expansion']!.includes('1.1.18'));
      assert.ok(metadata.semver!.includes('7.8.5'));
      const args = ['--cwd', cwd, '--yarn-path', yarn, '--json', '--policy=highest',
        ...(mode ? [`--mode=${mode}`] : []), `--audit-registry=${registry.url}`];
      const dry: FixResult = JSON.parse(requireSuccess(await runCLI([...args, '--dry-run']), 'CLI dry run'));
      assert.equal(dry.changed, false);
      assert.equal(dry.policy, 'highest');
      assert.equal(dry.changes.length, workspace ? 2 : 1);
      assert.ok(dry.changes.every(change => change.advisories.some(advisory => advisory.ghsaId && advisory.cvss)));
      const digest = requireSuccess(await runCLI([...args.filter(arg => arg !== '--json'), '--dry-run']), 'CLI dry-run digest');
      assert.match(digest, new RegExp(`Dry run: ${workspace ? 2 : 1} planned fix\\(es\\) across 1 package\\(s\\)`));
      assert.match(digest, /No files changed\./);
      assert.match(digest, /Would fix brace-expansion/);
      await assertSilent([...args, '--dry-run'], 0);
      assert.deepEqual(await Promise.all(files.map(file => readFile(join(cwd, file)))), original);
      assert.deepEqual(await readdir(cwd), originalEntries);
      assert.deepEqual(await readFile(join(cwd, '.yarn/install-state.gz')), state);
      if (alias === 'pm-yarn-2') {
        assert.equal((await runCLI([...args, '--mode=update-lockfile'])).code, 2);
        assert.deepEqual(await Promise.all(files.map(file => readFile(join(cwd, file)))), original);
      }
      const result: FixResult = JSON.parse(requireSuccess(await runCLI(args), 'CLI repair'));
      assert.equal(result.changed, true);
      assert.equal(result.policy, 'highest');
      assert.deepEqual(result.remaining, []);
      assert.deepEqual(result.changes.map(change => change.to), workspace ? ['1.1.18', '2.1.4'] : ['1.1.18']);
      for (const [index, file] of files.entries()) if (file !== 'yarn.lock') assert.deepEqual(await readFile(join(cwd, file)), original[index]);
      assert.equal((await readdir(cwd)).some(file => file.endsWith('.backup') || file === '.yarn-berry-audit-fix.lock'), false);
      if (mode) {
        assert.equal((await readdir(cwd)).includes('node_modules'), false);
        assert.deepEqual(await readFile(join(cwd, '.yarn/install-state.gz')), state);
      }
      const fixed = await readFile(join(cwd, 'yarn.lock'));
      requireSuccess(await project.run(['install', '--immutable', ...(alias.endsWith('v10') ? ['--check-resolutions'] : [])]), 'Immutable smoke install');
      assert.deepEqual(await readFile(join(cwd, 'yarn.lock')), fixed);
      const installed = requireSuccess(await project.run(['node', '-e', 'const r=require("module").createRequire(require.resolve("minimatch")); console.log(r("brace-expansion/package.json").version)']), 'Installed dependency').trim();
      assert.equal(installed, '1.1.18');
      assert.equal((JSON.parse(requireSuccess(await runCLI(args), 'Repeated repair')) as FixResult).changed, false);
      // Existing resolutions prevent repair; the flag changes only the exit status.
      const pinned = JSON.parse(original[0]!.toString());
      pinned.resolutions = { 'brace-expansion': 'npm:1.1.11' };
      await writeFile(join(cwd, 'package.json'), JSON.stringify(pinned));
      requireSuccess(await project.run(['install']), 'Prepare unfixable CLI report');
      const unfixable = await runCLI(args);
      assert.equal(unfixable.code, 1);
      assert.ok((JSON.parse(unfixable.stdout) as FixResult).remaining.length);
      const ignored = await runCLI([...args, '--ignore-unfixed']);
      assert.equal(ignored.code, 0);
      assert.deepEqual(JSON.parse(ignored.stdout), JSON.parse(unfixable.stdout));
      assert.equal((await runCLI([...args, '--ignore-unfixed', '--cwd', join(cwd, 'missing-project')])).code, 2);
      await assertSilent(args, 1);
      await assertSilent([...args, '--ignore-unfixed'], 0);
      if (alias === 'pm-yarn-berry-v10' && !mode) {
        await writeFile(join(cwd, 'package.json'), original[0]!);
        await writeFile(join(cwd, 'yarn.lock'), original[1]!);
        await assertSilent(args, 0);
        assert.notDeepEqual(await readFile(join(cwd, 'yarn.lock')), original[1]);
        const silentInstalled = requireSuccess(await project.run(['node', '-e', 'const r=require("module").createRequire(require.resolve("minimatch")); console.log(r("brace-expansion/package.json").version)']), 'Silently installed dependency').trim();
        assert.equal(silentInstalled, '1.1.18');
      }
      console.log(`Passed: ${alias}, ${mode ?? 'install'}, workspaces=${workspace}, Node ${process.version}, ${process.platform}`);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  }
} finally { await registry.close(); }

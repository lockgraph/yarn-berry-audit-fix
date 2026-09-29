import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRunner, requireSuccess } from '../../main/ts/yarn.js';
import type { FixResult } from '../../main/ts/index.js';
import { prepareProject } from './project.js';
import { startRegistry } from './registry.js';

const cli = createRunner([process.execPath, resolve('target/main/cli.js')]);
const runCLI = (args: string[]) => cli(args, { cwd: process.cwd(), env: { ...process.env, YARN_IGNORE_PATH: '1' } });
assert.match(requireSuccess(await runCLI(['--help']), 'CLI help'), /--policy=lowest\|highest/);
for (const flag of ['--policy=unknown', '--mode=unknown']) assert.equal((await runCLI([flag])).code, 2);

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
      const args = ['--cwd', cwd, '--yarn-path', yarn, '--json', '--policy=highest', ...(mode ? [`--mode=${mode}`] : [])];
      const dry: FixResult = JSON.parse(requireSuccess(await runCLI([...args, '--dry-run']), 'CLI dry run'));
      assert.equal(dry.changed, false);
      assert.equal(dry.policy, 'highest');
      assert.equal(dry.changes.length, workspace ? 2 : 1);
      assert.deepEqual(await Promise.all(files.map(file => readFile(join(cwd, file)))), original);
      if (alias === 'pm-yarn-2') {
        assert.equal((await runCLI([...args, '--mode=update-lockfile'])).code, 2);
        assert.deepEqual(await Promise.all(files.map(file => readFile(join(cwd, file)))), original);
      }
      const state = await readFile(join(cwd, '.yarn/install-state.gz'));
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
      console.log(`Passed: ${alias}, ${mode ?? 'install'}, workspaces=${workspace}, Node ${process.version}, ${process.platform}`);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  }
} finally { await registry.close(); }

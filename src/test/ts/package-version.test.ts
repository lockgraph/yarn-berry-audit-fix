import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packageVersion } from '../../main/ts/package-version.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it('reads the source checkout version', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'));
  expect(await packageVersion()).toBe(manifest.version);
});

it('reads a relocated installed package after the release changes its version', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'berry-version-'));
  directories.push(cwd);
  await mkdir(join(cwd, 'target/main'), { recursive: true });
  const location = pathToFileURL(join(cwd, 'target/main/package-version.js')).href;
  await writeFile(join(cwd, 'package.json'), '{"name":"@lockgraph/yarn-berry-audit-fix","version":"1.2.3"}');
  expect(await packageVersion(location)).toBe('1.2.3');
  await writeFile(join(cwd, 'package.json'), '{"version":"1.2.4"}');
  expect(await packageVersion(location)).toBe('1.2.4');
  await writeFile(join(cwd, 'package.json'), '{}');
  await expect(packageVersion(location)).rejects.toThrow('Package manifest has no version');
});

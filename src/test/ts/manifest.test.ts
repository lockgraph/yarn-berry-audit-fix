import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withManifestBackups } from '../../main/ts/manifest.js';

const directories: string[] = [];
const original = '{\r\n\t"name": "fixture"\r\n}\r\n';
const hash = createHash('sha256').update(original).digest('hex');

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'berry-manifest-'));
  directories.push(cwd);
  const path = join(cwd, 'package.json');
  const backup = `${path}-${hash}.backup`;
  await writeFile(path, original);
  await chmod(path, 0o640);
  return { cwd, path, backup };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

it('moves the original to a content-hashed sibling and restores its inode, mode and timestamps', async () => {
  const { cwd, path, backup } = await fixture();
  const before = await stat(path);
  const result = await withManifestBackups([path], async () => {
    expect((await stat(backup)).ino).toBe(before.ino);
    expect((await stat(path)).ino).not.toBe(before.ino);
    await writeFile(path, '{"resolutions":{"foo":"1.2.3"}}');
    expect(await readFile(backup, 'utf8')).toBe(original);
    return 'done';
  });
  const after = await stat(path);
  expect(result).toBe('done');
  expect([after.ino, after.mode, after.mtimeMs]).toEqual([before.ino, before.mode, before.mtimeMs]);
  expect(await readFile(path, 'utf8')).toBe(original);
  expect(await readdir(cwd)).toEqual(['package.json']);
});

it('restores the original when the action deletes the working manifest and fails', async () => {
  const { cwd, path } = await fixture();
  const before = await stat(path);
  await expect(withManifestBackups([path], async () => {
    await rm(path);
    throw new Error('Yarn failed');
  })).rejects.toThrow('Yarn failed');
  expect((await stat(path)).ino).toBe(before.ino);
  expect(await readFile(path, 'utf8')).toBe(original);
  expect(await readdir(cwd)).toEqual(['package.json']);
});

it('does not overwrite an existing backup or run the action', async () => {
  const { path, backup } = await fixture();
  await writeFile(backup, 'previous backup');
  const action = vi.fn();
  await expect(withManifestBackups([path], action)).rejects.toMatchObject({ code: 'EEXIST' });
  expect(action).not.toHaveBeenCalled();
  expect(await readFile(path, 'utf8')).toBe(original);
  expect(await readFile(backup, 'utf8')).toBe('previous backup');
});

it('restores already moved manifests if preparing a later workspace fails', async () => {
  const root = await fixture();
  const child = await fixture();
  await writeFile(child.backup, 'previous backup');
  const before = await stat(root.path);
  await expect(withManifestBackups([root.path, child.path], async () => {})).rejects.toMatchObject({ code: 'EEXIST' });
  expect((await stat(root.path)).ino).toBe(before.ino);
  expect(await readdir(root.cwd)).toEqual(['package.json']);
  expect(await readFile(child.backup, 'utf8')).toBe('previous backup');
});

it('retains the original backup and reports its path if restoration fails', async () => {
  const { path, backup } = await fixture();
  const before = await stat(path);
  await expect(withManifestBackups([path], async () => {
    await rm(path);
    await mkdir(path);
    throw new Error('Action failed');
  })).rejects.toThrow(backup);
  expect(await readFile(backup, 'utf8')).toBe(original);
  expect((await stat(backup)).ino).toBe(before.ino);
});

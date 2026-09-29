import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFixtures, readFixture, readFixtureManifest } from './build-fixtures.js';

const contents = 'pinned fixture archive bytes';
const name = 'fixture-1.0.0.tgz';
const url = `https://registry.npmjs.org/fixture/-/${name}`;
let root: string;
let manifestPath: string;
let directory: string;
const log = () => {};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'audit-fix-fixtures-'));
  manifestPath = join(root, 'provenance.json');
  directory = join(root, 'archives');
  await writeFile(manifestPath, JSON.stringify({
    [name]: { url, sha256: createHash('sha256').update(contents).digest('hex') },
  }));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('downloads pinned bytes and reuses a verified cache without network access or rewriting files', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(contents));
  await buildFixtures({ manifestPath, directory, fetcher, log });
  expect(fetcher).toHaveBeenCalledWith(url, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(await readFile(join(directory, name), 'utf8')).toBe(contents);
  const before = await stat(join(directory, name));
  const offline = vi.fn<typeof fetch>().mockRejectedValue(new Error('Network is disabled'));
  await buildFixtures({ manifestPath, directory, fetcher: offline, log });
  expect(offline).not.toHaveBeenCalled();
  const after = await stat(join(directory, name));
  expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
  expect(await readdir(directory)).toEqual([name]);
});

it('replaces a corrupt cached archive with verified registry bytes', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(contents));
  await buildFixtures({ manifestPath, directory, fetcher, log });
  await writeFile(join(directory, name), 'corrupt cache');
  await buildFixtures({ manifestPath, directory, fetcher, log });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(await readFile(join(directory, name), 'utf8')).toBe(contents);
  expect(await readdir(directory)).toEqual([name]);
});

it.each([
  ['HTTP failure', () => new Response('Unavailable', { status: 503 }), 'HTTP 503'],
  ['integrity mismatch', () => new Response('different archive bytes'), 'SHA-256 mismatch'],
] as const)('rejects %s without publishing an archive or leaving temporary files', async (_, response, error) => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response());
  await expect(buildFixtures({ manifestPath, directory, fetcher, log })).rejects.toThrow(error);
  expect(await readdir(directory)).toEqual([]);
});

it('pins every tarball advertised by the registry metadata', async () => {
  const manifest = await readFixtureManifest();
  const urls: string[] = [];
  for (const [file, fixture] of Object.entries(manifest)) {
    if (fixture.format !== 'npm-metadata') continue;
    const metadata = JSON.parse((await readFixture(file)).toString());
    for (const version of Object.values(metadata.versions) as { dist: { tarball: string } }[]) urls.push(version.dist.tarball);
  }
  expect(Object.entries(manifest).filter(([name]) => name.endsWith('.tgz')).map(([, archive]) => archive.url).sort()).toEqual(urls.sort());
});

it('rejects undeclared, missing, and corrupt assets when tests read fixtures', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(contents));
  await buildFixtures({ manifestPath, directory, fetcher, log });
  expect((await readFixture(name, directory, manifestPath)).toString()).toBe(contents);
  await writeFile(join(directory, 'undeclared.json'), '{}');
  await expect(readFixture('undeclared.json', directory, manifestPath)).rejects.toThrow('not declared in provenance');
  await rm(join(directory, name));
  await expect(readFixture(name, directory, manifestPath)).rejects.toThrow('run npm run build:test-fixtures');
  await writeFile(join(directory, name), 'corrupt');
  await expect(readFixture(name, directory, manifestPath)).rejects.toThrow('missing or corrupt');
});

it('builds pinned metadata without following new registry versions or mutable publication metadata', async () => {
  const file = 'registry/fixture.json';
  const version = { dependencies: { child: '^1' }, dist: { integrity: 'sha512-pinned', tarball: url }, name: 'fixture', version: '1.0.0' };
  const expected = JSON.stringify({ 'dist-tags': { latest: '1.0.0' }, name: 'fixture', versions: { '1.0.0': version } }, null, 2) + '\n';
  await writeFile(manifestPath, JSON.stringify({ [file]: {
    url, format: 'npm-metadata', versions: ['1.0.0'], distTags: { latest: '1.0.0' },
    sha256: createHash('sha256').update(expected).digest('hex'),
  } }));
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({
    name: 'fixture', 'dist-tags': { latest: '2.0.0' },
    versions: { '1.0.0': { ...version, _npmOperationalInternal: { timestamp: Date.now() } }, '2.0.0': { version: '2.0.0' } },
  }));
  await buildFixtures({ manifestPath, directory, fetcher, log });
  expect((await readFixture(file, directory, manifestPath)).toString()).toBe(expected);
});

it('replays the declared audit request and requires every pinned advisory ID', async () => {
  const file = 'audit/fixture.json';
  const advisory = { id: 1, vulnerable_versions: '<1.0.1' };
  const expected = JSON.stringify({ fixture: [advisory] }, null, 2) + '\n';
  const requestBody = { fixture: ['1.0.0'] };
  await writeFile(manifestPath, JSON.stringify({ [file]: {
    url, format: 'npm-audit', requestBody, advisoryIds: [1],
    sha256: createHash('sha256').update(expected).digest('hex'),
  } }));
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ fixture: [{ id: 2 }, advisory] }));
  await buildFixtures({ manifestPath, directory, fetcher, log });
  expect(fetcher).toHaveBeenCalledWith(url, expect.objectContaining({ method: 'POST', body: JSON.stringify(requestBody) }));
  expect((await readFixture(file, directory, manifestPath)).toString()).toBe(expected);
  await rm(join(directory, file));
  fetcher.mockResolvedValueOnce(Response.json({ fixture: [{ id: 2 }] }));
  await expect(buildFixtures({ manifestPath, directory, fetcher, log })).rejects.toThrow('missing pinned advisory IDs');
  expect(await readdir(join(directory, 'audit'))).toEqual([]);
});

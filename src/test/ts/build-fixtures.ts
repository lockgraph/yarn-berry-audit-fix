import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const fixtureDirectory = fileURLToPath(new URL('../resources/real-world/', import.meta.url));
export const fixtureManifest = join(fixtureDirectory, 'provenance.json');

export interface Fixture {
  url: string;
  sha256: string;
  format?: 'npm-metadata' | 'npm-audit';
  versions?: string[];
  distTags?: Record<string, string>;
  advisoryIds?: number[];
  requestBody?: Record<string, string[]>;
  project?: { schema: number; manager: string; nativeDependencies?: string[] };
}
type Manifest = Record<string, Fixture>;

export async function readFixtureManifest(path = fixtureManifest): Promise<Manifest> {
  const manifest: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Invalid fixture manifest');
  for (const [name, fixture] of Object.entries(manifest)) {
    if (name === 'provenance.json' || !name.split('/').every(part => /^[\w.-]+$/.test(part) && part !== '.' && part !== '..') ||
        !fixture || typeof fixture !== 'object' || typeof fixture.url !== 'string' || new URL(fixture.url).protocol !== 'https:' ||
        typeof fixture.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(fixture.sha256) ||
        (fixture.format !== undefined && fixture.format !== 'npm-metadata' && fixture.format !== 'npm-audit')) {
      throw new Error(`Invalid fixture: ${name}`);
    }
    if (fixture.format === 'npm-metadata' && (!Array.isArray(fixture.versions) || !fixture.versions.length ||
        !fixture.versions.every((version: unknown) => typeof version === 'string') ||
        !fixture.distTags || typeof fixture.distTags !== 'object' || Array.isArray(fixture.distTags) ||
        !Object.values(fixture.distTags).every(version => typeof version === 'string' && fixture.versions.includes(version)))) {
      throw new Error(`Invalid metadata recipe: ${name}`);
    }
    if (fixture.format === 'npm-audit' && (!Array.isArray(fixture.advisoryIds) || !fixture.advisoryIds.length ||
        !fixture.advisoryIds.every(Number.isSafeInteger) || !fixture.requestBody || typeof fixture.requestBody !== 'object' ||
        Array.isArray(fixture.requestBody) || !Object.values(fixture.requestBody).every(versions =>
          Array.isArray(versions) && versions.every(version => typeof version === 'string')))) {
      throw new Error(`Invalid audit recipe: ${name}`);
    }
    if (fixture.project && (!name.endsWith('/yarn.lock') || ![4, 5, 6, 8, 9, 10].includes(fixture.project.schema) ||
        typeof fixture.project.manager !== 'string' || (fixture.project.nativeDependencies !== undefined &&
        (!Array.isArray(fixture.project.nativeDependencies) || !fixture.project.nativeDependencies.every((value: unknown) => typeof value === 'string'))))) {
      throw new Error(`Invalid project fixture: ${name}`);
    }
  }
  return manifest as Manifest;
}

export function hasExpectedHash(contents: Buffer, fixture: Pick<Fixture, 'sha256'>): boolean {
  return createHash('sha256').update(contents).digest('hex') === fixture.sha256;
}

/** Every external test asset must be declared in provenance and match its digest. */
export async function readFixture(name: string, directory = fixtureDirectory, manifestPath = fixtureManifest): Promise<Buffer> {
  const fixture = (await readFixtureManifest(manifestPath))[name];
  if (!fixture) throw new Error(`Fixture is not declared in provenance: ${name}`);
  let contents: Buffer | undefined;
  try { contents = await readFile(join(directory, name)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (!contents || !hasExpectedHash(contents, fixture)) {
    throw new Error(`Fixture ${name} is missing or corrupt; run npm run build:test-fixtures`);
  }
  return contents;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, entry]) => [key, canonical(entry)]));
  return value;
}

const select = (value: Record<string, unknown>, fields: string[]) => Object.fromEntries(fields
  .filter(field => value[field] !== undefined).map(field => [field, value[field]]));

/** Project mutable registry responses onto pinned versions and advisory IDs. */
export function normalizeFixture(contents: Buffer, fixture: Fixture): Buffer {
  if (!fixture.format) return contents;
  const data = JSON.parse(contents.toString());
  let normalized: unknown;
  if (fixture.format === 'npm-metadata') {
    const fields = ['name', 'version', 'dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta',
      'dependenciesMeta', 'bin', 'engines', 'os', 'cpu', 'libc', 'license', 'scripts', 'main', 'module', 'type', 'exports',
      'imports', 'installConfig', 'preferUnplugged'];
    const versions = Object.fromEntries(fixture.versions!.map(version => {
      const entry = data.versions?.[version];
      if (!entry?.dist) throw new Error(`Registry metadata is missing version ${version}`);
      return [version, { ...select(entry, fields), dist: select(entry.dist, ['tarball', 'integrity', 'shasum']) }];
    }));
    normalized = { name: data.name, versions, 'dist-tags': fixture.distTags };
  } else {
    const selected = new Set(fixture.advisoryIds);
    const found = new Set<number>();
    normalized = Object.fromEntries(Object.entries(data).map(([name, entries]) => {
      if (!Array.isArray(entries)) throw new Error(`Invalid audit response for ${name}`);
      return [name, entries.filter(entry => selected.has(entry.id)).sort((a, b) => a.id - b.id).map(entry => {
        found.add(entry.id);
        return select(entry, ['id', 'url', 'title', 'severity', 'vulnerable_versions', 'cwe', 'cvss']);
      })];
    }).filter(([, entries]) => (entries as unknown[]).length));
    if (found.size !== selected.size) throw new Error('Registry audit is missing pinned advisory IDs');
  }
  return Buffer.from(JSON.stringify(canonical(normalized), null, 2) + '\n');
}

interface BuildOptions {
  manifestPath?: string;
  directory?: string;
  fetcher?: typeof fetch;
  log?: (message: string) => void;
}

/** Build every asset from provenance without silently refreshing pinned data. */
export async function buildFixtures({
  manifestPath = fixtureManifest, directory = fixtureDirectory, fetcher = fetch, log = console.log,
}: BuildOptions = {}): Promise<void> {
  const manifest = await readFixtureManifest(manifestPath);
  for (const [name, fixture] of Object.entries(manifest)) {
    const destination = join(directory, name);
    await mkdir(dirname(destination), { recursive: true });
    let cached: Buffer | undefined;
    try { cached = await readFile(destination); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (cached && hasExpectedHash(cached, fixture)) {
      log(`Verified ${name} (cached)`);
      continue;
    }
    log(`Downloading ${name}`);
    const request: RequestInit = { signal: AbortSignal.timeout(30_000) };
    if (fixture.requestBody) {
      request.method = 'POST';
      request.headers = { 'content-type': 'application/json' };
      request.body = JSON.stringify(fixture.requestBody);
    }
    const response = await fetcher(fixture.url, request);
    if (!response.ok) throw new Error(`Could not download ${name}: HTTP ${response.status}`);
    const contents = normalizeFixture(Buffer.from(await response.arrayBuffer()), fixture);
    if (!hasExpectedHash(contents, fixture)) throw new Error(`SHA-256 mismatch for ${name}`);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, contents, { flag: 'wx' });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  log(`Fixtures ready: ${Object.keys(manifest).length}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await buildFixtures();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import semver from 'semver';
import { readFixture, readFixtureManifest } from './build-fixtures.js';

const fixtures = await readFixtureManifest();
export const bulk: Record<string, Record<string, unknown>[]> = {};
for (const [name, fixture] of Object.entries(fixtures)) {
  if (fixture.format === 'npm-audit') Object.assign(bulk, JSON.parse((await readFixture(name)).toString()));
}

/** Serve pinned metadata and downloaded npm archives; only the audit transport is simulated. */
export async function startRegistry() {
  const archives = new Map<string, Buffer>();
  const metadata = new Map<string, string>();
  for (const [name, fixture] of Object.entries(fixtures)) {
    if (name.endsWith('.tgz')) archives.set(name.split('/').at(-1)!, await readFixture(name));
    if (fixture.format === 'npm-metadata') {
      const data = (await readFixture(name)).toString();
      metadata.set(JSON.parse(data).name, data);
    }
  }
  let base = '';
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(req.url!.split('?')[0]!);
      requests.push(path);
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      let data = Buffer.concat(chunks);
      if (req.headers['content-encoding'] === 'gzip') data = gunzipSync(data);
      const body = data.length ? JSON.parse(data.toString()) : {};
      res.setHeader('content-type', 'application/json');
      if (path === '/-/npm/v1/security/advisories/bulk') {
        const result = Object.fromEntries(Object.entries(bulk).map(([name, values]) => [name,
          (values as Record<string, unknown>[]).filter(a => (body[name] ?? []).some((v: string) => semver.satisfies(v, String(a.vulnerable_versions)))),
        ]).filter(([, values]) => (values as unknown[]).length));
        res.end(JSON.stringify(result));
      } else if (path === '/-/npm/v1/security/audits/quick') {
        const installed = new Map<string, Set<string>>();
        const walk = (deps: Record<string, { version: string; dependencies?: Record<string, never> }>) => {
          for (const [name, dep] of Object.entries(deps)) {
            installed.set(name, new Set([...(installed.get(name) ?? []), dep.version]));
            walk(dep.dependencies ?? {});
          }
        };
        walk(body.dependencies ?? {});
        const advisories: Record<string, unknown> = {};
        for (const [name, values] of Object.entries(bulk)) {
          for (const a of values as Record<string, unknown>[]) {
            const affected = [...(installed.get(name) ?? [])].filter(v => semver.satisfies(v, String(a.vulnerable_versions)));
            if (affected.length) advisories[String(a.id)] = { ...a, module_name: name, findings: affected.map(version => ({ version, paths: [name] })) };
          }
        }
        res.end(JSON.stringify({ actions: [], advisories, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: Object.keys(advisories).length, critical: 0 }, dependencies: 6, devDependencies: 0, optionalDependencies: 0, totalDependencies: 6 } }));
      } else if (/^\/(?:tarballs|[\w.-]+\/-)\/[\w.-]+\.tgz$/.test(path)) {
        const tarball = archives.get(path.split('/').at(-1)!);
        if (!tarball) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'Unknown fixture archive' }));
          return;
        }
        res.setHeader('content-type', 'application/octet-stream');
        res.setHeader('content-length', tarball.length);
        res.end(tarball);
      } else if (metadata.has(path.slice(1))) {
        const name = path.slice(1);
        const info = JSON.parse(metadata.get(name)!);
        for (const [version, record] of Object.entries(info.versions)) {
          (record as { dist: { tarball: string } }).dist.tarball = `${base}/tarballs/${name}-${version}.tgz`;
        }
        res.end(JSON.stringify(info));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: `Unexpected registry request: ${path}` }));
      }
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Registry did not bind');
  base = `http://127.0.0.1:${address.port}`;
  return { url: base, requests, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

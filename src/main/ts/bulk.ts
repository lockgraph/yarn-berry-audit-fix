import semver from 'semver';
import { object, parseAudit, type Advisory } from './audit.js';
import { npmDescriptor, type Lockfile } from './lockfile.js';

export const publicAuditRegistry = 'https://registry.npmjs.org';

function npmLocator(locator: string): ReturnType<typeof npmDescriptor> {
  // Peel Yarn wrappers before reading the registry identity, including npm aliases.
  for (let depth = 0; depth < 20; depth++) {
    const npm = npmDescriptor(locator);
    if (npm) return npm;
    const match = /^((?:@[^/]+\/)?[^@/]+)@(virtual|patch):([^#]+)#/.exec(locator);
    if (!match) return undefined;
    locator = match[2] === 'virtual'
      ? `${match[1]}@${locator.slice(match[0].length)}`
      : decodeURIComponent(match[3]!);
  }
  throw new Error('Too many nested Yarn locator wrappers');
}

/** Include every locked npm version, regardless of its parents or workspace. */
export function bulkPackages(lock: Lockfile): Record<string, string[]> {
  const packages = new Map<string, Set<string>>();
  for (const entry of Object.values(lock)) {
    if (!entry.resolution) continue;
    const locator = npmLocator(entry.resolution);
    if (!locator) continue;
    if (!entry.version || !semver.valid(entry.version)) throw new Error(`Invalid npm package version: ${entry.resolution}`);
    const versions = packages.get(locator.name) ?? new Set<string>();
    versions.add(entry.version);
    packages.set(locator.name, versions);
  }
  return Object.fromEntries([...packages].map(([name, versions]) => [name, [...versions].sort(semver.compare)]));
}

export async function bulkAudit(lock: Lockfile, registry: string, signal?: AbortSignal): Promise<Advisory[]> {
  signal?.throwIfAborted();
  const packages = bulkPackages(lock);
  if (!Object.keys(packages).length) return [];
  const controller = new AbortController();
  const abort = () => controller.abort(signal!.reason);
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('Bulk audit timed out after 30 seconds')), 30_000);
  try {
    const response = await fetch(`${registry}/-/npm/v1/security/advisories/bulk`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(packages), signal: controller.signal, redirect: 'error',
    });
    if (!response.ok) throw new Error(`Bulk audit failed (HTTP ${response.status}): ${(await response.text()).slice(0, 512)}`);
    const data: unknown = await response.json();
    if (!object(data) || !Object.values(data).every(Array.isArray)) throw new Error('Invalid bulk audit response');
    return parseAudit(JSON.stringify(data));
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

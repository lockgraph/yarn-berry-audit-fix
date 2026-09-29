import semver from 'semver';

export interface Advisory {
  id: string;
  name: string;
  vulnerable: string;
  patched?: string;
  title?: string;
  url?: string;
}

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function jsonRecords(text: string): unknown[] {
  if (!text.trim()) return [];
  try { return [JSON.parse(text)]; } catch {
    return text.trim().split(/\r?\n/).map(line => JSON.parse(line) as unknown);
  }
}

function parseAdvisory(value: unknown, name?: string): Advisory {
  if (!object(value)) throw new Error('Invalid advisory');
  const advisory: Advisory = {
    id: String(value.id ?? value.source ?? ''),
    name: String(value.module_name ?? value.name ?? name ?? ''),
    vulnerable: String(value.vulnerable_versions ?? ''),
    ...(typeof value.patched_versions === 'string' ? { patched: value.patched_versions } : {}),
    ...(typeof value.title === 'string' ? { title: value.title } : {}),
    ...(typeof value.url === 'string' ? { url: value.url } : {}),
  };
  if (!advisory.id || !advisory.name || !semver.validRange(advisory.vulnerable) ||
      (advisory.patched !== undefined && !semver.validRange(advisory.patched))) {
    throw new Error('Invalid advisory identity or semver range');
  }
  return advisory;
}

function recordAdvisories(record: unknown): Advisory[] {
  if (!object(record)) throw new Error('Unrecognized audit response');
  if (record.type === 'error') throw new Error(`Yarn audit failed: ${String(record.data ?? record.displayName)}`);
  // Yarn 4 emits a success log when no vulnerabilities are present.
  if (record.type === 'info' || record.type === 'warning') return [];
  if (object(record.advisories)) return Object.values(record.advisories).map(value => parseAdvisory(value));
  if (typeof record.value === 'string' && object(record.children)) {
    const child = record.children;
    return [parseAdvisory({ id: child.ID, module_name: record.value, vulnerable_versions: child['Vulnerable Versions'], title: child.Issue, url: child.URL })];
  }
  if (record.type === 'auditAdvisory' && object(record.data)) return [parseAdvisory(record.data.advisory)];
  if (Object.values(record).every(Array.isArray)) {
    return Object.entries(record).flatMap(([name, values]) => (values as unknown[]).map(value => parseAdvisory(value, name)));
  }
  throw new Error('Unrecognized audit response; refusing to treat it as a clean audit');
}

/** Yarn 3's audit response, Yarn 4's tree NDJSON, and npm bulk responses. */
export function parseAudit(text: string): Advisory[] {
  const advisories = jsonRecords(text).flatMap(recordAdvisories);
  return [...new Map(advisories.map(advisory => [`${advisory.name}:${advisory.id}`, advisory])).values()];
}

export function isVulnerable(version: string, advisories: Advisory[]): boolean {
  return advisories.some(advisory => semver.satisfies(version, advisory.vulnerable, { includePrerelease: true }));
}

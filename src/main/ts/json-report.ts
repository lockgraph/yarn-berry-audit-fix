import type { Advisory } from './audit.js';
import type { AdvisoryDetails } from './advisory-details.js';
import type { FixResult } from './index.js';
import { packageVersion } from './package-version.js';

export interface JsonMetadata {
  schemaVersion: 1;
  toolVersion: string;
  generatedAt: string;
}

export interface JsonReport extends FixResult {
  meta: JsonMetadata;
  status: 'clean' | 'unfixed' | 'dry-run';
  summary: {
    applied: number;
    planned: number;
    skipped: number;
    advisories: { before: number; resolved: number; remaining: number; introduced: number };
  };
  resolved: Advisory[];
  introduced: Advisory[];
  cves: { resolved: string[]; remaining: string[]; introduced: string[]; complete: boolean };
}

export interface JsonFailure {
  meta: JsonMetadata;
  status: 'error' | 'interrupted';
  error: { message: string };
}

const unique = (values: string[]) => [...new Set(values)].sort();
const cves = (advisories: Advisory[]) => unique(advisories.flatMap(advisory => advisory.cves ?? []));
const difference = (values: string[], other: string[]) => values.filter(value => !other.includes(value));
const packageId = (advisory: Advisory) => `${advisory.name}:${advisory.id}`;

async function metadata(): Promise<JsonMetadata> {
  return { schemaVersion: 1, toolVersion: await packageVersion(), generatedAt: new Date().toISOString() };
}

/** Share known metadata across audit sources without changing their affected ranges. */
function normalize(result: FixResult) {
  const all = [...result.before, ...result.remaining, ...result.changes.flatMap(change => change.advisories)];
  const aliases = new Map(all.filter(advisory => advisory.ghsaId).map(advisory => [packageId(advisory), advisory.ghsaId!]));
  const ghsa = (advisory: Advisory) => advisory.ghsaId ?? aliases.get(packageId(advisory));
  const key = (advisory: Advisory) => `${advisory.name}:${ghsa(advisory) ?? advisory.id}`;
  const metadataKey = (advisory: Advisory) => ghsa(advisory) ?? packageId(advisory);
  const metadata = new Map<string, AdvisoryDetails>();
  for (const advisory of all) {
    const previous = metadata.get(metadataKey(advisory));
    metadata.set(metadataKey(advisory), {
      ghsaId: advisory.ghsaId ?? previous?.ghsaId,
      cvss: advisory.cvss ?? previous?.cvss,
      cves: advisory.cves === undefined ? previous?.cves : unique([...(previous?.cves ?? []), ...advisory.cves]),
    });
  }
  const enrich = (advisory: Advisory) => ({ ...advisory, ...metadata.get(metadataKey(advisory)) });
  const records = (advisories: Advisory[]) => {
    const byKey = new Map(advisories.map(advisory => [key(advisory), enrich(advisory)]));
    return [...byKey.keys()].sort().map(id => byKey.get(id)!);
  };
  return {
    key,
    result: { ...result, before: records(result.before), remaining: records(result.remaining),
      changes: result.changes.map(change => ({ ...change, advisories: records(change.advisories) })),
    },
  };
}

/** Global removals come from the final audit, never from an individual descriptor's bump. */
export async function createJsonReport(input: FixResult): Promise<JsonReport> {
  const { result, key } = normalize(input);
  const before = new Set(result.before.map(key));
  const after = new Set(result.remaining.map(key));
  const resolved = result.dryRun ? [] : result.before.filter(advisory => !after.has(key(advisory)));
  const introduced = result.dryRun ? [] : result.remaining.filter(advisory => !before.has(key(advisory)));
  const beforeCves = cves(result.before);
  const remainingCves = cves(result.remaining);
  return {
    ...result,
    meta: await metadata(),
    status: result.dryRun ? 'dry-run' : result.remaining.length ? 'unfixed' : 'clean',
    summary: {
      applied: result.dryRun ? 0 : result.changes.length,
      planned: result.dryRun ? result.changes.length : 0,
      skipped: result.skipped.length,
      advisories: { before: result.before.length, resolved: resolved.length, remaining: result.remaining.length, introduced: introduced.length },
    },
    resolved,
    introduced,
    cves: {
      resolved: result.dryRun ? [] : difference(beforeCves, remainingCves),
      remaining: remainingCves,
      introduced: result.dryRun ? [] : difference(remainingCves, beforeCves),
      complete: [...result.before, ...result.remaining].every(advisory => advisory.cves !== undefined),
    },
  };
}

export async function createJsonFailure(message: string, interrupted: boolean): Promise<JsonFailure> {
  return { meta: await metadata(), status: interrupted ? 'interrupted' : 'error', error: { message } };
}

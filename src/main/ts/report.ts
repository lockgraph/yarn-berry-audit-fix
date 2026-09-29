import { isVulnerable, type Advisory } from './audit.js';
import type { Change } from './plan.js';

export interface ReportedChange extends Change { advisories: Advisory[] }

/** Findings belong to this descriptor's old version, not every vulnerable branch of the package. */
export function describeChanges(changes: Change[], advisories: Advisory[]): ReportedChange[] {
  return changes.map(change => {
    const fixed = advisories.filter(advisory => advisory.name === change.name && isVulnerable(change.from, [advisory]) &&
      (change.removed || !isVulnerable(change.to, [advisory])));
    const unique = new Map<string, Advisory>();
    for (const advisory of fixed) {
      const key = advisory.ghsaId ?? advisory.id;
      unique.set(key, { ...unique.get(key), ...advisory });
    }
    return { ...change, advisories: [...unique.values()] };
  });
}

export function changeLines(change: ReportedChange, dryRun: boolean): string[] {
  const header = `${dryRun ? 'Would fix' : 'Fixed'} ${change.descriptor}: ${change.from} -> ${change.removed ? 'removed from graph' : change.to}`;
  return [header, ...change.advisories.map(advisory => {
    if (!advisory.cves?.length) return `  ${advisory.ghsaId ?? `advisory ${advisory.id}`}`;
    const score = advisory.cvss ? advisory.cvss.score.toFixed(1) : 'unavailable';
    return `  ${advisory.cves.join(', ')} (CVSS ${score})`;
  })];
}

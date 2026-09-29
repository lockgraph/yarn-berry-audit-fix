import { isVulnerable, type Advisory } from './audit.js';
import type { Change } from './plan.js';
import type { FixResult, InstallMode } from './index.js';

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

export function reportLines(result: FixResult, mode?: InstallMode): string[] {
  const lines = result.changes.flatMap(change => changeLines(change, result.dryRun));
  for (const skip of result.skipped) lines.push(`Skipped ${skip.descriptor}: ${skip.reason}`);
  if (result.dryRun) {
    const packages = new Set(result.changes.map(change => change.name)).size;
    lines.unshift(`Dry run: ${result.changes.length} planned fix(es) across ${packages} package(s); ${result.skipped.length} skipped request(s). No files changed.`);
    lines.push(`${result.before.length} advisory record(s) in the initial audit.`);
  } else {
    lines.push(`${result.remaining.length} advisory record(s) remaining.`);
    if (result.changed && mode === 'update-lockfile') lines.push('package.json restored; run yarn install to update the installed tree.');
  }
  return lines;
}

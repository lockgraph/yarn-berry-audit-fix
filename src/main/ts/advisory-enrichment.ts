import { advisoryDetails, type AdvisoryDetails } from './advisory-details.js';
import { object, type Advisory } from './audit.js';
import type { FixResult } from './index.js';
import type { ReportedChange } from './report.js';

async function githubDetails(id: string, signal: AbortSignal): Promise<AdvisoryDetails> {
  const response = await fetch(`https://api.github.com/advisories/${encodeURIComponent(id)}`, {
    headers: { accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, signal, redirect: 'error',
  });
  if (!response.ok) throw new Error(`GitHub advisory lookup failed (HTTP ${response.status})`);
  const data: unknown = await response.json();
  if (!object(data) || data.ghsa_id !== id) throw new Error('Invalid GitHub advisory response');
  return advisoryDetails(data);
}

async function loadDetails(ids: string[], signal: AbortSignal, details: Map<string, AdvisoryDetails>): Promise<boolean> {
  const queue = ids.values();
  let failed = false;
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
    for (const id of queue) {
      if (failed) return;
      try { details.set(id, await githubDetails(id, signal)); } catch { failed = true; }
    }
  }));
  return failed;
}

/** Optional display enrichment: its failure must not invalidate an already successful repair. */
async function enrichGroups(groups: Advisory[][], warnings: string[], signal?: AbortSignal): Promise<Advisory[][]> {
  const ids = [...new Set(groups.flat()
    .filter(advisory => advisory.cves === undefined || !advisory.cvss).flatMap(advisory => advisory.ghsaId ? [advisory.ghsaId] : []))];
  if (!ids.length) return groups;
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal!.reason);
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const details = new Map<string, AdvisoryDetails>();
  try {
    const failed = await loadDetails(ids, controller.signal, details);
    signal?.throwIfAborted();
    if (failed) warnings.push('Some CVE/CVSS details could not be loaded from GitHub; showing available advisory data');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
  return groups.map(advisories => advisories.map(advisory => ({
    ...details.get(advisory.ghsaId ?? ''), ...advisory,
  })));
}

export async function enrichChanges(changes: ReportedChange[], warnings: string[], signal?: AbortSignal): Promise<ReportedChange[]> {
  const groups = await enrichGroups(changes.map(change => change.advisories), warnings, signal);
  return changes.map((change, index) => ({ ...change, advisories: groups[index]! }));
}

export async function enrichReport(result: FixResult, signal?: AbortSignal): Promise<FixResult> {
  const groups = await enrichGroups([result.before, result.remaining, ...result.changes.map(change => change.advisories)], result.warnings, signal);
  return { ...result, before: groups[0]!, remaining: groups[1]!,
    changes: result.changes.map((change, index) => ({ ...change, advisories: groups[index + 2]! })),
  };
}

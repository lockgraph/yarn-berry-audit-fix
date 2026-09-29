import type { Advisory } from './audit.js';
import type { Plan } from './plan.js';

/** Audit proposed versions before touching the project; new findings may require another candidate. */
export async function verifiedPlan(
  before: Advisory[],
  create: (advisories: Advisory[]) => Plan,
  audit: (packages: Record<string, string[]>) => Promise<Advisory[]>,
  onProgress?: (message: string) => void,
) {
  const findings = new Map<string, Advisory>();
  const remember = (advisories: Advisory[]) => {
    for (const advisory of advisories) findings.set(JSON.stringify([advisory.name, advisory.id, advisory.vulnerable]), advisory);
  };
  remember(before);
  const checked = new Set<string>();
  for (;;) {
    const advisories = [...findings.values()];
    const plan = create(advisories);
    const pending = new Map<string, Set<string>>();
    for (const { name, to } of plan.changes) {
      if (checked.has(`${name}@${to}`)) continue;
      const versions = pending.get(name) ?? new Set<string>();
      versions.add(to);
      pending.set(name, versions);
    }
    if (!pending.size) return { plan, advisories };
    onProgress?.('Auditing proposed update versions');
    remember(await audit(Object.fromEntries([...pending].map(([name, versions]) => [name, [...versions]]))));
    for (const [name, versions] of pending) {
      for (const version of versions) checked.add(`${name}@${version}`);
    }
  }
}

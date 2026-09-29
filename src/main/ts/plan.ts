import semver from 'semver';
import { parseResolution } from '@yarnpkg/parsers';
import { isVulnerable, type Advisory } from './audit.js';
import { descriptors, npmDescriptor, type Lockfile } from './lockfile.js';

export interface Change { name: string; descriptor: string; from: string; to: string; removed?: boolean }
export interface Skipped { name: string; descriptor: string; version: string; reason: string }
export interface Plan { changes: Change[]; skipped: Skipped[]; resolutions: Record<string, string> }

export function createPlan(
  lock: Lockfile,
  advisories: Advisory[],
  versions: Record<string, string[]>,
  existingResolutions: Record<string, string> = {},
): Plan {
  const protectedNames = new Set(Object.keys(existingResolutions).map(key => parseResolution(key).descriptor.fullName));
  const plan: Plan = { changes: [], skipped: [], resolutions: {} };
  for (const [descriptor, entry] of descriptors(lock)) {
    if (!entry.version || !semver.valid(entry.version)) continue;
    const request = npmDescriptor(descriptor);
    // A non-npm descriptor (patch, git, alias...) may still resolve to a vulnerable npm package.
    const locator = entry.resolution && /^((?:@[^/]+\/)?[^@/]+)@/.exec(entry.resolution);
    const name = locator?.[1];
    if (!name) continue;
    const relevant = advisories.filter(advisory => advisory.name === name);
    if (!isVulnerable(entry.version, relevant)) continue;
    const skip = (reason: string) => plan.skipped.push({ name, descriptor, version: entry.version!, reason });
    if (protectedNames.has(name)) { skip('An existing resolution controls this package'); continue; }
    if (!request || request.name !== name || !semver.validRange(request.range) ||
        entry.resolution?.split('::')[0] !== `${name}@npm:${entry.version}`) {
      skip('Only plain npm semver descriptors are supported'); continue;
    }
    const candidate = (versions[name] ?? []).filter(version => semver.valid(version) &&
      !semver.prerelease(version) && semver.gt(version, entry.version!) &&
      semver.satisfies(version, request.range) && !isVulnerable(version, relevant))
      .sort(semver.compare)[0];
    if (!candidate) { skip('No published safe version satisfies the original dependency range'); continue; }
    plan.changes.push({ name, descriptor, from: entry.version, to: candidate });
    plan.resolutions[descriptor] = `npm:${candidate}`;
    // Yarn 2/3 match pre-normalized requests; Yarn 4 normalizes the npm: prefix.
    plan.resolutions[`${name}@${request.range}`] = `npm:${candidate}`;
  }
  return plan;
}

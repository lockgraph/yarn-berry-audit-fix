import semver from 'semver';
import { parseResolution } from '@yarnpkg/parsers';
import { isVulnerable, type Advisory } from './audit.js';
import { descriptors, npmDescriptor, type LockEntry, type Lockfile } from './lockfile.js';

export interface Change { name: string; descriptor: string; from: string; to: string; removed?: boolean }
export interface Skipped { name: string; descriptor: string; version: string; reason: string }
export interface Plan { changes: Change[]; skipped: Skipped[]; resolutions: Record<string, string> }
export type UpdatePolicy = 'lowest' | 'highest';

export function parsePolicy(value: unknown = 'lowest'): UpdatePolicy {
  if (value !== 'lowest' && value !== 'highest') throw new Error(`Unsupported update policy: ${String(value)}; use lowest or highest`);
  return value;
}

function supportedRequest(descriptor: string, entry: LockEntry, name: string) {
  const request = npmDescriptor(descriptor);
  if (!request || request.name !== name || !semver.validRange(request.range)) return undefined;
  if (entry.resolution?.split('::')[0] !== `${name}@npm:${entry.version}`) return undefined;
  return request;
}

function selectVersion(versions: string[], current: { version: string; range: string }, advisories: Advisory[], policy: UpdatePolicy) {
  return versions.filter(version => {
    if (!semver.valid(version) || semver.prerelease(version)) return false;
    return semver.gt(version, current.version) && semver.satisfies(version, current.range) && !isVulnerable(version, advisories);
  }).sort(policy === 'highest' ? semver.rcompare : semver.compare)[0];
}

function vulnerablePackage(entry: LockEntry, advisories: Advisory[]) {
  if (!entry.version || !semver.valid(entry.version)) return undefined;
  // A non-npm descriptor (patch, git, alias...) may still resolve to a vulnerable npm package.
  const locator = entry.resolution && /^((?:@[^/]+\/)?[^@/]+)@/.exec(entry.resolution);
  const name = locator?.[1];
  if (!name) return undefined;
  const relevant = advisories.filter(advisory => advisory.name === name);
  if (!isVulnerable(entry.version, relevant)) return undefined;
  return { name, version: entry.version, relevant };
}

export function createPlan(
  lock: Lockfile,
  advisories: Advisory[],
  versions: Record<string, string[]>,
  existingResolutions: Record<string, string> = {},
  policy: UpdatePolicy = 'lowest',
): Plan {
  parsePolicy(policy);
  const protectedNames = new Set(Object.keys(existingResolutions).map(key => parseResolution(key).descriptor.fullName));
  const plan: Plan = { changes: [], skipped: [], resolutions: {} };
  for (const [descriptor, entry] of descriptors(lock)) {
    const affected = vulnerablePackage(entry, advisories);
    if (!affected) continue;
    const { name, version, relevant } = affected;
    const skip = (reason: string) => plan.skipped.push({ name, descriptor, version, reason });
    if (protectedNames.has(name)) { skip('An existing resolution controls this package'); continue; }
    const request = supportedRequest(descriptor, entry, name);
    if (!request) {
      skip('Only plain npm semver descriptors are supported'); continue;
    }
    const candidate = selectVersion(versions[name] ?? [], { version, range: request.range }, relevant, policy);
    if (!candidate) { skip('No published safe version satisfies the original dependency range'); continue; }
    plan.changes.push({ name, descriptor, from: version, to: candidate });
    plan.resolutions[descriptor] = `npm:${candidate}`;
    // Yarn 2/3 match pre-normalized requests; Yarn 4 normalizes the npm: prefix.
    plan.resolutions[`${name}@${request.range}`] = `npm:${candidate}`;
  }
  return plan;
}

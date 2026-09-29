import semver from 'semver';
import { object } from './audit.js';
import { descriptors, npmDescriptor, parseLockfile } from './lockfile.js';
import type { Change } from './plan.js';

/** Restore request headers; every package record below them remains Yarn's output. */
export function restoreDescriptorHeaders(text: string, changes: Change[]): string {
  if (!changes.length) return text;
  const lock = parseLockfile(text);
  const entries = descriptors(lock);
  const requested = new Set<string>();
  // Read declarations in the newly generated records, including workspace manifests.
  // Old ranges may disappear, or new exact pins may appear, when a parent is upgraded.
  for (const entry of Object.values(lock)) {
    if (!object(entry.dependencies)) continue;
    for (const [name, range] of Object.entries(entry.dependencies)) {
      if (typeof range !== 'string') throw new Error(`Unsupported dependency declaration for ${name}`);
      requested.add(`${name}@${range.includes(':') ? range : `npm:${range}`}`);
    }
  }

  const replacements = new Map<string, Set<string>>();
  for (const change of changes) {
    const request = npmDescriptor(change.descriptor);
    if (!request || request.name !== change.name || !semver.satisfies(change.to, request.range)) {
      throw new Error(`Incompatible descriptor replacement: ${change.descriptor}`);
    }
    const target = `${change.name}@npm:${change.to}`;
    if (!requested.has(change.descriptor) && !entries.has(target)) continue;
    const generated = entries.get(target);
    if (!generated || generated.version !== change.to || generated.resolution?.split('::')[0] !== target) {
      throw new Error(`Yarn did not produce the requested resolution: ${target}`);
    }
    let originals = replacements.get(target);
    if (!originals) replacements.set(target, originals = new Set());
    if (requested.has(change.descriptor)) originals.add(change.descriptor);
  }

  const headers = [...text.matchAll(/^("(?:[^"\\\r\n]|\\.)*"|__metadata):(?:\r?\n|$)/gm)];
  if (headers.length !== Object.keys(lock).length || !headers.length) throw new Error('Unsupported lockfile header layout');
  const seen = new Set<string>();
  const blocks = headers.map((match, index) => {
    const key: string = match[1] === '__metadata' ? '__metadata' : JSON.parse(match[1]!);
    if (!Object.hasOwn(lock, key)) throw new Error(`Unrecognized lockfile header: ${key}`);
    const keys = new Set(key.split(/,\s+/));
    for (const descriptor of [...keys]) {
      const originals = replacements.get(descriptor);
      if (!originals) continue;
      if (!requested.has(descriptor)) keys.delete(descriptor);
      for (const original of originals) keys.add(original);
    }
    if (!keys.size) throw new Error(`Cannot restore any request for ${key}`);
    for (const descriptor of keys) {
      if (seen.has(descriptor)) throw new Error(`Conflicting descriptor after patch: ${descriptor}`);
      seen.add(descriptor);
    }
    const nextKey = [...keys].sort().join(', ');
    const header = nextKey === key ? match[0].trimEnd() : `${JSON.stringify(nextKey)}:`;
    const body = text.slice(match.index! + match[0].length, headers[index + 1]?.index ?? text.length).replace(/(?:\r?\n)+$/, '');
    return { key: nextKey, header, body };
  });
  // Yarn sorts records by their request keys; renaming can change their order.
  blocks.sort((a, b) => a.key === '__metadata' ? -1 : b.key === '__metadata' ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  return text.slice(0, headers[0]!.index) + blocks.map(block => `${block.header}${newline}${block.body}`).join(`${newline}${newline}`) + newline;
}

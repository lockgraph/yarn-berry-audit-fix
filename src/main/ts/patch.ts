import semver from 'semver';
import { object } from './audit.js';
import { descriptors, npmDescriptor, parseLockfile, type Lockfile } from './lockfile.js';
import type { Change } from './plan.js';

function requestedDescriptors(lock: Lockfile, catalogs: Record<string, string>): Set<string> {
  // Read declarations in the newly generated records, including workspace manifests.
  // Old ranges may disappear, or new exact pins may appear, when a parent is upgraded.
  const dependencies = Object.values(lock).flatMap(entry => object(entry.dependencies) ? Object.entries(entry.dependencies) : []);
  return new Set(dependencies.map(([name, range]) => {
    if (typeof range !== 'string') throw new Error(`Unsupported dependency declaration for ${name}`);
    const descriptor = `${name}@${range.includes(':') ? range : `npm:${range}`}`;
    return catalogs[descriptor] ?? descriptor;
  }));
}

function descriptorReplacements(lock: Lockfile, changes: Change[], requested: Set<string>): Map<string, Set<string>> {
  const entries = descriptors(lock);
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
    const originals = replacements.get(target) ?? new Set<string>();
    if (requested.has(change.descriptor)) originals.add(change.descriptor);
    replacements.set(target, originals);
  }
  return replacements;
}

interface LockBlock { key: string; header: string; body: string }

function lockBlocks(text: string, lock: Lockfile): { prefix: string; blocks: LockBlock[] } {
  // Native Yarn also emits plain legacy keys and YAML explicit keys longer than 1024 characters.
  const headers = [...text.matchAll(/^(?:("(?:[^"\\\r\n]|\\.)*"|[^\s"'?#][^\r\n]*):|\? ("(?:[^"\\\r\n]|\\.)*")\r?\n:|\?\r?\n[ \t]+("(?:[^"\\\r\n]|\\.)*")\r?\n:)(?:\r?\n|$)/gm)];
  if (headers.length !== Object.keys(lock).length || !headers.length) throw new Error('Unsupported lockfile header layout');
  const blocks = headers.map((match, index) => {
    const rawKey = (match[1] ?? match[2] ?? match[3])!;
    const key: string = rawKey.startsWith('"') ? JSON.parse(rawKey) : rawKey;
    if (!Object.hasOwn(lock, key)) throw new Error(`Unrecognized lockfile header: ${key}`);
    const body = text.slice(match.index! + match[0].length, headers[index + 1]?.index ?? text.length).replace(/(?:\r?\n)+$/, '');
    return { key, header: match[0].trimEnd(), body };
  });
  return { prefix: text.slice(0, headers[0]!.index), blocks };
}

function restoreKey(key: string, replacements: Map<string, Set<string>>, requested: Set<string>, seen: Set<string>): string[] {
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
  return [...keys].sort();
}

function compareBlocks(a: LockBlock, b: LockBlock): number {
  if (a.key === '__metadata') return -1;
  if (b.key === '__metadata') return 1;
  if (a.key < b.key) return -1;
  return a.key > b.key ? 1 : 0;
}

/** Restore request headers; every package record below them remains Yarn's output. */
export function restoreDescriptorHeaders(text: string, changes: Change[], catalogs: Record<string, string> = {}): string {
  if (!changes.length) return text;
  const lock = parseLockfile(text);
  const requested = requestedDescriptors(lock, catalogs);
  const replacements = descriptorReplacements(lock, changes, requested);
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const { prefix, blocks } = lockBlocks(text, lock);
  const seen = new Set<string>();
  for (const block of blocks) {
    const keys = restoreKey(block.key, replacements, requested, seen);
    const nextKey = keys.join(', ');
    if (nextKey === block.key) continue;
    const quoted = JSON.stringify(nextKey);
    block.header = quoted.length > 1024 ? `? ${quoted}${newline}:` : `${quoted}:`;
    block.key = nextKey;
  }
  // Yarn sorts records by their request keys; renaming can change their order.
  blocks.sort(compareBlocks);
  return prefix + blocks.map(block => `${block.header}${newline}${block.body}`).join(`${newline}${newline}`) + newline;
}

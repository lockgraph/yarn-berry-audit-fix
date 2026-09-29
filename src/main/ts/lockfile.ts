import { parseSyml } from '@yarnpkg/parsers';
import { object } from './audit.js';

export interface LockEntry {
  version?: string;
  resolution?: string;
  [key: string]: unknown;
}
export type Lockfile = Record<string, LockEntry>;

export function parseLockfile(text: string): Lockfile {
  const parsed: unknown = parseSyml(text);
  if (!object(parsed) || !object(parsed.__metadata)) {
    throw new Error('A Yarn Berry lockfile is required (Classic is not supported)');
  }
  if (Object.values(parsed).some(value => !object(value))) throw new Error('Invalid lockfile entry');
  return parsed as Lockfile;
}

export function descriptors(lock: Lockfile): Map<string, LockEntry> {
  return new Map(Object.entries(lock).filter(([key]) => key !== '__metadata')
    .flatMap(([key, entry]) => key.split(/,\s+/).map(descriptor => [descriptor, entry] as const)));
}

export function npmDescriptor(descriptor: string): { name: string; range: string } | undefined {
  const match = /^((?:@[^/]+\/)?[^@/]+)@npm:(.+)$/.exec(descriptor);
  return match ? { name: match[1]!, range: match[2]! } : undefined;
}

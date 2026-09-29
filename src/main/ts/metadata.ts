import { jsonRecords, object } from './audit.js';
import { requireSuccess, type CommandResult } from './yarn.js';

export function publishedVersions(stdout: string, names: readonly string[]): Record<string, string[]> {
  const records = new Map<string, Record<string, unknown>>();
  for (const record of jsonRecords(stdout)) {
    if (!object(record) || typeof record.name !== 'string') continue;
    if (records.has(record.name)) throw new Error(`Duplicate package metadata returned for ${record.name}`);
    records.set(record.name, record);
  }
  return Object.fromEntries(names.map(name => {
    const versions = records.get(name)?.versions;
    if (!Array.isArray(versions) || !versions.every(value => typeof value === 'string')) {
      throw new Error(`No published versions returned for ${name}`);
    }
    return [name, versions as string[]];
  }));
}

// Leave room for the executable path and flags within Windows' command-line limit.
const batchSize = 64;

export async function lookupVersions(
  names: Iterable<string>,
  run: (args: string[]) => Promise<CommandResult>,
  onProgress?: (message: string) => void,
): Promise<Record<string, string[]>> {
  const packages = [...new Set(names)];
  const versions: Record<string, string[]> = {};
  for (let offset = 0; offset < packages.length; offset += batchSize) {
    const batch = packages.slice(offset, offset + batchSize);
    onProgress?.(`Looking up published versions for ${batch.length} packages (${offset + batch.length}/${packages.length})`);
    const output = requireSuccess(await run(['npm', 'info', '--fields', 'name,versions', '--json', '--', ...batch]), 'Package metadata');
    Object.assign(versions, publishedVersions(output, batch));
  }
  return versions;
}

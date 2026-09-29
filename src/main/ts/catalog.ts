import semver from 'semver';
import { object } from './audit.js';
import type { Lockfile } from './lockfile.js';
import type { Plan } from './plan.js';
import { requireSuccess, type CommandResult } from './yarn.js';

function catalogRange(config: unknown, catalog: string, name: string): string {
  const entries = catalog && object(config) ? config[catalog] : config;
  const range = object(entries) ? entries[name] : undefined;
  const normalized = typeof range === 'string' ? range.replace(/^npm:/, '') : '';
  if (!normalized || !semver.validRange(normalized)) throw new Error(`Unsupported or missing catalog range: ${name}@catalog:${catalog}`);
  return normalized;
}

/** Yarn stores catalog requests in workspace records but resolves them to ordinary npm descriptors. */
export async function catalogDescriptors(
  lock: Lockfile,
  run: (args: string[]) => Promise<CommandResult>,
  names?: ReadonlySet<string>,
): Promise<Record<string, string>> {
  const requests = Object.values(lock).flatMap(entry => object(entry.dependencies) ? Object.entries(entry.dependencies) : [])
    .filter((pair): pair is [string, string] => typeof pair[1] === 'string' && pair[1].startsWith('catalog:'));
  const settings = new Map<string, unknown>();
  const result: Record<string, string> = {};
  for (const [name, request] of requests) {
    if (names && !names.has(name)) continue;
    const catalog = request.slice('catalog:'.length);
    const setting = catalog ? 'catalogs' : 'catalog';
    if (!settings.has(setting)) {
      const output = requireSuccess(await run(['config', 'get', setting, '--json']), 'Catalog configuration').trim();
      settings.set(setting, output === 'undefined' ? undefined : JSON.parse(output));
    }
    result[`${name}@${request}`] = `${name}@npm:${catalogRange(settings.get(setting), catalog, name)}`;
  }
  return result;
}

export function addCatalogResolutions(plan: Plan, catalogs: Record<string, string>): void {
  for (const [request, descriptor] of Object.entries(catalogs)) {
    const resolution = plan.resolutions[descriptor];
    if (resolution) plan.resolutions[request] = resolution;
  }
}

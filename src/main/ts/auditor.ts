import { bulkAudit, bulkPackages, publicAuditRegistry } from './bulk.js';
import type { Lockfile } from './lockfile.js';
import { auditResult, type CommandResult } from './yarn.js';

interface AuditOptions {
  registry?: string;
  yarnVersion: string;
  major: number;
  run: () => Promise<CommandResult>;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

function legacyWarning(lock: Lockfile, options: AuditOptions): string | undefined {
  if (options.major >= 4) return undefined;
  const duplicates = Object.entries(bulkPackages(lock)).filter(([, versions]) => versions.length > 1).map(([name]) => name).sort();
  if (duplicates.length) return `Yarn ${options.yarnVersion} legacy audit sends only one version per package name; findings may be incomplete for: ${duplicates.join(', ')}`;
}

/** Once native audit fails, reuse bulk for the rest of this repair. */
export function createAuditor(options: AuditOptions) {
  let registry = options.registry;
  const warnings: string[] = [];
  return {
    warnings,
    async read(lock: Lockfile) {
      options.signal?.throwIfAborted();
      if (registry) return bulkAudit(lock, registry, options.signal);
      let native: CommandResult;
      try {
        native = await options.run();
        const advisories = auditResult(native);
        const warning = legacyWarning(lock, options);
        if (warning && !warnings.includes(warning)) warnings.push(warning);
        return advisories;
      } catch (error) {
        options.signal?.throwIfAborted();
        registry = publicAuditRegistry;
        const warning = `Yarn audit failed; using bulk audit at ${registry} for this run`;
        warnings.push(warning);
        options.onProgress?.(warning);
        try { return await bulkAudit(lock, registry, options.signal); } catch (bulkError) {
          throw new AggregateError([error, bulkError], `Yarn audit and bulk fallback failed: ${String(error)}; ${String(bulkError)}`);
        }
      }
    },
  };
}

#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { fixAudit, createRunner } from './index.js';
import { parsePolicy } from './plan.js';
import { packageVersion } from './package-version.js';
import { reportLines } from './report.js';
import { enrichChanges, enrichReport } from './advisory-enrichment.js';
import { createJsonFailure, createJsonReport } from './json-report.js';
import { publicAuditRegistry } from './bulk.js';
import { parseAuditRegistry } from './yarn.js';

// Detect silence before strict parsing so invalid arguments can also fail quietly.
const silent = process.argv.slice(2).find(arg => arg === '--silent' || arg === '--') === '--silent';
const json = process.argv.slice(2).find(arg => arg === '--json' || arg === '--') === '--json';
const log = (message: string) => { if (!silent) console.log(message); };
const error = (message: unknown) => { if (!silent) console.error(message); };
// Node 18 emits experimental fetch warnings directly to stderr.
const warningListeners = silent ? process.listeners('warning') : [];
if (silent) process.removeAllListeners('warning');
const controller = new AbortController();
const onSignal = () => controller.abort(new Error('Interrupted'));
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);
try {
  const { values } = parseArgs({ options: {
    cwd: { type: 'string' },
    'dry-run': { type: 'boolean' },
    'yarn-path': { type: 'string' },
    'audit-registry': { type: 'string' },
    mode: { type: 'string' },
    policy: { type: 'string' },
    json: { type: 'boolean' },
    silent: { type: 'boolean' },
    'ignore-unfixed': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  } });
  if (values.help) {
    log(`Usage: yarn-berry-audit-fix [options]

Yarn 2.4+, 3.x / 4.0.1+. Installs compatible fixes by default.

  --cwd DIR                    Project root
  --dry-run                    Preview planned fixes without changing files
  --policy=lowest|highest      Compatible stable version policy (default: lowest)
  --mode=update-lockfile       Update only the lockfile (Yarn 3+)
  --audit-registry URL         Registry for direct bulk audits (Yarn 2/3/4)
  --ignore-unfixed             Exit 0 when advisories remain; execution errors still fail
  --json                       Print a machine-readable digest, including resolved CVEs
  --silent                     Print nothing; preserve exit codes
  --yarn-path FILE             Yarn JavaScript bundle
  -h, --help                   Show this help
  -v, --version                Show the installed tool version

Exit codes: 0 = success/dry run, 1 = remaining advisories, 2 = execution error, 130 = interrupted.`);
  } else if (values.version) {
    log(await packageVersion());
  } else {
    if (values.mode !== undefined && values.mode !== 'update-lockfile') throw new Error(`Unsupported install mode: ${values.mode}`);
    let result = await fixAudit({
      cwd: values.cwd,
      dryRun: values['dry-run'],
      mode: values.mode,
      policy: parsePolicy(values.policy),
      auditRegistry: parseAuditRegistry(values['audit-registry']),
      runner: values['yarn-path'] ? createRunner([process.execPath, resolve(values['yarn-path'])]) : undefined,
      signal: controller.signal,
      onProgress: error,
    });
    if (!silent) {
      if (!values['audit-registry'] || parseAuditRegistry(values['audit-registry']) === publicAuditRegistry) {
        if (values.json) result = await enrichReport(result, controller.signal);
        else result.changes = await enrichChanges(result.changes, result.warnings, controller.signal);
      }
      for (const warning of result.warnings) error(`Warning: ${warning}`);
      if (values.json) log(JSON.stringify(await createJsonReport(result), null, 2));
      else for (const line of reportLines(result, values.mode)) log(line);
    }
    process.exitCode = !values['ignore-unfixed'] && !result.dryRun && result.remaining.length ? 1 : 0;
  }
} catch (failure) {
  const message = failure instanceof Error ? failure.message : String(failure);
  if (json) log(JSON.stringify(await createJsonFailure(message, controller.signal.aborted), null, 2));
  else error(message);
  process.exitCode = controller.signal.aborted ? 130 : 2;
} finally {
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  for (const listener of warningListeners) process.on('warning', listener);
}

#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { fixAudit, createRunner } from './index.js';
import { parsePolicy } from './plan.js';
import { packageVersion } from './package-version.js';
import { changeLines } from './report.js';
import { enrichChanges } from './advisory-enrichment.js';
import { publicAuditRegistry } from './bulk.js';
import { parseAuditRegistry } from './yarn.js';

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
    'ignore-unfixed': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  } });
  if (values.help) {
    console.log(`Usage: yarn-berry-audit-fix [options]

Yarn 2.4+, 3.x / 4.0.1+. Installs compatible fixes by default.

  --cwd DIR                    Project root
  --dry-run                    Preview fixes without installing
  --policy=lowest|highest      Compatible stable version policy (default: lowest)
  --mode=update-lockfile       Update only the lockfile (Yarn 3+)
  --audit-registry URL         Registry for direct bulk audits (Yarn 2/3/4)
  --ignore-unfixed             Exit 0 when advisories remain; execution errors still fail
  --json                       Print the report as JSON
  --yarn-path FILE             Yarn JavaScript bundle
  -h, --help                   Show this help
  -v, --version                Show the installed tool version

Exit codes: 0 = success/dry run, 1 = remaining advisories, 2 = execution error, 130 = interrupted.`);
  } else if (values.version) {
    console.log(await packageVersion());
  } else {
    if (values.mode !== undefined && values.mode !== 'update-lockfile') throw new Error(`Unsupported install mode: ${values.mode}`);
    const result = await fixAudit({
      cwd: values.cwd,
      dryRun: values['dry-run'],
      mode: values.mode,
      policy: parsePolicy(values.policy),
      auditRegistry: parseAuditRegistry(values['audit-registry']),
      runner: values['yarn-path'] ? createRunner([process.execPath, resolve(values['yarn-path'])]) : undefined,
      signal: controller.signal,
      onProgress: message => console.error(message),
    });
    if (!values['audit-registry'] || parseAuditRegistry(values['audit-registry']) === publicAuditRegistry) {
      result.changes = await enrichChanges(result.changes, result.warnings, controller.signal);
    }
    for (const warning of result.warnings) console.error(`Warning: ${warning}`);
    if (values.json) console.log(JSON.stringify(result, null, 2));
    else {
      for (const change of result.changes) for (const line of changeLines(change, result.dryRun)) console.log(line);
      for (const skip of result.skipped) console.log(`Skipped ${skip.descriptor}: ${skip.reason}`);
      console.log(`${result.remaining.length} advisory record(s) ${result.dryRun ? 'in the initial audit' : 'remaining'}.`);
      if (!result.dryRun && result.changed && values.mode === 'update-lockfile') console.log('package.json restored; run yarn install to update the installed tree.');
    }
    process.exitCode = !values['ignore-unfixed'] && !result.dryRun && result.remaining.length ? 1 : 0;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = controller.signal.aborted ? 130 : 2;
} finally {
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
}

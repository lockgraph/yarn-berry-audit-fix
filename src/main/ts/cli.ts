#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { fixAudit, createRunner } from './index.js';
import { parsePolicy } from './plan.js';

const controller = new AbortController();
const onSignal = () => controller.abort(new Error('Interrupted'));
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);
try {
  const { values } = parseArgs({ options: {
    cwd: { type: 'string' },
    'dry-run': { type: 'boolean' },
    'yarn-path': { type: 'string' },
    mode: { type: 'string' },
    policy: { type: 'string' },
    json: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('Usage: yarn-berry-audit-fix [--cwd DIR] [--dry-run] [--policy=lowest|highest] [--mode=update-lockfile] [--json] [--yarn-path yarn.cjs]\n\nYarn 2.4+, 3.x / 4.0.1+. Installs compatible fixes by default.\n--policy selects the lowest (default) or highest compatible stable fix.\n--mode=update-lockfile updates only the lockfile (Yarn 3+).');
  } else {
    if (values.mode !== undefined && values.mode !== 'update-lockfile') throw new Error(`Unsupported install mode: ${values.mode}`);
    const result = await fixAudit({
      cwd: values.cwd,
      dryRun: values['dry-run'],
      mode: values.mode,
      policy: parsePolicy(values.policy),
      runner: values['yarn-path'] ? createRunner([process.execPath, resolve(values['yarn-path'])]) : undefined,
      signal: controller.signal,
      onProgress: message => console.error(message),
    });
    for (const warning of result.warnings) console.error(`Warning: ${warning}`);
    if (values.json) console.log(JSON.stringify(result, null, 2));
    else {
      for (const change of result.changes) console.log(`${result.dryRun ? 'Would fix' : 'Fixed'} ${change.descriptor}: ${change.from} -> ${change.removed ? 'removed from graph' : change.to}`);
      for (const skip of result.skipped) console.log(`Skipped ${skip.descriptor}: ${skip.reason}`);
      console.log(`${result.remaining.length} advisory record(s) ${result.dryRun ? 'in the initial audit' : 'remaining'}.`);
      if (!result.dryRun && result.changed && values.mode === 'update-lockfile') console.log('package.json restored; run yarn install to update the installed tree.');
    }
    process.exitCode = !result.dryRun && result.remaining.length ? 1 : 0;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = controller.signal.aborted ? 130 : 2;
} finally {
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
}

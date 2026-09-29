import { spawn } from 'node:child_process';
import semver from 'semver';
import { jsonRecords, object, parseAudit, type Advisory } from './audit.js';

export interface CommandResult { code: number; stdout: string; stderr: string }
export type Runner = (args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal }) => Promise<CommandResult>;

export function createRunner(command: readonly [string, ...string[]] = ['yarn']): Runner {
  return (args, options) => new Promise((resolve, reject) => {
    const child = spawn(command[0], [...command.slice(1), ...args], { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let failure: Error | undefined;
    let bytes = 0;
    const collect = (output: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024 * 1024) {
        failure = new Error('Yarn output exceeded 64 MiB');
        child.kill();
      } else output.push(chunk);
    };
    child.stdout.on('data', chunk => collect(stdout, chunk));
    child.stderr.on('data', chunk => collect(stderr, chunk));
    child.on('error', error => { failure = error; });
    // An abort emits error before exit. Wait for close before allowing rollback to write files.
    child.on('close', (code, signal) => {
      if (failure) reject(failure);
      else if (code === null) reject(new Error(`Yarn terminated by ${signal}`));
      else resolve({ code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() });
    });
  });
}

export function requireSuccess(result: CommandResult, action: string): string {
  if (result.code !== 0) throw new Error(`${action} failed (${result.code}):\n${result.stderr || result.stdout}`);
  return result.stdout;
}

export function supportedYarn(version: string): number {
  if (!semver.valid(version) || !semver.satisfies(version, '>=2.4.0 <5.0.0') || version === '4.0.0') {
    throw new Error(`Unsupported Yarn ${version}; use Yarn 2.4+, 3.x or >=4.0.1 <5 (Yarn 2.4 introduced npm audit)`);
  }
  return semver.major(version);
}

export type InstallMode = 'update-lockfile';

export function yarnCommands(version: string, mode?: InstallMode) {
  const major = supportedYarn(version);
  if (mode !== undefined && mode !== 'update-lockfile') throw new Error(`Unsupported install mode: ${mode}`);
  if (mode === 'update-lockfile' && major === 2) {
    throw new Error(`Yarn ${version} does not support --mode=update-lockfile; use a normal install or Yarn 3+`);
  }
  return {
    major,
    audit: ['npm', 'audit', '--all', '--recursive', '--json', ...(major >= 4 ? ['--no-deprecations'] : [])],
    install: ['install', ...(mode ? [`--mode=${mode}`] : [])],
  };
}

export function auditResult(result: CommandResult): Advisory[] {
  if (result.code !== 0 && result.code !== 1) requireSuccess(result, 'Audit');
  const advisories = parseAudit(result.stdout);
  if (result.code !== 0 && !advisories.length) requireSuccess(result, 'Audit');
  return advisories;
}

export function publishedVersions(stdout: string, name: string): string[] {
  const records = jsonRecords(stdout);
  const info = records.find(value => object(value) && value.name === name);
  if (!object(info) || !Array.isArray(info.versions) || !info.versions.every(value => typeof value === 'string')) {
    throw new Error(`No published versions returned for ${name}`);
  }
  return info.versions as string[];
}

import { expect, it } from 'vitest';
import { createRunner } from '../../main/ts/yarn.js';

const options = { cwd: process.cwd(), env: { ...process.env, BERRY_RUNNER_TEST: 'custom environment' } };
const node = createRunner([process.execPath, '-e']);

it('captures both output streams, the exit status and the supplied environment', async () => {
  const result = await node(['console.log(process.cwd()); console.error(process.env.BERRY_RUNNER_TEST); process.exitCode = 7'], options);
  expect(result).toEqual({ code: 7, stdout: `${options.cwd}\n`, stderr: 'custom environment\n' });
});

it('rejects a missing executable with its original spawn error', async () => {
  await expect(createRunner(['berry-nonexistent-test-executable'])([], options)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('reports termination by signal instead of treating it as a successful exit', async () => {
  await expect(node(['process.kill(process.pid, "SIGTERM")'], options)).rejects.toThrow('Yarn terminated by SIGTERM');
});

it('terminates a child that exceeds the output limit', async () => {
  await expect(node(['process.stdout.write(Buffer.alloc(65 * 1024 * 1024, "x"))'], options)).rejects.toThrow('Yarn output exceeded 64 MiB');
});

it('rejects a command when its signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(node(['setInterval(() => {}, 1000)'], { ...options, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
});

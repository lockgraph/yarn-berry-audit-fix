import { expect, it, vi } from 'vitest';
import { lookupVersions, publishedVersions } from '../../main/ts/metadata.js';
import type { CommandResult } from '../../main/ts/yarn.js';

const output = (records: unknown[]): CommandResult => ({ code: 0, stdout: records.map(record => JSON.stringify(record)).join('\n'), stderr: '' });
const info = (name: string) => ({ name, versions: ['1.0.0', '1.2.3'] });

it('batches unique package names and associates unordered NDJSON records by name, including scopes', async () => {
  const run = vi.fn().mockResolvedValue(output([{ type: 'warning', data: 'Registry notice' }, info('@scope/foo'), info('bar')]));
  const progress = vi.fn();
  expect(await lookupVersions(['bar', '@scope/foo', 'bar'], run, progress)).toEqual({ bar: ['1.0.0', '1.2.3'], '@scope/foo': ['1.0.0', '1.2.3'] });
  expect(run.mock.calls).toEqual([[['npm', 'info', '--fields', 'name,versions', '--json', '--', 'bar', '@scope/foo']]]);
  expect(progress).toHaveBeenCalledExactlyOnceWith('Looking up published versions for 2 packages (2/2)');
});

it('splits large inventories into bounded commands without dropping or duplicating packages', async () => {
  const names = Array.from({ length: 130 }, (_, index) => `package-${index}`);
  const run = vi.fn(async (args: string[]) => output(args.slice(args.indexOf('--') + 1).map(info)));
  const versions = await lookupVersions(names, run);
  const batches = run.mock.calls.map(([args]) => args.slice(args.indexOf('--') + 1));
  expect(batches.map(batch => batch.length)).toEqual([64, 64, 2]);
  expect(batches.flat()).toEqual(names);
  expect(Object.keys(versions)).toEqual(names);
});

it('does not run Yarn or report metadata progress for a clean audit', async () => {
  const run = vi.fn();
  const progress = vi.fn();
  expect(await lookupVersions([], run, progress)).toEqual({});
  expect(run).not.toHaveBeenCalled();
  expect(progress).not.toHaveBeenCalled();
});

it.each(['', '{}', 'null', '{"name":"foo"}', '{"name":"foo","versions":123}', '{"name":"foo","versions":[1]}'])('rejects missing or malformed package versions: %s', stdout => {
  expect(() => publishedVersions(stdout, ['foo'])).toThrow('No published versions returned for foo');
});

it('rejects partial batches, duplicate identities and malformed JSON', () => {
  expect(() => publishedVersions(output([info('foo')]).stdout, ['foo', 'bar'])).toThrow('No published versions returned for bar');
  expect(() => publishedVersions(output([info('foo'), info('foo')]).stdout, ['foo'])).toThrow('Duplicate package metadata returned for foo');
  expect(() => publishedVersions('not JSON', ['foo'])).toThrow(SyntaxError);
});

it('stops at a failed batch and retains Yarn diagnostics despite partial metadata output', async () => {
  const run = vi.fn().mockResolvedValue({ ...output([info('package-0')]), code: 1, stderr: 'Registry access denied' });
  await expect(lookupVersions(Array.from({ length: 65 }, (_, index) => `package-${index}`), run)).rejects.toThrow('Package metadata failed (1):\nRegistry access denied');
  expect(run).toHaveBeenCalledTimes(1);
});

it('propagates cancellation without starting another batch', async () => {
  const error = new Error('Cancelled metadata request');
  const run = vi.fn().mockRejectedValue(error);
  await expect(lookupVersions(Array.from({ length: 65 }, (_, index) => `package-${index}`), run)).rejects.toBe(error);
  expect(run).toHaveBeenCalledTimes(1);
});

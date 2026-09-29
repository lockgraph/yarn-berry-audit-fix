import { expect, it, vi } from 'vitest';
import { addCatalogResolutions, catalogDescriptors } from '../../main/ts/catalog.js';
import { createPlan } from '../../main/ts/plan.js';
import type { CommandResult } from '../../main/ts/yarn.js';

const workspace = (dependencies: Record<string, unknown>) => ({ resolution: 'fixture@workspace:.', dependencies });
const success = (value: unknown): CommandResult => ({ code: 0, stdout: JSON.stringify(value) ?? 'undefined', stderr: '' });

it('normalizes scoped and npm-prefixed catalog ranges and reads each effective Yarn setting only once', async () => {
  const run = vi.fn(async (args: string[]) => success(args[2] === 'catalog' ? { '@scope/foo': 'npm:^1' } : { next: { '@scope/foo': '~2.1.0' } }));
  const lock = {
    __metadata: {},
    root: workspace({ '@scope/foo': 'catalog:', ordinary: 'npm:^1' }),
    child: workspace({ '@scope/foo': 'catalog:next' }),
    duplicate: workspace({ '@scope/foo': 'catalog:' }),
    'foo@npm:^1': { version: '1.0.0', resolution: 'foo@npm:1.0.0' },
  };
  expect(await catalogDescriptors(lock, run)).toEqual({ '@scope/foo@catalog:': '@scope/foo@npm:^1', '@scope/foo@catalog:next': '@scope/foo@npm:~2.1.0' });
  expect(run.mock.calls).toEqual([[['config', 'get', 'catalog', '--json']], [['config', 'get', 'catalogs', '--json']]]);
});

it.each([undefined, null, [], {}, { foo: 123 }, { foo: 'latest' }, { foo: 'patch:foo@1#fix.patch' }])('fails closed for an unresolved or non-semver catalog: %j', async config => {
  await expect(catalogDescriptors({ root: workspace({ foo: 'catalog:' }) }, async () => success(config)))
    .rejects.toThrow('Unsupported or missing catalog range: foo@catalog:');
});

it('reports a missing named catalog and a failed native configuration query', async () => {
  const lock = { root: workspace({ foo: 'catalog:missing' }) };
  await expect(catalogDescriptors(lock, async () => success({}))).rejects.toThrow('missing catalog range');
  await expect(catalogDescriptors(lock, async () => ({ code: 1, stdout: '', stderr: 'Cannot read config' }))).rejects.toThrow('Cannot read config');
});

it('does not add catalog overrides for a package controlled by existing resolutions', () => {
  const lock = { 'foo@npm:^1': { version: '1.0.0', resolution: 'foo@npm:1.0.0' } };
  const plan = createPlan(lock, [{ name: 'foo', id: '1', vulnerable: '<1.1.0' }], { foo: ['1.1.0'] }, { 'foo@catalog:': 'npm:1.0.0' });
  addCatalogResolutions(plan, { 'foo@catalog:': 'foo@npm:^1' });
  expect(plan.changes).toEqual([]);
  expect(plan.resolutions).toEqual({});
});

it('does not read unrelated catalogs when only other packages can be updated', async () => {
  const run = vi.fn();
  expect(await catalogDescriptors({ root: workspace({ foo: 'catalog:' }) }, run, new Set(['bar']))).toEqual({});
  expect(run).not.toHaveBeenCalled();
});

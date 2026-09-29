import { expect, it, vi } from 'vitest';
import type { Advisory } from '../../main/ts/audit.js';
import { createPlan } from '../../main/ts/plan.js';
import { verifiedPlan } from '../../main/ts/planning.js';

const before: Advisory[] = [{ name: 'tmp', id: 'initial', vulnerable: '<0.2.6' }];
const lock = {
  __metadata: {},
  'tmp@npm:~0.2.1, tmp@npm:^0.2.1': { version: '0.2.1', resolution: 'tmp@npm:0.2.1' },
  'tmp@npm:^1': { version: '1.0.0', resolution: 'tmp@npm:1.0.0' },
};
const versions = { tmp: ['0.2.1', '0.2.6', '0.2.7', '0.2.8', '0.2.9-beta.1', '1.0.0', '1.0.1'] };

it.each([
  { policy: 'lowest' as const, rejected: '0.2.6', selected: '0.2.7' },
  { policy: 'highest' as const, rejected: '0.2.8', selected: '0.2.7' },
])('replans $policy candidates independently without reauditing accepted branches', async ({ policy, rejected, selected }) => {
  const initial = [...before, { name: 'tmp', id: 'other-branch', vulnerable: '1.0.0' }];
  const hidden = { name: 'tmp', id: 'candidate-only', vulnerable: rejected };
  const audit = vi.fn().mockResolvedValueOnce([hidden]).mockResolvedValueOnce([]);
  const result = await verifiedPlan(initial, findings => createPlan(lock, findings, versions, {}, policy), audit);
  expect(audit.mock.calls).toEqual([[{ tmp: [rejected, '1.0.1'] }], [{ tmp: [selected] }]]);
  expect(result.plan.changes.map(change => change.to)).toEqual([selected, selected, '1.0.1']);
  expect(result.advisories).toEqual([...initial, hidden]);
  expect(initial).toHaveLength(2);
});

it('accumulates revised ranges with the same advisory ID and terminates when no compatible candidate remains', async () => {
  const audit = vi.fn()
    .mockResolvedValueOnce([{ ...before[0], vulnerable: '0.2.6' }])
    .mockResolvedValueOnce([{ ...before[0], vulnerable: '>=0.2.7 <0.3' }]);
  const result = await verifiedPlan(before, findings => createPlan(lock, findings, versions), audit);
  expect(audit.mock.calls).toEqual([[{ tmp: ['0.2.6'] }], [{ tmp: ['0.2.7'] }]]);
  expect(result.plan.changes).toEqual([]);
  expect(result.plan.skipped).toHaveLength(2);
  expect(result.advisories).toHaveLength(3);
});

it('does not request a candidate audit for protected packages or unsatisfiable ranges', async () => {
  const audit = vi.fn();
  const result = await verifiedPlan(before, findings => createPlan(lock, findings, versions, { tmp: '0.2.1' }), audit);
  expect(result.plan.changes).toEqual([]);
  expect(audit).not.toHaveBeenCalled();
});

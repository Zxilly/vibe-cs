import { describe, expect, it, vi } from 'vitest';

import { ProposalMutationBusyError, ProposalMutationCoordinator } from './proposalMutation';

describe('ProposalMutationCoordinator', () => {
  it('keeps the full-page lock until a deferred mutation settles', async () => {
    let resolve!: (value: string) => void;
    const deferred = new Promise<string>((next) => { resolve = next; });
    const coordinator = new ProposalMutationCoordinator();
    const states: Array<string | null> = [];
    coordinator.subscribe((owner) => states.push(owner));

    const first = coordinator.run('proposal-a', () => deferred);
    expect(coordinator.activeOwner).toBe('proposal-a');
    await expect(coordinator.run('proposal-b', vi.fn(async () => 'second')))
      .rejects.toBeInstanceOf(ProposalMutationBusyError);
    expect(coordinator.activeOwner).toBe('proposal-a');

    resolve('complete');
    await expect(first).resolves.toBe('complete');
    expect(coordinator.activeOwner).toBeNull();
    expect(states).toEqual([null, 'proposal-a', null]);
  });

  it('releases the lock after a visible operation failure', async () => {
    const coordinator = new ProposalMutationCoordinator();
    await expect(coordinator.run('proposal-a', async () => {
      throw new Error('export failed');
    })).rejects.toThrow('export failed');
    expect(coordinator.activeOwner).toBeNull();
  });
});

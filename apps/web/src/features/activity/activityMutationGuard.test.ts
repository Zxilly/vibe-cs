import { describe, expect, it } from 'vitest';

import { createActivityMutationGuard } from './activityMutationGuard';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

describe('activity mutation UI guard', () => {
  it('lets the background mutation settle without hijacking a newer selection', async () => {
    const guard = createActivityMutationGuard();
    const oldActivity = 'analysis:11111111-1111-4111-8111-111111111111';
    const newActivity = 'export:22222222-2222-4222-8222-222222222222';
    guard.setContext(oldActivity);
    const lease = guard.begin(oldActivity);
    const pending = deferred<string>();
    const applied = pending.promise.then((value) => guard.canApply(lease) ? value : null);

    guard.setContext(newActivity);
    pending.resolve('analysis:33333333-3333-4333-8333-333333333333');

    await expect(applied).resolves.toBeNull();
    expect(guard.isLatest(lease)).toBe(false);
  });

  it('drops a late result after the Activity page unmounts', async () => {
    const guard = createActivityMutationGuard();
    const activityId = 'download:11111111-1111-4111-8111-111111111111';
    guard.setContext(activityId);
    const lease = guard.begin(activityId);
    const pending = deferred<string>();
    const applied = pending.promise.then((value) => guard.canApply(lease) ? value : null);

    guard.dispose();
    pending.resolve('download:22222222-2222-4222-8222-222222222222');

    await expect(applied).resolves.toBeNull();
    expect(guard.isLatest(lease)).toBe(false);
  });
});

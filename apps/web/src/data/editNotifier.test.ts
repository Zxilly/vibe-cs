/*
 * `unit` project — §4.5.4's merge window, driven by hand.
 *
 * The scheduler is injected, so the five-second window is five ticks of a
 * counter here and the suite never sleeps.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  EDIT_FLUSH_REASONS,
  EDIT_MERGE_WINDOW_MS,
  createEditNotifier,
  mergeEditChanges,
  type EditFlushReason,
  type EditNotifierScheduler,
  type PendingPlanEdit,
} from './editNotifier';
import type { AgentPlanShot, WorkspaceEditChange } from '../shared/desktop/dto';

function shot(id: string): AgentPlanShot {
  return {
    id,
    title: '跟随突破',
    kind: 'tracking',
    view: 'observer',
    start_tick: 148_812,
    end_tick: 149_356,
    duration_seconds: 8.5,
    rationale: '沿他的真实移动轴从中路跟到 A 大道',
    evidence_refs: [],
    risks: [],
    source: 'agent',
    removed_by: null,
    params: null,
  };
}

function change(overrides: Partial<WorkspaceEditChange> = {}): WorkspaceEditChange {
  return {
    shot: 2,
    op: 'updated',
    field: 'duration',
    from: '8.5s',
    to: '5.0s',
    ...overrides,
  };
}

/** A scheduler whose only clock is `advance`. */
function manualScheduler() {
  let now = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  let nextHandle = 1;

  const scheduler: EditNotifierScheduler = {
    setTimeout: (callback, ms) => {
      const handle = nextHandle++;
      timers.set(handle, { at: now + ms, run: callback });
      return handle;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
    now: () => now,
  };

  return {
    scheduler,
    pending: () => timers.size,
    advance: (ms: number) => {
      now += ms;
      for (const [handle, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(handle);
          timer.run();
        }
      }
    },
  };
}

describe('mergeEditChanges', () => {
  it('keeps the first from and the last to for one shot and field', () => {
    const merged = [
      change({ from: '8.5s', to: '6.0s' }),
      change({ from: '6.0s', to: '5.5s' }),
      change({ from: '5.5s', to: '5.0s' }),
    ].reduce<WorkspaceEditChange[]>((acc, next) => mergeEditChanges(acc, next), []);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ shot: 2, field: 'duration', from: '8.5s', to: '5.0s' });
  });

  it('keeps different fields of the same shot apart', () => {
    const merged = [
      change({ field: 'duration' }),
      change({ field: 'kind', from: 'Dolly', to: 'Tracking' }),
    ].reduce<WorkspaceEditChange[]>((acc, next) => mergeEditChanges(acc, next), []);

    expect(merged.map((item) => item.field)).toEqual(['duration', 'kind']);
  });

  it('keeps the same field of different shots apart', () => {
    const merged = [change({ shot: 2 }), change({ shot: 4 })].reduce<WorkspaceEditChange[]>(
      (acc, next) => mergeEditChanges(acc, next),
      [],
    );

    expect(merged.map((item) => item.shot)).toEqual([2, 4]);
  });

  it('never merges a removal into a field edit of the same shot', () => {
    const merged = [
      change({ shot: 4, field: 'duration' }),
      change({ shot: 4, op: 'removed', field: null, from: null, to: null }),
    ].reduce<WorkspaceEditChange[]>((acc, next) => mergeEditChanges(acc, next), []);

    expect(merged).toHaveLength(2);
    expect(merged[1]?.op).toBe('removed');
  });

  it('lets the newest op win for one field, keeping the original from', () => {
    const merged = mergeEditChanges(
      [change({ from: '8.5s', to: '5.0s' })],
      change({ op: 'restored', from: '5.0s', to: '8.5s' }),
    );

    // 8.5 → 5.0 → 8.5 is a round trip and collapses to nothing.
    expect(merged).toEqual([]);
  });

  it('drops an edit that ended where it started', () => {
    const merged = mergeEditChanges([], change({ from: '8.5s', to: '8.5s' }));
    expect(merged).toEqual([]);
  });

  it('never drops a removal, which has no from/to pair', () => {
    const merged = mergeEditChanges([], change({ op: 'removed', field: null, from: null, to: null }));
    expect(merged).toHaveLength(1);
  });
});

describe('the merge window', () => {
  function setup(options: { windowMs?: number } = {}) {
    const clock = manualScheduler();
    const commits: Array<{ pending: PendingPlanEdit; reason: EditFlushReason }> = [];
    const notifier = createEditNotifier({
      commit: (pending, reason) => {
        commits.push({ pending, reason });
      },
      scheduler: clock.scheduler,
      ...(options.windowMs === undefined ? {} : { windowMs: options.windowMs }),
    });
    return { clock, commits, notifier };
  }

  it('merges everything inside five seconds into one write', () => {
    const { clock, commits, notifier } = setup();

    notifier.record({ planId: 'P-118', change: change({ from: '8.5s', to: '6.0s' }), shots: [shot('s2')] });
    clock.advance(1_000);
    notifier.record({ planId: 'P-118', change: change({ from: '6.0s', to: '5.0s' }), shots: [shot('s2')] });
    clock.advance(1_000);
    notifier.record({
      planId: 'P-118',
      change: change({ shot: 4, op: 'removed', field: null, from: null, to: null }),
      shots: [shot('s2')],
    });

    expect(commits).toHaveLength(0);

    clock.advance(EDIT_MERGE_WINDOW_MS);

    expect(commits).toHaveLength(1);
    expect(commits[0]?.reason).toBe('window');
    expect(commits[0]?.pending.changes).toEqual([
      { shot: 2, op: 'updated', field: 'duration', from: '8.5s', to: '5.0s' },
      { shot: 4, op: 'removed', field: null, from: null, to: null },
    ]);
  });

  it('measures the window from the first edit, not the last', () => {
    const { clock, commits, notifier } = setup();

    for (let index = 0; index < 10; index += 1) {
      notifier.record({
        planId: 'P-118',
        change: change({ from: '8.5s', to: `${String(8 - index)}.0s` }),
        shots: [shot('s2')],
      });
      clock.advance(600);
    }

    // A sliding window would still be open here; this one is not.
    expect(commits).toHaveLength(1);
    expect(commits[0]?.reason).toBe('window');
  });

  it('opens a fresh window after a flush', () => {
    const { clock, commits, notifier } = setup();

    notifier.record({ planId: 'P-118', change: change(), shots: [shot('s2')] });
    clock.advance(EDIT_MERGE_WINDOW_MS);
    notifier.record({ planId: 'P-118', change: change({ shot: 3 }), shots: [shot('s3')] });
    clock.advance(EDIT_MERGE_WINDOW_MS);

    expect(commits.map((entry) => entry.reason)).toEqual(['window', 'window']);
  });

  it('writes on every forced occasion, and each one names itself', async () => {
    for (const reason of EDIT_FLUSH_REASONS) {
      if (reason === 'window') continue;
      const { commits, notifier } = setup();
      notifier.record({ planId: 'P-118', change: change(), shots: [shot('s2')] });
      await notifier.flush(reason);

      expect(commits).toHaveLength(1);
      expect(commits[0]?.reason).toBe(reason);
    }
  });

  it('cancels the window it flushed, so nothing is written twice', () => {
    const { clock, commits, notifier } = setup();

    notifier.record({ planId: 'P-118', change: change(), shots: [shot('s2')] });
    void notifier.flush('send-message');
    clock.advance(EDIT_MERGE_WINDOW_MS * 2);

    expect(commits).toHaveLength(1);
    expect(clock.pending()).toBe(0);
  });

  it('writes nothing when there is nothing buffered', async () => {
    const { commits, notifier } = setup();
    await notifier.flush('confirm-video');
    expect(commits).toHaveLength(0);
  });

  it('writes nothing when every edit collapsed to a round trip', async () => {
    const { commits, notifier } = setup();
    notifier.record({ planId: 'P-118', change: change({ from: '8.5s', to: '8.5s' }), shots: [] });
    await notifier.flush('window');
    expect(commits).toHaveLength(0);
  });

  it('flushes the previous plan before buffering an edit to another one', () => {
    const { commits, notifier } = setup();

    notifier.record({ planId: 'P-118', change: change(), shots: [shot('s2')] });
    notifier.record({ planId: 'P-102', change: change({ shot: 1 }), shots: [shot('s1')] });

    expect(commits).toHaveLength(1);
    expect(commits[0]?.reason).toBe('switch-plan');
    expect(commits[0]?.pending.planId).toBe('P-118');
    expect(notifier.peek()?.planId).toBe('P-102');
  });

  it('carries the latest whole shot array, not a delta', () => {
    const { commits, clock, notifier } = setup();
    const first = [shot('s1')];
    const last = [shot('s1'), shot('s2')];

    notifier.record({ planId: 'P-118', change: change(), shots: first });
    notifier.record({ planId: 'P-118', change: change({ shot: 3 }), shots: last });
    clock.advance(EDIT_MERGE_WINDOW_MS);

    expect(commits[0]?.pending.shots).toBe(last);
  });

  it('hands a failed write back and does not re-queue it', async () => {
    const clock = manualScheduler();
    const failures: Array<{ reason: EditFlushReason; pending: PendingPlanEdit }> = [];
    const commit = vi.fn(() => Promise.reject(new Error('409')));
    const notifier = createEditNotifier({
      commit,
      onError: (_error, pending, reason) => failures.push({ pending, reason }),
      scheduler: clock.scheduler,
    });

    notifier.record({ planId: 'P-118', change: change(), shots: [shot('s2')] });
    await notifier.flush('send-message');

    expect(commit).toHaveBeenCalledTimes(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.pending.changes).toHaveLength(1);
    // Nothing left in the buffer: a 409 retried with the same expected_revision
    // would loop, so the panel decides what happens next.
    expect(notifier.peek()).toBeNull();
  });

  it('lets a caller see what would be written', () => {
    const { notifier } = setup();
    expect(notifier.peek()).toBeNull();
    notifier.record({ planId: 'P-118', change: change(), shots: [shot('s2')] });
    expect(notifier.peek()?.changes).toHaveLength(1);
  });

  it('stops the timer on dispose without writing', () => {
    const { clock, commits, notifier } = setup();
    notifier.record({ planId: 'P-118', change: change(), shots: [shot('s2')] });
    notifier.dispose();
    clock.advance(EDIT_MERGE_WINDOW_MS * 2);

    expect(commits).toHaveLength(0);
    expect(clock.pending()).toBe(0);
  });
});

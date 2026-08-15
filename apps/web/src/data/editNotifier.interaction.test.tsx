/*
 * `interaction` project — the four flush occasions `useEditNotifier` wires and
 * the two it leaves to its caller.
 *
 * 「漏掉任何一个都会丢通知」, so each occasion is its own test rather than a loop:
 * a loop that stops at the first failure hides the other five.
 */

import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  EDIT_MERGE_WINDOW_MS,
  useEditNotifier,
  type EditFlushReason,
  type PendingPlanEdit,
} from './editNotifier';
import type { AgentPlanShot, WorkspaceEditChange } from '../shared/desktop/dto';

const SHOT: AgentPlanShot = {
  id: 'shot-2',
  title: '跟随突破',
  kind: 'tracking',
  view: 'observer',
  start_tick: 148_812,
  end_tick: 149_356,
  duration_seconds: 5,
  rationale: '',
  evidence_refs: [],
  risks: [],
  source: 'user',
  removed_by: null,
  params: null,
};

const CHANGE: WorkspaceEditChange = {
  shot: 2,
  op: 'updated',
  field: 'duration',
  from: '8.5s',
  to: '5.0s',
};

interface Harness {
  commits: Array<{ pending: PendingPlanEdit; reason: EditFlushReason }>;
  record: () => void;
  flush: (reason: EditFlushReason) => Promise<void>;
}

function renderNotifier(initial: { sessionId: string | null; planId: string | null }) {
  const commits: Array<{ pending: PendingPlanEdit; reason: EditFlushReason }> = [];
  const harness: Harness = {
    commits,
    record: () => undefined,
    flush: async () => undefined,
  };

  function Probe({ sessionId, planId }: { sessionId: string | null; planId: string | null }) {
    const notifier = useEditNotifier({
      sessionId,
      planId,
      commit: (pending, reason) => {
        commits.push({ pending, reason });
      },
    });
    harness.record = () =>
      notifier.record({ planId: planId ?? 'P-118', change: CHANGE, shots: [SHOT] });
    harness.flush = notifier.flush;
    return null;
  }

  const view = render(<Probe sessionId={initial.sessionId} planId={initial.planId} />);
  return {
    harness,
    rerender: (next: { sessionId: string | null; planId: string | null }) =>
      view.rerender(<Probe sessionId={next.sessionId} planId={next.planId} />),
    unmount: view.unmount,
  };
}

describe('useEditNotifier', () => {
  it('writes when the five-second window expires', () => {
    vi.useFakeTimers();
    try {
      const { harness } = renderNotifier({ sessionId: 'S-1', planId: 'P-118' });
      act(() => {
        harness.record();
      });
      expect(harness.commits).toHaveLength(0);

      act(() => {
        vi.advanceTimersByTime(EDIT_MERGE_WINDOW_MS);
      });

      expect(harness.commits.map((entry) => entry.reason)).toEqual(['window']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes before the user sends a message', async () => {
    const { harness } = renderNotifier({ sessionId: 'S-1', planId: 'P-118' });
    act(() => {
      harness.record();
    });

    await act(async () => {
      await harness.flush('send-message');
    });

    expect(harness.commits.map((entry) => entry.reason)).toEqual(['send-message']);
  });

  it('writes before 「确认并生成视频」', async () => {
    const { harness } = renderNotifier({ sessionId: 'S-1', planId: 'P-118' });
    act(() => {
      harness.record();
    });

    await act(async () => {
      await harness.flush('confirm-video');
    });

    expect(harness.commits.map((entry) => entry.reason)).toEqual(['confirm-video']);
  });

  it('writes when the session changes, and names the session switch', () => {
    const { harness, rerender } = renderNotifier({ sessionId: 'S-1', planId: 'P-118' });
    act(() => {
      harness.record();
    });

    act(() => {
      rerender({ sessionId: 'S-2', planId: 'P-118' });
    });

    expect(harness.commits.map((entry) => entry.reason)).toEqual(['switch-session']);
    // The notice still names the object it was made on.
    expect(harness.commits[0]?.pending.planId).toBe('P-118');
  });

  it('writes when the plan changes', () => {
    const { harness, rerender } = renderNotifier({ sessionId: 'S-1', planId: 'P-118' });
    act(() => {
      harness.record();
    });

    act(() => {
      rerender({ sessionId: 'S-1', planId: 'P-102' });
    });

    expect(harness.commits.map((entry) => entry.reason)).toEqual(['switch-plan']);
    expect(harness.commits[0]?.pending.planId).toBe('P-118');
  });

  it('writes when the page goes away — and calls it an unmount, not a switch', () => {
    const { harness, unmount } = renderNotifier({ sessionId: 'S-1', planId: 'P-118' });
    act(() => {
      harness.record();
    });

    act(() => {
      unmount();
    });

    expect(harness.commits.map((entry) => entry.reason)).toEqual(['unmount']);
  });

  it('writes when the window is closing', () => {
    const { harness } = renderNotifier({ sessionId: 'S-1', planId: 'P-118' });
    act(() => {
      harness.record();
    });

    act(() => {
      window.dispatchEvent(new Event('beforeunload'));
    });

    expect(harness.commits.map((entry) => entry.reason)).toEqual(['before-unload']);
  });

  it('writes when the page is navigated away from', () => {
    const { harness } = renderNotifier({ sessionId: 'S-1', planId: 'P-118' });
    act(() => {
      harness.record();
    });

    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });

    expect(harness.commits.map((entry) => entry.reason)).toEqual(['leave-page']);
  });

  it('writes once, not twice, when a flush is followed by an unmount', async () => {
    const { harness, unmount } = renderNotifier({ sessionId: 'S-1', planId: 'P-118' });
    act(() => {
      harness.record();
    });
    await act(async () => {
      await harness.flush('send-message');
    });

    act(() => {
      unmount();
    });

    expect(harness.commits).toHaveLength(1);
  });

  it('stops listening after unmount', () => {
    const { harness, unmount } = renderNotifier({ sessionId: 'S-1', planId: 'P-118' });
    act(() => {
      unmount();
    });

    act(() => {
      window.dispatchEvent(new Event('beforeunload'));
      window.dispatchEvent(new Event('pagehide'));
    });

    expect(harness.commits).toHaveLength(0);
  });

  it('never writes when nothing was edited, however the page ends', () => {
    const { harness, rerender, unmount } = renderNotifier({ sessionId: 'S-1', planId: 'P-118' });

    act(() => {
      rerender({ sessionId: 'S-2', planId: 'P-102' });
      window.dispatchEvent(new Event('beforeunload'));
      unmount();
    });

    expect(harness.commits).toHaveLength(0);
  });
});

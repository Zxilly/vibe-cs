/*
 * pages/match/views — the playback loop of 回放与热力图.
 *
 * §10.3 deviation and `domain/media/Transport`'s own header both say it
 * outright: the transport bar is controlled and must never own a clock —
 * 「advancing the playhead is the playback engine's job, and a control bar that
 * also ran a clock would be a second source of truth for the same number」.
 * This is that engine, and it lives in `pages/` because the replay view is
 * where the playhead lives.
 *
 * ── Why the loop is `requestAnimationFrame` and not `setInterval` ──────────
 *
 * The browser stops calling rAF when the window is hidden or occluded, which is
 * what a desktop app wants: a replay running behind another window should not
 * keep re-rendering a few hundred SVG nodes. `setInterval` keeps firing (and
 * `Transport`'s own note about a hidden clock applies doubly here). The elapsed
 * time comes from the timestamp the callback is handed rather than from
 * `Date.now`, so a throttled or skipped frame produces one large step instead
 * of drift.
 *
 * ── Why the step is not every frame ───────────────────────────────────────
 *
 * `onAdvance` moves the playhead, which re-renders the map — up to ten tracks,
 * a marker per living player and the duel axes. At 60 Hz that is sixty full
 * reconciliations a second for motion no one can read at that rate. Elapsed
 * time is accumulated and released at `STEP_MS`, so the *clock* stays exact
 * (nothing is dropped, only deferred) while the *drawing* runs at a rate a
 * 720-unit canvas can sustain. The playhead is a tick, not a frame index, so
 * coarser stepping loses no fidelity in the data — it only redraws less often.
 *
 * ── Stopping ──────────────────────────────────────────────────────────────
 *
 * The effect cancels the outstanding frame on every teardown: on pause, on a
 * re-render that changes `playing`, and on unmount. A loop that outlived its
 * component would go on calling `setState` on a dead tree and, worse, would go
 * on writing the address (§4.4) after the user has navigated away.
 * `ReplayView.interaction.test.tsx` drives a fake `requestAnimationFrame` and
 * proves the queue is empty after unmount.
 */

import { useEffect, useRef } from 'react';

/**
 * ~15 steps a second. Chosen against the two rates that bound it: below ~10 Hz
 * motion reads as a slideshow, and above ~20 Hz the map redraw starts to cost
 * more than the frame budget on the 1100×700 window §9 risk 6 is measured at.
 */
export const STEP_MS = 66;

export interface PlaybackClockOptions {
  readonly playing: boolean;
  /**
   * Wall-clock seconds since the previous step. The caller multiplies by the
   * playback rate — the rate belongs to the view's model of time, not to the
   * loop, and keeping it out of here means changing speed does not restart the
   * loop or discard the accumulated remainder.
   */
  readonly onAdvance: (elapsedSeconds: number) => void;
  /** Milliseconds between released steps. Exposed for the test's benefit. */
  readonly stepMs?: number | undefined;
}

export function usePlaybackClock({ playing, onAdvance, stepMs = STEP_MS }: PlaybackClockOptions): void {
  /* The callback is read through a ref so a new `onAdvance` on every render —
     which is what a closure over the playhead is — does not tear the loop down
     and build it back up sixty times a second. */
  const advance = useRef(onAdvance);
  advance.current = onAdvance;

  useEffect(() => {
    if (!playing) return undefined;

    let handle = 0;
    let previous: number | null = null;
    let pending = 0;

    const step = (now: number) => {
      if (previous !== null) {
        const elapsed = now - previous;
        // A negative or absurd delta means the clock was adjusted or the tab
        // was suspended; skipping it is better than jumping the playhead.
        pending += elapsed > 0 && elapsed < 1_000 ? elapsed : 0;
        if (pending >= stepMs) {
          const released = pending;
          pending = 0;
          advance.current(released / 1_000);
        }
      }
      previous = now;
      handle = requestAnimationFrame(step);
    };

    handle = requestAnimationFrame(step);
    return () => cancelAnimationFrame(handle);
  }, [playing, stepMs]);
}

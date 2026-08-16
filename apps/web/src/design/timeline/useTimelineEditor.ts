/*
 * Design system, layer 1 of 3 — multi-track timeline (spec §0.5, phase 3f-2).
 *
 * The React binding. Everything below is state, event plumbing and undo — the
 * editing itself happens in the pure modules, and this file is deliberately
 * the only place in the timeline that knows React exists on the model side.
 *
 * Four decisions worth naming, the last two new in 3f-2:
 *
 *   · a drag does not touch the document until the pointer comes up. While it
 *     is down there is a `DragPreview` — one pixel offset, one landing place,
 *     one refusal — recomputed by `previewDrag` and written to `--tl-dx`. So a
 *     cancelled drag needs no rollback and an undo stack gets one entry per
 *     gesture rather than one per pointermove.
 *   · pointermove / pointerup are bound to the window. `setPointerCapture` is
 *     *also* taken, when the runtime has it (README gap 5): capture is what
 *     makes releasing outside the browser window deliver a `pointerup` instead
 *     of stranding the gesture, and because captured events still bubble to
 *     the window, the listeners below do not change. jsdom implements neither
 *     `setPointerCapture` nor `hasPointerCapture` on every element, hence the
 *     feature test rather than a call.
 *   · **every commit is quantised to the frame grid** (`frameGrid.ts`), once,
 *     here. Not in the operations and never in a preview — the gesture stays
 *     continuous and its result lands on a frame. §10.10.
 *   · **the scroll offset is part of a drag's arithmetic.** Auto-scroll means
 *     the ground moves while the pointer does not, so the horizontal travel a
 *     preview is computed from is `pointer delta + scroll delta`. Getting this
 *     wrong is invisible until the timeline scrolls under a held pointer and
 *     the clip slides away from the cursor.
 *
 * `overlap` is a policy of the editor, not of a call site: 「越界与重叠的处理规则
 * 要明确」 (§0.5) means the rule is chosen once and every gesture obeys it.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { advanceScroll, autoScrollVelocity, maxScrollPx } from './autoScroll';
import { moveClip, moveClipBy, type OverlapPolicy } from './dragMove';
import { previewDrag, previewSlip, type DragPreview } from './dragPreview';
import { quantizeTimeline, quantizeToFrame } from './frameGrid';
import { adjacentTrackOfKind } from './geometry';
import { razorAt, splitClipAt } from './razor';
import { liftDelete, rippleDelete, type RippleScope } from './rippleEdit';
import { slipClip } from './slip';
import { setClipSpeed } from './speed';
import {
  addTrack,
  getClip,
  getTrack,
  linkGroup,
  removeTrack,
  timelineDuration,
  withMarkers,
  withPlayhead,
  type Clip,
  type Marker,
  type EditRefusal,
  type EditResult,
  type Timeline,
  type Track,
} from './timelineModel';
import { createTimeScale, nextZoom, timeToPx, zoomAtAnchor, type TimeScale } from './timeScale';
import { trimClip, trimPreview, type TrimEdge } from './trim';
import { visibleClips, type TimelineViewport } from './virtualize';

/** The artboard's toolbar: 选择 · 剃刀 · 滑移. */
export type TimelineTool = 'select' | 'razor' | 'slip';

/** What the pointer is doing. `trim` carries which edge it has hold of. */
export type DragMode = 'move' | 'slip' | 'trim';

export interface DragState extends DragPreview {
  clipId: string;
  mode: DragMode;
  /** Seconds of slip requested so far, before `slipClip` clamps it. */
  slipDelta: number;
  /** Which edge a trim has hold of; null for the other modes. */
  edge: TrimEdge | null;
  /**
   * Where a trim would leave the clip, already clamped. The renderer draws
   * these instead of the clip's own `start` / `duration` while the drag runs,
   * so the edge follows the cursor and stops where the trim would stop.
   *
   * `requestedDelta` is what the pointer asked for *before* the clamp, and it
   * is what the commit passes to `trimClip`. Committing the clamped value
   * instead would make a fully-clamped drag commit zero, which the operation
   * reads as "nothing happened" — so a user who pulled an edge for two seconds
   * against a neighbour would get silence where 「不隐藏、不静默失败」 requires
   * a reason.
   */
  trim: { start: number; duration: number; appliedDelta: number; requestedDelta: number } | null;
}

interface DragOrigin {
  clipId: string;
  originX: number;
  originY: number;
  /** Scroll offset when the gesture began; see the module comment. */
  originScrollPx: number;
  mode: DragMode;
  edge: TrimEdge | null;
  pointerId: number;
  /** The element holding the pointer capture, when the runtime granted one. */
  captureTarget: Element | null;
}

interface History {
  past: Timeline[];
  present: Timeline;
  future: Timeline[];
}

export interface UseTimelineEditorOptions {
  initial: Timeline;
  overlap?: OverlapPolicy;
  /** Seconds per arrow-key nudge; Shift multiplies by ten. */
  nudgeSeconds?: number;
  snapThresholdPx?: number;
  rippleScope?: RippleScope;
  /** Shortest a trim may leave a clip, in frames. */
  minTrimFrames?: number;
  /** Extra band rendered either side of the viewport, in pixels. */
  overscanPx?: number;
}

export interface TimelineEditor {
  timeline: Timeline;
  scale: TimeScale;
  zoom: number;
  tool: TimelineTool;
  snapEnabled: boolean;
  selectedClipId: string | null;
  /** Ids that move with the selection, the selection included. */
  linkedClipIds: ReadonlySet<string>;
  drag: DragState | null;
  /** The last refusal, for the Notice. Cleared by the next successful edit. */
  refusal: EditRefusal | null;
  lengthSeconds: number;
  /** Seconds an arrow-key nudge travels; the view reads it rather than guessing. */
  nudgeSeconds: number;
  scrollPx: number;
  /** Measured viewport width; 0 until the ref has a layout. */
  viewportWidthPx: number;
  /** The clips worth mounting — everything outside the window is culled. */
  mountedClips: readonly Clip[];
  canUndo: boolean;
  canRedo: boolean;
  viewportRef: React.RefObject<HTMLDivElement | null>;

  setTool: (tool: TimelineTool) => void;
  setSnapEnabled: (enabled: boolean) => void;
  select: (clipId: string | null) => void;
  setPlayhead: (seconds: number) => void;
  setScrollPx: (px: number) => void;
  setZoom: (zoom: number) => void;
  zoomBy: (direction: 1 | -1) => void;
  dismissRefusal: () => void;

  razorAtPlayhead: () => void;
  splitSelectionAtPlayhead: () => void;
  rippleDeleteSelection: () => void;
  deleteSelection: () => void;
  nudgeSelection: (deltaSeconds: number) => void;
  slipSelection: (deltaSeconds: number) => void;
  trimSelection: (edge: TrimEdge, deltaSeconds: number) => void;
  setSelectionSpeed: (speed: number) => void;
  /** Adds a marker. Undoable — it is part of the document. */
  addMarker: (marker: Marker) => void;
  removeMarker: (markerId: string) => void;
  /**
   * Adds an empty lane. Undoable, like every other document edit — the lane is
   * part of the saved project even before anything is dropped on it.
   */
  addTrack: (track: Track) => void;
  /** Removes a lane and its clips. Refused when the lane is locked. */
  removeTrack: (trackId: string) => void;
  /**
   * Replaces the document with one an outside edit produced, as one undoable
   * step. The editor owns the undo stack, so an edit made anywhere else — a
   * clip inserted from the media library, for instance — has to enter through
   * here or 「撤销」 would skip straight past it.
   */
  replaceTimeline: (timeline: Timeline) => void;
  moveSelectionToAdjacentTrack: (direction: 1 | -1) => void;
  undo: () => void;
  redo: () => void;

  beginClipDrag: (clipId: string, event: PointerGesture) => void;
  beginTrimDrag: (clipId: string, edge: TrimEdge, event: PointerGesture) => void;
  cancelDrag: () => void;
}

/**
 * The part of a `PointerEvent` a gesture needs. Declared structurally so a
 * test can start a drag with a plain object, and so the hook cannot reach for
 * anything on the event it has not said it uses.
 */
export interface PointerGesture {
  clientX: number;
  clientY: number;
  pointerId?: number;
  currentTarget?: Element | null;
}

/** `setPointerCapture` where it exists, silently skipped where it does not. */
function capturePointer(event: PointerGesture): Element | null {
  const target = event.currentTarget ?? null;
  const pointerId = event.pointerId;
  if (target === null || pointerId === undefined) return null;
  const capture = (target as Element & { setPointerCapture?: (id: number) => void }).setPointerCapture;
  if (typeof capture !== 'function') return null;
  try {
    capture.call(target, pointerId);
    return target;
  } catch {
    // A pointer that ended between the event and this call throws
    // NotFoundError. The gesture is over; the window listeners will see the
    // `pointerup` and tidy up, so there is nothing to report.
    return null;
  }
}

function releasePointer(target: Element | null, pointerId: number): void {
  if (target === null) return;
  const release = (target as Element & { releasePointerCapture?: (id: number) => void }).releasePointerCapture;
  if (typeof release !== 'function') return;
  try {
    release.call(target, pointerId);
  } catch {
    // Already released — by the browser on pointerup, or never granted.
  }
}

export function useTimelineEditor({
  initial,
  overlap = 'reject',
  nudgeSeconds = 0.1,
  snapThresholdPx,
  rippleScope = 'linked',
  minTrimFrames = 1,
  overscanPx,
}: UseTimelineEditorOptions): TimelineEditor {
  // Quantised on the way in, not only on the way out. The frame-grid invariant
  // — every time in the document sits on a frame — has to hold from the first
  // render or the first edit inherits an off-grid neighbour and produces a
  // seam that is a fraction of a frame wide. A project arriving from the
  // service is not guaranteed to be on the grid: `EditorProject::validate`
  // bounds its times but does not round them.
  const [history, setHistory] = useState<History>(() => ({
    past: [],
    present: quantizeTimeline(initial),
    future: [],
  }));
  const [zoom, setZoomValue] = useState(1);
  const [tool, setTool] = useState<TimelineTool>('select');
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<EditRefusal | null>(null);
  const [scrollPx, setScrollPx] = useState(0);
  const [viewportWidthPx, setViewportWidthPx] = useState(0);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dragClipId, setDragClipId] = useState<string | null>(null);

  const dragOrigin = useRef<DragOrigin | null>(null);
  const dragState = useRef<DragState | null>(null);
  /** Latest pointer position, so the rAF loop can re-preview without an event. */
  const pointerRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const scrollRef = useRef(0);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  const timeline = history.present;
  const scale = useMemo(() => createTimeScale(zoom), [zoom]);
  const lengthSeconds = Math.max(timelineDuration(timeline), timeline.playhead);

  // The auto-scroll loop reads the scroll offset every frame and must not be
  // re-created when it changes, so the value is mirrored in a ref.
  scrollRef.current = scrollPx;

  /**
   * Push a successful edit; surface the reason for a refused one.
   *
   * The quantisation sits here rather than in each operation because a razor
   * derives both halves from one instant: rounding the operation's *result*
   * rounds that instant once, while rounding inside would round the left
   * clip's end and the right clip's start separately and can leave a one-frame
   * hole. See `frameGrid.ts`.
   */
  const commit = useCallback((result: EditResult) => {
    if (!result.applied) {
      setRefusal(result.reason ?? null);
      return false;
    }
    setRefusal(null);
    setHistory((current) => ({
      past: [...current.past, current.present],
      present: quantizeTimeline(result.timeline),
      future: [],
    }));
    return true;
  }, []);

  /* ── view ──────────────────────────────────────────────────────────────── */

  const setZoom = useCallback(
    (next: number) => {
      // The anchor is the middle of the viewport: what the user is looking at
      // has to stay where it is (`zoomAtAnchor`). A viewport that has not been
      // measured yet anchors at its left edge, which is also correct.
      const anchorPx = (viewportRef.current?.clientWidth ?? 0) / 2;
      const from = createTimeScale(zoom);
      const to = createTimeScale(next);
      setScrollPx((current) => zoomAtAnchor({ from, to, scrollPx: current, anchorPx }));
      setZoomValue(to.zoom);
    },
    [zoom],
  );

  const zoomBy = useCallback((direction: 1 | -1) => setZoom(nextZoom(zoom, direction)), [setZoom, zoom]);

  const setPlayhead = useCallback((seconds: number) => {
    // Not an undoable edit: moving the playhead changes nothing about the cut.
    // Quantised all the same — it is where the razor cuts, and a playhead
    // between two frames would make 「在播放头切开」 produce an off-grid seam
    // that the next commit would then have to round away from where it was
    // dropped. It is also what the `hh:mm:ss:ff` readouts print.
    setHistory((current) => ({
      ...current,
      present: withPlayhead(current.present, quantizeToFrame(seconds, current.present.fps)),
    }));
  }, []);

  /**
   * Viewport width, for virtualisation and for the auto-scroll band.
   *
   * `ResizeObserver` where it exists; a single measurement where it does not,
   * which is the jsdom case. A test that never resizes gets the right number
   * either way, and the fallback degrades to "windowing is computed from the
   * width at mount" rather than to a broken timeline.
   */
  useLayoutEffect(() => {
    const node = viewportRef.current;
    if (node === null) return undefined;
    setViewportWidthPx(node.clientWidth);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => setViewportWidthPx(node.clientWidth));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  /* ── commands ──────────────────────────────────────────────────────────── */

  const razorAtPlayhead = useCallback(() => {
    commit(razorAt(timeline, timeline.playhead));
  }, [commit, timeline]);

  const splitSelectionAtPlayhead = useCallback(() => {
    if (selectedClipId === null) return;
    commit(splitClipAt(timeline, selectedClipId, timeline.playhead));
  }, [commit, selectedClipId, timeline]);

  const rippleDeleteSelection = useCallback(() => {
    if (selectedClipId === null) return;
    if (commit(rippleDelete(timeline, selectedClipId, { scope: rippleScope }))) setSelectedClipId(null);
  }, [commit, rippleScope, selectedClipId, timeline]);

  const deleteSelection = useCallback(() => {
    if (selectedClipId === null) return;
    if (commit(liftDelete(timeline, selectedClipId))) setSelectedClipId(null);
  }, [commit, selectedClipId, timeline]);

  const nudgeSelection = useCallback(
    (deltaSeconds: number) => {
      if (selectedClipId === null) return;
      commit(moveClipBy(timeline, selectedClipId, deltaSeconds, { overlap }));
    },
    [commit, overlap, selectedClipId, timeline],
  );

  const slipSelection = useCallback(
    (deltaSeconds: number) => {
      if (selectedClipId === null) return;
      commit(slipClip(timeline, selectedClipId, deltaSeconds));
    },
    [commit, selectedClipId, timeline],
  );

  const trimSelection = useCallback(
    (edge: TrimEdge, deltaSeconds: number) => {
      if (selectedClipId === null) return;
      commit(trimClip(timeline, selectedClipId, edge, deltaSeconds, { minFrames: minTrimFrames }));
    },
    [commit, minTrimFrames, selectedClipId, timeline],
  );

  const setSelectionSpeed = useCallback(
    (speed: number) => {
      if (selectedClipId === null) return;
      commit(setClipSpeed(timeline, selectedClipId, speed, { minFrames: minTrimFrames }));
    },
    [commit, minTrimFrames, selectedClipId, timeline],
  );

  /*
   * Markers are edits, not view state: they are stored on the project, they
   * survive a save, and 「撤销」 has to be able to take one back. So both of
   * these go through `commit` — which also quantises them onto the frame grid,
   * since a marker off the grid is a razor target off the grid.
   */
  const addMarker = useCallback(
    (marker: Marker) => {
      commit({
        timeline: withMarkers(timeline, [...timeline.markers.filter((each) => each.id !== marker.id), marker]),
        applied: true,
      });
    },
    [commit, timeline],
  );

  const addLane = useCallback(
    (track: Track) => {
      commit({ timeline: addTrack(timeline, track), applied: true });
    },
    [commit, timeline],
  );

  const removeLane = useCallback(
    (trackId: string) => {
      const track = getTrack(timeline, trackId);
      if (track === undefined || track.locked === true) {
        setRefusal('track-locked');
        return;
      }
      commit({ timeline: removeTrack(timeline, trackId), applied: true });
    },
    [commit, timeline],
  );

  const removeMarker = useCallback(
    (markerId: string) => {
      if (!timeline.markers.some((marker) => marker.id === markerId)) {
        setRefusal('no-change');
        return;
      }
      commit({
        timeline: withMarkers(timeline, timeline.markers.filter((marker) => marker.id !== markerId)),
        applied: true,
      });
    },
    [commit, timeline],
  );

  const replaceTimeline = useCallback(
    (next: Timeline) => {
      commit({ timeline: next, applied: true });
    },
    [commit],
  );

  const moveSelectionToAdjacentTrack = useCallback(
    (direction: 1 | -1) => {
      if (selectedClipId === null) return;
      const clip = getClip(timeline, selectedClipId);
      if (clip === undefined) return;
      const toTrackId = adjacentTrackOfKind(timeline, clip.trackId, direction);
      if (toTrackId === undefined) {
        setRefusal('track-kind-mismatch');
        return;
      }
      commit(moveClip(timeline, selectedClipId, clip.start, { toTrackId, overlap }));
    },
    [commit, overlap, selectedClipId, timeline],
  );

  const undo = useCallback(() => {
    setHistory((current) => {
      const previous = current.past[current.past.length - 1];
      if (previous === undefined) return current;
      return {
        past: current.past.slice(0, -1),
        present: previous,
        future: [current.present, ...current.future],
      };
    });
    setRefusal(null);
  }, []);

  const redo = useCallback(() => {
    setHistory((current) => {
      const [next, ...rest] = current.future;
      if (next === undefined) return current;
      return { past: [...current.past, current.present], present: next, future: rest };
    });
    setRefusal(null);
  }, []);

  /* ── dragging ──────────────────────────────────────────────────────────── */

  const beginDrag = useCallback(
    (clipId: string, mode: DragMode, edge: TrimEdge | null, event: PointerGesture) => {
      setSelectedClipId(clipId);
      const clip = getClip(timeline, clipId);
      dragOrigin.current = {
        clipId,
        originX: event.clientX,
        originY: event.clientY,
        originScrollPx: scrollRef.current,
        mode,
        edge,
        pointerId: event.pointerId ?? -1,
        captureTarget: capturePointer(event),
      };
      pointerRef.current = { clientX: event.clientX, clientY: event.clientY };
      const initialState: DragState = {
        clipId,
        mode,
        edge,
        slipDelta: 0,
        trim:
          mode === 'trim'
            ? { start: clip?.start ?? 0, duration: clip?.duration ?? 0, appliedDelta: 0, requestedDelta: 0 }
            : null,
        start: clip?.start ?? 0,
        trackId: clip?.trackId ?? '',
        offsetPx: 0,
        snap: null,
        refusal: null,
      };
      dragState.current = initialState;
      setDrag(initialState);
      setDragClipId(clipId);
    },
    [timeline],
  );

  const beginClipDrag = useCallback(
    (clipId: string, event: PointerGesture) => {
      if (tool === 'razor') {
        setSelectedClipId(clipId);
        commit(splitClipAt(timeline, clipId, timeline.playhead));
        return;
      }
      beginDrag(clipId, tool === 'slip' ? 'slip' : 'move', null, event);
    },
    [beginDrag, commit, timeline, tool],
  );

  /**
   * An edge handle always trims, whatever the toolbar says. The razor and slip
   * tools act on the *body* of a clip; a handle is 6px of unambiguous intent,
   * and making it mean three different things depending on a toolbar the
   * pointer is nowhere near would be the surprising choice.
   */
  const beginTrimDrag = useCallback(
    (clipId: string, edge: TrimEdge, event: PointerGesture) => beginDrag(clipId, 'trim', edge, event),
    [beginDrag],
  );

  const cancelDrag = useCallback(() => {
    const origin = dragOrigin.current;
    if (origin !== null) releasePointer(origin.captureTarget, origin.pointerId);
    dragOrigin.current = null;
    dragState.current = null;
    pointerRef.current = null;
    setDrag(null);
    setDragClipId(null);
  }, []);

  /**
   * Recompute the preview from the pointer's last known position. Called by
   * `pointermove` and by every auto-scroll frame — the second is why it does
   * not take the event: when the ground moves and the pointer does not, the
   * travel has changed all the same.
   */
  const repreview = useCallback(() => {
    const origin = dragOrigin.current;
    const pointer = pointerRef.current;
    if (origin === null || pointer === null) return;

    const deltaXPx = pointer.clientX - origin.originX + (scrollRef.current - origin.originScrollPx);
    const deltaYPx = pointer.clientY - origin.originY;
    const previous = dragState.current;

    let next: DragState;
    if (origin.mode === 'slip') {
      next = {
        ...(previous ?? { start: 0, trackId: '', offsetPx: 0, snap: null, refusal: null }),
        clipId: origin.clipId,
        mode: 'slip',
        edge: null,
        trim: null,
        offsetPx: 0,
        slipDelta: previewSlip(scale, deltaXPx),
      };
    } else if (origin.mode === 'trim' && origin.edge !== null) {
      const clip = getClip(timeline, origin.clipId);
      const requestedDelta = deltaXPx / scale.pixelsPerSecond;
      const preview =
        clip === undefined
          ? null
          : trimPreview(timeline, clip, origin.edge, requestedDelta, { minFrames: minTrimFrames });
      next = {
        clipId: origin.clipId,
        mode: 'trim',
        edge: origin.edge,
        slipDelta: 0,
        trim:
          preview === null
            ? null
            : {
                start: preview.start,
                duration: preview.duration,
                appliedDelta: preview.appliedDelta,
                requestedDelta,
              },
        start: preview?.start ?? clip?.start ?? 0,
        trackId: clip?.trackId ?? '',
        offsetPx: 0,
        snap: null,
        // The clamp already stopped the edge; a trim that cannot move at all
        // is the refusal, and `trimClip` will name it on the way up.
        refusal: null,
      };
    } else {
      next = {
        ...previewDrag({
          timeline,
          clipId: origin.clipId,
          deltaXPx,
          deltaYPx,
          scale,
          snapEnabled,
          overlap,
          ...(snapThresholdPx === undefined ? {} : { thresholdPx: snapThresholdPx }),
        }),
        clipId: origin.clipId,
        mode: 'move',
        edge: null,
        slipDelta: 0,
        trim: null,
      };
    }

    dragState.current = next;
    setDrag(next);
  }, [minTrimFrames, overlap, scale, snapEnabled, snapThresholdPx, timeline]);

  useEffect(() => {
    if (dragClipId === null) return undefined;

    const handleMove = (event: PointerEvent) => {
      pointerRef.current = { clientX: event.clientX, clientY: event.clientY };
      repreview();
    };

    const handleUp = () => {
      const origin = dragOrigin.current;
      const state = dragState.current;
      if (origin !== null) releasePointer(origin.captureTarget, origin.pointerId);
      dragOrigin.current = null;
      dragState.current = null;
      pointerRef.current = null;
      setDrag(null);
      setDragClipId(null);
      if (origin === null || state === null) return;

      if (origin.mode === 'slip') {
        if (state.slipDelta !== 0) commit(slipClip(timeline, origin.clipId, state.slipDelta));
        return;
      }
      if (origin.mode === 'trim' && origin.edge !== null) {
        // The *requested* delta, not the clamped one — see `DragState.trim`.
        // `trimClip` re-clamps it and names the reason when nothing moved.
        const delta = state.trim?.requestedDelta ?? 0;
        if (delta !== 0) {
          commit(trimClip(timeline, origin.clipId, origin.edge, delta, { minFrames: minTrimFrames }));
        }
        return;
      }
      if (state.offsetPx === 0 && state.trackId === getClip(timeline, origin.clipId)?.trackId) return;
      commit(moveClip(timeline, origin.clipId, state.start, { toTrackId: state.trackId, overlap }));
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', cancelDrag);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', cancelDrag);
    };
  }, [cancelDrag, commit, dragClipId, minTrimFrames, overlap, repreview, timeline]);

  /**
   * The auto-scroll loop. Runs only while a drag is live, and only a slip is
   * exempt: a slip does not move the clip along the timeline, so pulling the
   * view sideways during one would scroll away from what is being edited.
   *
   * `requestAnimationFrame` is feature-tested because the node test projects
   * render markup without one; the drag itself keeps working there, it simply
   * never auto-scrolls, which is what a test that does not scroll expects.
   */
  useEffect(() => {
    if (dragClipId === null) return undefined;
    if (typeof requestAnimationFrame !== 'function') return undefined;

    let frame = 0;
    // `null`, not 0: a runtime is free to hand the first callback a timestamp
    // of 0, and a zero sentinel would then treat every subsequent frame as the
    // first and never advance.
    let previousTime: number | null = null;

    const step = (now: number) => {
      frame = requestAnimationFrame(step);
      const elapsed = previousTime === null ? 0 : now - previousTime;
      previousTime = now;

      const origin = dragOrigin.current;
      const pointer = pointerRef.current;
      const node = viewportRef.current;
      if (origin === null || pointer === null || node === null || origin.mode === 'slip') return;

      const rect = node.getBoundingClientRect();
      const velocity = autoScrollVelocity({
        pointerViewportPx: pointer.clientX - rect.left,
        viewportWidthPx: rect.width,
      });
      if (velocity === 0 || elapsed === 0) return;

      const limit = maxScrollPx(timeToPx(scale, lengthSeconds), rect.width);
      const next = advanceScroll(scrollRef.current, velocity, elapsed, limit);
      if (next === scrollRef.current) return;
      scrollRef.current = next;
      setScrollPx(next);
      repreview();
    };

    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [dragClipId, lengthSeconds, repreview, scale]);

  const linkedClipIds = useMemo(() => {
    if (selectedClipId === null) return new Set<string>();
    return new Set(linkGroup(timeline, selectedClipId).map((clip) => clip.id));
  }, [selectedClipId, timeline]);

  const viewport: TimelineViewport = { scrollPx, widthPx: viewportWidthPx };
  const mountedClips = useMemo(
    () =>
      visibleClips(timeline, scale, viewport, {
        // Whatever the pointer or the Inspector is holding stays mounted; see
        // `virtualize.ts`. The drag's own group is in `linkedClipIds`.
        keepIds: linkedClipIds,
        ...(overscanPx === undefined ? {} : { overscanPx }),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `viewport` is
    // rebuilt every render from these two numbers; depending on the object
    // would defeat the memo.
    [timeline, scale, scrollPx, viewportWidthPx, linkedClipIds, overscanPx],
  );

  return {
    timeline,
    scale,
    zoom,
    tool,
    snapEnabled,
    selectedClipId,
    linkedClipIds,
    drag,
    refusal,
    lengthSeconds,
    nudgeSeconds,
    scrollPx,
    viewportWidthPx,
    mountedClips,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    viewportRef,

    setTool,
    setSnapEnabled,
    select: setSelectedClipId,
    setPlayhead,
    setScrollPx,
    setZoom,
    zoomBy,
    dismissRefusal: () => setRefusal(null),

    razorAtPlayhead,
    splitSelectionAtPlayhead,
    rippleDeleteSelection,
    deleteSelection,
    nudgeSelection,
    slipSelection,
    trimSelection,
    setSelectionSpeed,
    addMarker,
    addTrack: addLane,
    removeTrack: removeLane,
    removeMarker,
    replaceTimeline,
    moveSelectionToAdjacentTrack,
    undo,
    redo,

    beginClipDrag,
    beginTrimDrag,
    cancelDrag,
  };
}

/** Seconds a keyboard nudge should travel, given the modifier state. */
export function nudgeStep(base: number, shiftKey: boolean): number {
  return shiftKey ? base * 10 : base;
}

/*
 * Design system, layer 1 of 3 — multi-track timeline prototype (spec §0.5).
 *
 * The React binding. Everything below is state, event plumbing and undo — the
 * editing itself happens in the pure modules, and this file is deliberately
 * the only place in the prototype that knows React exists on the model side.
 *
 * Two decisions worth naming:
 *
 *   · a drag does not touch the document until the pointer comes up. While it
 *     is down there is a `DragPreview` — one pixel offset, one landing place,
 *     one refusal — recomputed by `previewDrag` and written to `--tl-dx`. So a
 *     cancelled drag needs no rollback and an undo stack gets one entry per
 *     gesture rather than one per pointermove.
 *   · pointermove / pointerup are bound to the window, not to the clip. The
 *     pointer leaves a 46px-tall clip immediately on any real drag, and
 *     `setPointerCapture` is not implemented everywhere the tests run.
 *
 * `overlap` is a policy of the editor, not of a call site: 「越界与重叠的处理规则
 * 要明确」 (§0.5) means the rule is chosen once and every gesture obeys it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { moveClip, moveClipBy, type OverlapPolicy } from './dragMove';
import { previewDrag, previewSlip, type DragPreview } from './dragPreview';
import { adjacentTrackOfKind } from './geometry';
import { razorAt, splitClipAt } from './razor';
import { liftDelete, rippleDelete, type RippleScope } from './rippleEdit';
import { slipClip } from './slip';
import {
  getClip,
  linkGroup,
  timelineDuration,
  withPlayhead,
  type EditRefusal,
  type EditResult,
  type Timeline,
} from './timelineModel';
import { createTimeScale, nextZoom, zoomAtAnchor, type TimeScale } from './timeScale';

/** The artboard's toolbar: 选择 · 剃刀 · 滑移. */
export type TimelineTool = 'select' | 'razor' | 'slip';

export interface DragState extends DragPreview {
  clipId: string;
  mode: 'move' | 'slip';
  /** Seconds of slip requested so far, before `slipClip` clamps it. */
  slipDelta: number;
}

interface DragOrigin {
  clipId: string;
  originX: number;
  originY: number;
  mode: 'move' | 'slip';
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
  moveSelectionToAdjacentTrack: (direction: 1 | -1) => void;
  undo: () => void;
  redo: () => void;

  beginClipDrag: (clipId: string, event: { clientX: number; clientY: number }) => void;
  cancelDrag: () => void;
}

export function useTimelineEditor({
  initial,
  overlap = 'reject',
  nudgeSeconds = 0.1,
  snapThresholdPx,
  rippleScope = 'linked',
}: UseTimelineEditorOptions): TimelineEditor {
  const [history, setHistory] = useState<History>({ past: [], present: initial, future: [] });
  const [zoom, setZoomValue] = useState(1);
  const [tool, setTool] = useState<TimelineTool>('select');
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<EditRefusal | null>(null);
  const [scrollPx, setScrollPx] = useState(0);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dragClipId, setDragClipId] = useState<string | null>(null);

  const dragOrigin = useRef<DragOrigin | null>(null);
  const dragState = useRef<DragState | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  const timeline = history.present;
  const scale = useMemo(() => createTimeScale(zoom), [zoom]);

  /** Push a successful edit; surface the reason for a refused one. */
  const commit = useCallback((result: EditResult) => {
    if (!result.applied) {
      setRefusal(result.reason ?? null);
      return false;
    }
    setRefusal(null);
    setHistory((current) => ({
      past: [...current.past, current.present],
      present: result.timeline,
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
    setHistory((current) => ({ ...current, present: withPlayhead(current.present, seconds) }));
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

  const beginClipDrag = useCallback(
    (clipId: string, event: { clientX: number; clientY: number }) => {
      setSelectedClipId(clipId);
      if (tool === 'razor') {
        commit(splitClipAt(timeline, clipId, timeline.playhead));
        return;
      }
      const mode = tool === 'slip' ? 'slip' : 'move';
      dragOrigin.current = { clipId, originX: event.clientX, originY: event.clientY, mode };
      const clip = getClip(timeline, clipId);
      const initialState: DragState = {
        clipId,
        mode,
        slipDelta: 0,
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
    [commit, timeline, tool],
  );

  const cancelDrag = useCallback(() => {
    dragOrigin.current = null;
    dragState.current = null;
    setDrag(null);
    setDragClipId(null);
  }, []);

  useEffect(() => {
    if (dragClipId === null) return undefined;

    const handleMove = (event: PointerEvent) => {
      const origin = dragOrigin.current;
      if (origin === null) return;
      const deltaXPx = event.clientX - origin.originX;
      const deltaYPx = event.clientY - origin.originY;

      const next: DragState =
        origin.mode === 'slip'
          ? {
              ...(dragState.current ?? { clipId: origin.clipId, start: 0, trackId: '', snap: null, refusal: null }),
              clipId: origin.clipId,
              mode: 'slip',
              offsetPx: 0,
              slipDelta: previewSlip(scale, deltaXPx),
            }
          : {
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
              slipDelta: 0,
            };

      dragState.current = next;
      setDrag(next);
    };

    const handleUp = () => {
      const origin = dragOrigin.current;
      const state = dragState.current;
      dragOrigin.current = null;
      dragState.current = null;
      setDrag(null);
      setDragClipId(null);
      if (origin === null || state === null) return;

      if (origin.mode === 'slip') {
        if (state.slipDelta !== 0) commit(slipClip(timeline, origin.clipId, state.slipDelta));
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
  }, [cancelDrag, commit, dragClipId, overlap, scale, snapEnabled, snapThresholdPx, timeline]);

  const linkedClipIds = useMemo(() => {
    if (selectedClipId === null) return new Set<string>();
    return new Set(linkGroup(timeline, selectedClipId).map((clip) => clip.id));
  }, [selectedClipId, timeline]);

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
    lengthSeconds: Math.max(timelineDuration(timeline), timeline.playhead),
    nudgeSeconds,
    scrollPx,
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
    moveSelectionToAdjacentTrack,
    undo,
    redo,

    beginClipDrag,
    cancelDrag,
  };
}

/** Seconds a keyboard nudge should travel, given the modifier state. */
export function nudgeStep(base: number, shiftKey: boolean): number {
  return shiftKey ? base * 10 : base;
}

/*
 * Design system, layer 1 of 3 — multi-track timeline prototype (spec §0.5).
 *
 * Two halves, and the split is the point of the whole exercise:
 *
 *   the model    `timelineModel` `timeScale` `snapping` `razor` `dragMove`
 *                `rippleEdit` `slip` `dragPreview` `geometry` — pure
 *                functions, no React, no DOM, exhaustively tested in the node
 *                project. Stage 3f can keep all of this whatever it decides
 *                about the rendering.
 *   the view     `TimelinePrototype` and the four components it is built from,
 *                plus `useTimelineEditor` — the only file that knows both.
 *
 * See README.md for what works, what does not, and where
 * `@xzdarcy/react-timeline-editor` is still ahead.
 */

/* ── model ─────────────────────────────────────────────────────────────── */

export {
  clipAt,
  clipContains,
  clipEnd,
  clipIdSet,
  clipsOnTrack,
  clipsOverlap,
  clipSourceOut,
  clipSourceSpan,
  createTimeline,
  DEFAULT_FPS,
  findOverlapping,
  getClip,
  getTrack,
  linkGroup,
  linkIdSet,
  MAX_CLIP_SPEED,
  MIN_CLIP_SPEED,
  mintId,
  patchClips,
  rangesOverlap,
  refuse,
  removeClips,
  slipRange,
  sortClips,
  timelineDuration,
  trackIndex,
  trimHeadroom,
  withClips,
  withMarkers,
  withPlayhead,
  type Clip,
  type ClipInput,
  type EditRefusal,
  type EditResult,
  type Marker,
  type Timeline,
  type TimelineInput,
  type Track,
  type TrackKind,
} from './timelineModel';

export {
  ceilToFrame,
  floorToFrame,
  frameAt,
  frameDuration,
  isOnFrame,
  quantizeClip,
  quantizeTimeline,
  quantizeToFrame,
} from './frameGrid';

export {
  groupTrimRange,
  trimClip,
  trimPreview,
  trimRange,
  type TrimEdge,
  type TrimOptions,
  type TrimResult,
} from './trim';

export { durationAtSpeed, setClipSpeed, speedToFit, type SpeedOptions, type SpeedResult } from './speed';

export {
  advanceScroll,
  autoScrollVelocity,
  DEFAULT_EDGE_BAND_PX,
  DEFAULT_MAX_AUTO_SCROLL_PX_PER_SECOND,
  maxScrollPx,
  type AutoScrollInput,
} from './autoScroll';

export {
  culledClipCount,
  DEFAULT_OVERSCAN_PX,
  visibleClips,
  visibleTimeRange,
  type TimelineViewport,
  type VirtualizeOptions,
} from './virtualize';

export {
  BASE_PIXELS_PER_SECOND,
  chooseTickStep,
  clampZoom,
  createTimeScale,
  formatFrameTimecode,
  formatTimecode,
  MAX_ZOOM,
  MIN_ZOOM,
  nextZoom,
  pxToTime,
  rulerTicks,
  timeAtViewportPx,
  timeToPx,
  TIME_EPSILON,
  ZOOM_STEPS,
  zoomAtAnchor,
  type RulerTick,
  type RulerTickOptions,
  type TimeScale,
} from './timeScale';

export {
  collectSnapTargets,
  DEFAULT_SNAP_THRESHOLD_PX,
  snapClipStart,
  snapRadiusSeconds,
  snapTime,
  type CollectOptions,
  type EdgeSnapResult,
  type SnapKind,
  type SnapOptions,
  type SnapResult,
  type SnapTarget,
} from './snapping';

export { canRazorAt, razorAt, seamsOnTrack, splitClipAt, type RazorResult, type SplitOptions } from './razor';

export {
  moveClip,
  moveClipBy,
  planMove,
  type MoveOptions,
  type MovePlan,
  type MoveResult,
  type OverlapPolicy,
  type Placement,
} from './dragMove';

export {
  liftDelete,
  rippleDelete,
  rippleImpact,
  trackDuration,
  type RippleOptions,
  type RippleResult,
  type RippleScope,
} from './rippleEdit';

export { groupSlipRange, slipClip, slipPreview, type SlipOptions, type SlipResult } from './slip';

export { previewDrag, previewSlip, type DragPreview, type DragPreviewInput } from './dragPreview';

export {
  adjacentTrackOfKind,
  CLIP_INSET_PX,
  PLAYHEAD_FLAG_PX,
  RULER_HEIGHT_PX,
  TRACK_HEIGHT_PX,
  trackAfterVerticalDrag,
  trackAreaHeight,
  trackAtOffset,
  trackBands,
  type TrackBand,
} from './geometry';

export { createLinearTimeline, createSampleTimeline } from './sampleTimeline';

/* ── view ──────────────────────────────────────────────────────────────── */

export { ClipView, type ClipViewProps } from './ClipView';
export { MarkerLayer, Playhead, type MarkerLayerProps, type PlayheadProps } from './Playhead';
export { TimeRuler, type TimeRulerProps } from './TimeRuler';
export { TrackHead, type TrackHeadProps } from './TrackHead';
export { TimelinePrototype, type TimelinePrototypeProps } from './TimelinePrototype';
export { timelineStyle, type TimelineVars } from './style';
export {
  nudgeStep,
  useTimelineEditor,
  type DragMode,
  type DragState,
  type PointerGesture,
  type TimelineEditor,
  type TimelineTool,
  type UseTimelineEditorOptions,
} from './useTimelineEditor';

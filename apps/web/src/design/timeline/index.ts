export {
  formatFrameTimecode,
  formatMillisecondTimecode,
  formatTimecode,
  TIME_EPSILON,
} from './timeScale';
export { DEFAULT_TIMELINE_MARKER_COLOR } from './marker';
export { DEFAULT_EDITOR_TEXT_BACKGROUND, DEFAULT_EDITOR_TEXT_COLOR } from './editorText';
export {
  formatTimelinePosition,
  parseTimelinePosition,
  type TimelineTimeDisplayMode,
} from './timelineTimecode';

export function nudgeStep(base: number, shiftKey: boolean): number {
  return shiftKey ? base * 10 : base;
}

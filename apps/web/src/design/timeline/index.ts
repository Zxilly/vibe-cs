export {
  formatFrameTimecode,
  formatMillisecondTimecode,
  formatTimecode,
  TIME_EPSILON,
} from './timeScale';
export { DEFAULT_TIMELINE_MARKER_COLOR } from './marker';

export function nudgeStep(base: number, shiftKey: boolean): number {
  return shiftKey ? base * 10 : base;
}

export {
  formatFrameTimecode,
  formatTimecode,
  TIME_EPSILON,
} from './timeScale';

export function nudgeStep(base: number, shiftKey: boolean): number {
  return shiftKey ? base * 10 : base;
}

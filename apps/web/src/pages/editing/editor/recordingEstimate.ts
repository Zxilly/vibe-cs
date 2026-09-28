import { CS2_TICK_RATE } from '../../../domain/match/matchTime';
import type { CaptureIntent } from '../../../shared/desktop/dto';

/*
 * A rough guide for the recording confirmation, not a schedule. Capture runs
 * CS2 in real time, so the recorded footage is the floor. On top of it the
 * session launches CS2 once, and every clip loads its Demo, seeks, waits for
 * the observer to settle and finalizes its file. None of those are measured
 * here; the two constants are deliberately generous round numbers so the
 * estimate errs long.
 */
const RECORDING_LAUNCH_SECONDS = 60;
const RECORDING_CLIP_OVERHEAD_SECONDS = 20;

export interface RecordingEstimate {
  /** Footage captured, pre and post roll included. */
  readonly recordedSeconds: number;
  /** Wall time the machine is likely busy, rounded up to whole minutes. */
  readonly wallMinutes: number;
}

/** Seconds one Capture Intent records. The intent carries no tick rate; CS2 Demos are 64 tick. */
export function captureIntentSeconds(intent: CaptureIntent): number {
  return (intent.end_tick - intent.start_tick) / CS2_TICK_RATE
    + intent.pre_roll_seconds
    + intent.post_roll_seconds;
}

export function recordingEstimate(intents: readonly CaptureIntent[]): RecordingEstimate {
  const recordedSeconds = intents.reduce((total, intent) => total + captureIntentSeconds(intent), 0);
  const wallSeconds = RECORDING_LAUNCH_SECONDS
    + recordedSeconds
    + intents.length * RECORDING_CLIP_OVERHEAD_SECONDS;
  return { recordedSeconds, wallMinutes: Math.max(1, Math.ceil(wallSeconds / 60)) };
}

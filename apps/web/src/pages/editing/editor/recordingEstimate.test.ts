import { describe, expect, it } from 'vitest';

import type { CaptureIntent } from '../../../shared/desktop/dto';
import { captureIntentSeconds, recordingEstimate } from './recordingEstimate';

function intent(startTick: number, endTick: number, pre = 1.5, post = 1): CaptureIntent {
  return {
    demo_id: 'demo-1', highlight_id: null, player_id: '76561197960266729',
    start_tick: startTick, end_tick: endTick,
    pre_roll_seconds: pre, post_roll_seconds: post,
    victim_pov: false, camera_style: 'pov', presentation: null,
  };
}

describe('recordingEstimate', () => {
  it('records the event range plus its pre and post roll at 64 tick', () => {
    expect(captureIntentSeconds(intent(6_400, 7_040))).toBe(12.5);
    expect(captureIntentSeconds(intent(0, 640, 0, 0))).toBe(10);
  });

  it('sums the recorded footage across clips', () => {
    expect(recordingEstimate([intent(0, 640), intent(0, 1_280)]).recordedSeconds).toBe(35);
  });

  it('adds a launch and per-clip overhead and rounds the wall time up to whole minutes', () => {
    // 60 launch + 35 recorded + 2 × 20 overhead = 135 s → 3 minutes.
    expect(recordingEstimate([intent(0, 640), intent(0, 1_280)]).wallMinutes).toBe(3);
    expect(recordingEstimate([intent(0, 64, 0, 0)]).wallMinutes).toBe(2);
  });

  it('never promises less than a minute', () => {
    expect(recordingEstimate([]).wallMinutes).toBe(1);
  });
});

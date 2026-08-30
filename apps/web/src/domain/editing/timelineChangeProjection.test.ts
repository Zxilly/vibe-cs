import { describe, expect, it } from 'vitest';

import type { ProjectChangeGroup, TimelineClip } from '../../shared/desktop/dto';
import { projectStoryTimelineChanges } from './timelineChangeProjection';

const STORY_ID = '00000000-0000-4000-8000-000000000001';

function clip(id: string, start: number, duration: number): TimelineClip {
  return {
    id,
    name: id,
    capture_intent: null,
    material: { kind: 'asset', asset_id: `asset-${id}`, media_duration_seconds: 120 },
    placement: { start, duration, source_in: 0, source_out: duration, speed: 1, volume: 1, enabled: true },
    transform: { x: 0, y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
    effects: [],
    transitions: { video_in: null, video_out: null, audio_in: null, audio_out: null },
    text: null,
    metadata: {},
    group_id: null,
    link_group_id: null,
    keyframes: [],
    speed_segments: [],
  };
}

function group(current: readonly TimelineClip[], previous: readonly TimelineClip[]): ProjectChangeGroup {
  return {
    id: '00000000-0000-4000-8000-000000000010',
    project_id: '00000000-0000-4000-8000-000000000011',
    from_revision: 1,
    to_revision: 2,
    author: {
      kind: 'agent',
      session_id: '00000000-0000-4000-8000-000000000012',
      turn_id: '00000000-0000-4000-8000-000000000013',
    },
    status: 'completed',
    summary: '替换片段并波纹调整',
    reverts_change_group_id: null,
    operations: [{ op: 'replace_track_clips', track_id: STORY_ID, clips: [...current] }],
    inverse_operations: [{ op: 'replace_track_clips', track_id: STORY_ID, clips: [...previous] }],
    created_at: '2026-08-29T00:00:00Z',
    completed_at: '2026-08-29T00:00:01Z',
  };
}

describe('timeline Change Group projection', () => {
  it('shows a non-equal replacement with its original out point and ripple delta', () => {
    const previous = [clip('intro', 0, 36), clip('hold', 36, 18), clip('outro', 54, 30)];
    const current = [clip('intro', 0, 36), clip('hold', 36, 28.4), clip('outro', 64.4, 30)];

    const projection = projectStoryTimelineChanges(current, STORY_ID, group(current, previous));

    expect(projection.previousDuration).toBe(84);
    expect(projection.currentDuration).toBe(94.4);
    expect(projection.changes).toHaveLength(2);
    expect(projection.changes[0]).toMatchObject({
      kind: 'modified',
      clipId: 'hold',
      originalOut: 54,
    });
    expect(projection.changes[0]?.durationDelta).toBeCloseTo(10.4);
    expect(projection.changes[1]).toMatchObject({
      kind: 'modified',
      clipId: 'outro',
      durationDelta: 0,
      rippleOnly: true,
    });
    expect(projection.changes[1]?.startDelta).toBeCloseTo(10.4);
  });

  it('projects inserted and removed clips directly over the current time geometry', () => {
    const previous = [clip('a', 0, 10), clip('removed', 10, 5)];
    const current = [clip('a', 0, 10), clip('added', 10, 8)];

    const projection = projectStoryTimelineChanges(current, STORY_ID, group(current, previous));

    expect(projection.changes.map((change) => [change.kind, change.clipId])).toEqual([
      ['added', 'added'],
      ['removed', 'removed'],
    ]);
  });

  it('returns no inline changes when a group has no Story inverse operation', () => {
    const clips = [clip('a', 0, 10)];
    const unrelated = {
      ...group(clips, clips),
      inverse_operations: [{ op: 'rename_project' as const, name: 'old' }],
    };

    expect(projectStoryTimelineChanges(clips, STORY_ID, unrelated).changes).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';

import type { Project } from '../../shared/desktop/dto';
import { collectedClipsPatch, timelineClipFromCollected, type ProjectCollectedClip } from './collectedClip';

const SOURCE: ProjectCollectedClip = {
  id: 'demo-a:selection:manual',
  demoId: '00000000-0000-4000-8000-000000000001',
  matchLabel: 'FURIA vs Falcons',
  kind: 'selection',
  label: 'NiKo · 149 000–149 640',
  round: 21,
  playerId: '76561198041683378',
  highlightId: null,
  evidenceId: null,
  startTick: 149_000,
  endTick: 149_640,
  durationSeconds: 12.5,
  addedAt: '2026-09-03T00:00:00Z',
};

describe('timelineClipFromCollected', () => {
  it('turns a manually marked Demo range into a visible recordable clip', () => {
    const clip = timelineClipFromCollected(SOURCE);

    expect(clip.material).toEqual({ kind: 'planned' });
    expect(clip.placement).toMatchObject({ duration: 12.5, source_in: 0, source_out: 12.5 });
    expect(clip.capture_intent).toMatchObject({
      demo_id: SOURCE.demoId,
      player_id: SOURCE.playerId,
      start_tick: SOURCE.startTick,
      end_tick: SOURCE.endTick,
      camera_style: 'pov',
    });
  });

  it('appends several collected clips after the existing Story instead of overlapping them', () => {
    const existing = timelineClipFromCollected({ ...SOURCE, id: 'existing', durationSeconds: 5 });
    existing.id = '00000000-0000-4000-8000-000000000010';
    const project: Project = {
      id: '00000000-0000-4000-8000-000000000020',
      name: 'NiKo edit',
      revision: 3,
      document: {
        width: 1920,
        height: 1080,
        fps: 60,
        duration_seconds: 5,
        story_track_id: '00000000-0000-4000-8000-000000000030',
        tracks: [{
          id: '00000000-0000-4000-8000-000000000030',
          name: 'Story',
          kind: 'video',
          order: 0,
          muted: false,
          solo: false,
          volume: 1,
          pan: 0,
          keyframes: [],
          locked: false,
          hidden: false,
          clips: [existing],
        }],
        markers: [],
        settings: { source_demo_ids: [SOURCE.demoId], ripple_sequence_markers: false, use_media_proxies: false },
      },
      created_at: SOURCE.addedAt,
      updated_at: SOURCE.addedAt,
    };

    const patch = collectedClipsPatch(project, [SOURCE, { ...SOURCE, id: 'second', durationSeconds: 4 }]);
    const inserted = patch.operations.filter((operation) => operation.op === 'insert_clip');

    expect(inserted.map((operation) => operation.clip.placement.start)).toEqual([5, 17.5]);
  });
});

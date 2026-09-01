import { describe, expect, it } from 'vitest';

import type { EditingDocument, MediaAsset, TimelineTrack } from '../../shared/desktop/dto';
import { planAutomateToSequence } from './automateSequence';

const asset = (id: string, name: string, duration = 4): MediaAsset => ({
  id,
  project_id: 'project',
  path: `D:\\media\\${id}.mp4`,
  name,
  kind: 'video',
  duration_seconds: duration,
  width: 1920,
  height: 1080,
  file_size: 1,
  has_audio: true,
  proxy_path: null,
  proxy_status: { status: 'not_requested' },
  waveform: null,
  metadata_status: { status: 'ready' },
  markers: [],
  created_at: '2026-09-02T00:00:00Z',
});

const story: TimelineTrack = {
  id: 'story', name: 'Story', kind: 'video', order: 0, muted: false, solo: false,
  volume: 1, pan: 0, keyframes: [], locked: false, hidden: false, clips: [],
};

const document = (markers: EditingDocument['markers'] = []): EditingDocument => ({
  width: 1920,
  height: 1080,
  fps: 60,
  duration_seconds: 0,
  story_track_id: story.id,
  tracks: [story],
  markers,
  settings: { source_demo_ids: [], ripple_sequence_markers: false, use_media_proxies: false },
});

function ids() {
  let next = 0;
  return () => `generated-${++next}`;
}

describe('Automate to Sequence planning', () => {
  it('assembles Project order sequentially and applies one default transition per cut', () => {
    const plan = planAutomateToSequence({
      document: document(),
      assets: [asset('b', 'B'), asset('a', 'A')],
      placement: 'sequential',
      method: 'insert',
      startTime: 0,
      applyDefaultTransitions: true,
      createId: ids(),
    });
    expect(plan?.insertedClipIds).toEqual(['generated-1', 'generated-2']);
    const operation = plan?.operations[0];
    if (operation?.op !== 'replace_track_clips') throw new Error('expected Story replacement');
    expect(operation.clips.map((clip) => [clip.name, clip.placement.start, clip.placement.duration])).toEqual([
      ['B', 0, 3.5],
      ['A', 3.5, 3.5],
    ]);
    expect(operation.clips[0]?.transitions.video_out?.duration_seconds).toBe(0.25);
    expect(operation.clips[1]?.transitions.video_in?.duration_seconds).toBe(0.25);
  });

  it('places selection order at sequence markers without transitions', () => {
    const markers = [
      { id: 'm2', time: 8, duration: 0, label: 'M2', color: '#2F6FED', kind: 'comment' as const, comment: '' },
      { id: 'm1', time: 2, duration: 0, label: 'M1', color: '#2F6FED', kind: 'comment' as const, comment: '' },
    ];
    const plan = planAutomateToSequence({
      document: document(markers),
      assets: [asset('a', 'First'), asset('b', 'Second')],
      placement: 'markers',
      method: 'overwrite',
      startTime: 0,
      applyDefaultTransitions: true,
      createId: ids(),
    });
    const operation = plan?.operations[0];
    if (operation?.op !== 'replace_track_clips') throw new Error('expected Story replacement');
    expect(operation.clips.map((clip) => [clip.name, clip.placement.start])).toEqual([
      ['First', 2],
      ['Second', 8],
    ]);
    expect(operation.clips.every((clip) => clip.transitions.video_in === null && clip.transitions.video_out === null)).toBe(true);
  });
});

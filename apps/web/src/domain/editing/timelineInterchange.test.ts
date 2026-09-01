// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import type { MediaAsset, Project, TimelineClip, TimelineTrack } from '../../shared/desktop/dto';
import { exportTimelineInterchange, importTimelineInterchange, interchangeFormatFromPath } from './timelineInterchange';

const STORY_ID = '00000000-0000-4000-8000-000000000001';
const ASSET_ID = '00000000-0000-4000-8000-000000000002';

function clip(id: string, name: string, start: number, sourceIn: number, duration: number): TimelineClip {
  return {
    id,
    name,
    capture_intent: null,
    material: { kind: 'asset', asset_id: ASSET_ID, media_duration_seconds: 30 },
    placement: { start, duration, source_in: sourceIn, source_out: sourceIn + duration, speed: 1, reverse: false, frame_hold_source_time: null, volume: 1, pan: 0, enabled: true },
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

const STORY: TimelineTrack = {
  id: STORY_ID,
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
  clips: [
    clip('00000000-0000-4000-8000-000000000010', 'Opening & setup', 0, 2, 3),
    clip('00000000-0000-4000-8000-000000000011', 'Payoff', 5, 8, 2),
  ],
};

const AUDIO: TimelineTrack = {
  ...STORY,
  id: '00000000-0000-4000-8000-000000000012',
  name: 'Music',
  kind: 'audio',
  order: 1,
  clips: [clip('00000000-0000-4000-8000-000000000013', 'Bed', 0, 0, 7)],
};

const PROJECT: Project = {
  id: '00000000-0000-4000-8000-000000000020',
  name: 'Interchange <Audit>',
  revision: 4,
  document: {
    width: 1920,
    height: 1080,
    fps: 60,
    duration_seconds: 7,
    story_track_id: STORY_ID,
    tracks: [STORY, AUDIO],
    markers: [],
    settings: { source_demo_ids: [], ripple_sequence_markers: false, use_media_proxies: false },
  },
  created_at: '2026-09-02T00:00:00Z',
  updated_at: '2026-09-02T00:00:00Z',
};

const ASSET: MediaAsset = {
  id: ASSET_ID,
  project_id: PROJECT.id,
  path: 'C:\\Media\\major source.mp4',
  name: 'Major Source',
  kind: 'video',
  duration_seconds: 30,
  width: 1920,
  height: 1080,
  file_size: 10,
  has_audio: true,
  proxy_path: null,
  proxy_status: { status: 'not_requested' },
  waveform: null,
  metadata_status: { status: 'ready' },
  markers: [],
  created_at: '2026-09-02T00:00:00Z',
};

function ids(): () => string {
  let value = 100;
  return () => `00000000-0000-4000-8000-${String(value++).padStart(12, '0')}`;
}

describe('timeline interchange', () => {
  it('round-trips OTIO multitrack timing, gaps and linked media through one Project operation plan', () => {
    const exported = exportTimelineInterchange(PROJECT, [ASSET], 'otio');
    const parsed = JSON.parse(exported.text);
    expect(parsed.OTIO_SCHEMA).toBe('Timeline.1');
    expect(parsed.tracks.children).toHaveLength(2);
    expect(parsed.tracks.children[0].children[1].OTIO_SCHEMA).toBe('Gap.1');

    const imported = importTimelineInterchange(exported.text, 'otio', PROJECT.document, [ASSET], ids());
    expect(imported).toMatchObject({ trackCount: 2, clipCount: 3, warnings: [] });
    expect(imported.operations[0]).toMatchObject({
      op: 'replace_track',
      track_id: STORY_ID,
      track: {
        id: STORY_ID,
        kind: 'video',
        clips: [
          { name: 'Opening & setup', material: { kind: 'asset', asset_id: ASSET_ID }, placement: { start: 0, source_in: 2, source_out: 5 } },
          { name: 'Payoff', material: { kind: 'asset', asset_id: ASSET_ID }, placement: { start: 5, source_in: 8, source_out: 10 } },
        ],
      },
    });
    expect(imported.operations).toContainEqual(expect.objectContaining({ op: 'insert_track', index: 1, track: expect.objectContaining({ kind: 'audio', name: 'Music' }) }));
  });

  it('exports and imports the documented Story-only Final Cut Pro XML subset', () => {
    const exported = exportTimelineInterchange(PROJECT, [ASSET], 'xml');
    expect(exported.text).toContain('<xmeml version="5">');
    expect(exported.text).toContain('Interchange &lt;Audit&gt;');
    expect(exported.warnings).toEqual(['Final Cut Pro XML subset exports Story video only; 1 non-Story track(s) were omitted.']);
    const imported = importTimelineInterchange(exported.text, 'xml', PROJECT.document, [ASSET], ids());
    expect(imported.clipCount).toBe(2);
    expect(imported.operations[0]).toMatchObject({
      op: 'replace_track',
      track: { clips: [
        { name: 'Opening & setup', placement: { start: 0, duration: 3, source_in: 2, source_out: 5 } },
        { name: 'Payoff', placement: { start: 5, duration: 2, source_in: 8, source_out: 10 } },
      ] },
    });
  });

  it('exports and imports the documented Story-only CMX3600 EDL subset', () => {
    const exported = exportTimelineInterchange(PROJECT, [ASSET], 'edl');
    expect(exported.text).toContain('FCM: NON-DROP FRAME');
    expect(exported.text).toContain('00:00:02:00 00:00:05:00 00:00:00:00 00:00:03:00');
    expect(exported.warnings).toHaveLength(1);
    const imported = importTimelineInterchange(exported.text, 'edl', PROJECT.document, [ASSET], ids());
    expect(imported.clipCount).toBe(2);
    expect(imported.operations[0]).toMatchObject({ op: 'replace_track', track: { clips: [
      { name: 'Opening & setup', material: { kind: 'asset', asset_id: ASSET_ID } },
      { name: 'Payoff', placement: { start: 5 } },
    ] } });
  });

  it('detects only the three explicit extensions and rejects invalid roots', () => {
    expect(interchangeFormatFromPath('cut.OTIO')).toBe('otio');
    expect(interchangeFormatFromPath('cut.xml')).toBe('xml');
    expect(interchangeFormatFromPath('cut.edl')).toBe('edl');
    expect(interchangeFormatFromPath('cut.aaf')).toBeNull();
    expect(() => importTimelineInterchange('{}', 'otio', PROJECT.document, [ASSET], ids())).toThrow(/Timeline/u);
    expect(() => importTimelineInterchange('TITLE: empty', 'edl', PROJECT.document, [ASSET], ids())).toThrow(/no supported video events/u);
  });
});

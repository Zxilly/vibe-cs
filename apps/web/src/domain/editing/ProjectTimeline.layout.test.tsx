import { beforeAll, describe, expect, it } from 'vitest';
import { i18n } from '@lingui/core';

import type { EditingDocument, TimelineTrack } from '../../shared/desktop/dto';
import { timelineTrackLayout } from './timelineTrackLayout';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'zh-CN', messages: {} });
});

function track(id: string, kind: TimelineTrack['kind'], order: number): TimelineTrack {
  return {
    id,
    name: id,
    kind,
    order,
    muted: false,
    solo: false,
    volume: 1,
    pan: 0,
    keyframes: [],
    locked: false,
    hidden: false,
    clips: [],
  };
}

function document(tracks: TimelineTrack[]): EditingDocument {
  return {
    width: 1920,
    height: 1080,
    fps: 60,
    duration_seconds: 8,
    story_track_id: 'story',
    tracks,
    markers: [],
    settings: { source_demo_ids: [], ripple_sequence_markers: true, use_media_proxies: false },
  };
}

describe('Premiere-style rendered track layout', () => {
  it('stacks numbered video tracks above numbered audio tracks', () => {
    const rows = timelineTrackLayout(document([
      track('story', 'video', 0),
      track('music', 'audio', 1),
      track('angle-2', 'video', 2),
      track('angle-3', 'video', 3),
    ]));

    expect(rows.map((row) => [row.track.id, row.kind, row.targetLabel, row.derivedAudio])).toEqual([
      ['angle-3', 'video', 'V3', false],
      ['angle-2', 'video', 'V2', false],
      ['story', 'video', 'V1', false],
      ['story', 'audio', 'A1', true],
      ['music', 'audio', 'A2', false],
    ]);
  });
});

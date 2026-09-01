import { describe, expect, it } from 'vitest';

import type { TimelineClipboard } from './timelinePaste';
import {
  readTimelineClipboard,
  readTimelineWorkspaceSession,
  timelineClipboardKey,
  timelineWorkspaceSessionKey,
  writeTimelineClipboard,
  writeTimelineWorkspaceSession,
  type TimelineSessionStorage,
  type TimelineWorkspaceSession,
} from './timelineWorkspaceSession';

function storage(): TimelineSessionStorage & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

const SESSION: TimelineWorkspaceSession = {
  selectedClipIds: ['clip'],
  targetTrackIds: ['story'],
  syncLockedTrackIds: ['story', 'audio'],
  linkedSelectionEnabled: true,
  timelineTimeSeconds: 4,
  rangeInSeconds: 2,
  rangeOutSeconds: 6,
  loopPlaybackEnabled: true,
};

const CLIPBOARD: TimelineClipboard = {
  originTime: 0,
  duration: 2,
  groups: [{
    trackId: 'story',
    trackKind: 'video',
    clips: [{
      id: 'clip', name: 'Clip', capture_intent: null,
      material: { kind: 'planned' },
      placement: { start: 0, duration: 2, source_in: 0, source_out: 2, speed: 1, volume: 1, pan: 0, enabled: true },
      transform: { x: 0, y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
      effects: [], transitions: { video_in: null, video_out: null, audio_in: null, audio_out: null },
      text: null, metadata: {}, group_id: null, link_group_id: null, keyframes: [], speed_segments: [],
    }],
  }],
};

describe('Timeline workspace crash recovery', () => {
  it('round-trips the exact current workspace and clipboard contracts', () => {
    const target = storage();
    writeTimelineWorkspaceSession('project', target, SESSION);
    writeTimelineClipboard('project', target, CLIPBOARD);
    expect(readTimelineWorkspaceSession('project', target)).toEqual(SESSION);
    expect(readTimelineClipboard('project', target)).toEqual(CLIPBOARD);
  });

  it('rejects stale or malformed local documents instead of migrating them', () => {
    const target = storage();
    target.values.set(timelineWorkspaceSessionKey('project'), JSON.stringify({ ...SESSION, timelineTimeSeconds: -1 }));
    target.values.set(timelineClipboardKey('project'), JSON.stringify({ ...CLIPBOARD, groups: [{ clips: [{}] }] }));
    expect(readTimelineWorkspaceSession('project', target)).toBeNull();
    expect(readTimelineClipboard('project', target)).toBeNull();
  });

  it('removes the persisted clipboard when the user clears it', () => {
    const target = storage();
    writeTimelineClipboard('project', target, CLIPBOARD);
    writeTimelineClipboard('project', target, null);
    expect(readTimelineClipboard('project', target)).toBeNull();
  });
});

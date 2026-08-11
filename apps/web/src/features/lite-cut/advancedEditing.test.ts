import { describe, expect, it, vi } from 'vitest';

import { activeTimelineClips, duplicateTimelineClip, hasSeparatedAudioChild, mapKillAxisEvents } from './advancedEditing';
import type { TimelineClip, TimelineTrack } from './timelineStore';

const clip = (): TimelineClip => ({
  id: 'clip-1', assetId: 'asset-1', name: 'Round', start: 10, duration: 4,
  sourceIn: 20, sourceOut: 26, speed: 1, volume: 1, color: '#fff',
  speedSegments: [
    { id: 'speed-1', start: 0, end: 2, speed: 2 },
    { id: 'speed-2', start: 2, end: 4, speed: 0.5 },
  ],
  keyframes: [{ id: 'key-1', time: 1, property: 'opacity', value: 0.5 }],
  metadata: {
    kill_events: [
      { id: 'kill-a', source_time: 22, attacker: 'A', victim: 'B' },
      { id: 'kill-b', source_time: 24.5, attacker: 'A', victim: 'C', weapon: 'ak47' },
      { id: 'outside', source_time: 40, attacker: 'A', victim: 'D' },
    ],
  },
});

describe('advanced editor mapping', () => {
  it('maps source kills through trim, move, and segmented speed', () => {
    expect(mapKillAxisEvents(clip())).toEqual([
      expect.objectContaining({ id: 'kill-a', timeline_time: 11 }),
      expect.objectContaining({ id: 'kill-b', timeline_time: 13 }),
    ]);
  });

  it('duplicates a clip with independent automation identifiers', () => {
    vi.stubGlobal('crypto', { randomUUID: vi.fn()
      .mockReturnValueOnce('copy')
      .mockReturnValueOnce('key-copy')
      .mockReturnValueOnce('speed-copy-a')
      .mockReturnValueOnce('speed-copy-b') });
    const result = duplicateTimelineClip(clip(), 14.5);
    expect(result).toMatchObject({ id: 'copy', start: 14.5, groupId: null, linkGroupId: null });
    expect(result.keyframes?.[0]?.id).toBe('key-copy');
    expect(result.speedSegments?.map((segment) => segment.id)).toEqual(['speed-copy-a', 'speed-copy-b']);
    vi.unstubAllGlobals();
  });

  it('resolves every visible timeline layer at the playhead in track order', () => {
    const base = clip();
    const tracks: TimelineTrack[] = [
      { id: 'video', name: 'Video', kind: 'video', muted: false, locked: false, clips: [base] },
      { id: 'hidden', name: 'Hidden', kind: 'overlay', muted: false, locked: false, hidden: true, clips: [{ ...base, id: 'hidden-clip' }] },
      { id: 'text', name: 'Text', kind: 'text', muted: false, locked: false, clips: [{ ...base, id: 'title', text: { content: 'Title', font_family: 'sans-serif', font_size: 32, color: '#fff', background: null, align: 'center', font_asset_id: null } }] },
      { id: 'audio', name: 'Audio', kind: 'audio', muted: false, locked: false, clips: [{ ...base, id: 'voice' }] },
    ];

    expect(activeTimelineClips(tracks, 11).map(({ clip: item, localTime, trackKind }) => ({
      id: item.id,
      localTime,
      trackKind,
    }))).toEqual([
      { id: 'clip-1', localTime: 1, trackKind: 'video' },
      { id: 'title', localTime: 1, trackKind: 'text' },
      { id: 'voice', localTime: 1, trackKind: 'audio' },
    ]);
    expect(activeTimelineClips(tracks, 14)).toEqual([]);
    expect(activeTimelineClips(tracks, Number.POSITIVE_INFINITY)).toEqual([]);
  });

  it('recognizes only linked detached-audio children and accepts legacy metadata', () => {
    const source = { ...clip(), linkGroupId: 'linked' };
    const tracks: TimelineTrack[] = [
      { id: 'video', name: 'Video', kind: 'video', muted: false, locked: false, clips: [source] },
      {
        id: 'audio',
        name: 'Audio',
        kind: 'audio',
        muted: false,
        locked: false,
        clips: [{
          ...clip(),
          id: 'audio-child',
          linkGroupId: 'linked',
          metadata: {
            audio_origin: { kind: 'separated_from_video', source_clip_id: source.id },
          },
        }],
      },
    ];
    expect(hasSeparatedAudioChild(tracks, source.id)).toBe(true);
    tracks[1]!.clips[0]!.metadata = { separated_from_clip_id: source.id };
    expect(hasSeparatedAudioChild(tracks, source.id)).toBe(true);
    tracks[1]!.clips[0]!.linkGroupId = 'unrelated';
    expect(hasSeparatedAudioChild(tracks, source.id)).toBe(false);
  });
});

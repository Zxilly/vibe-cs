import { describe, expect, it } from 'vitest';

import type { EditingDocument, TimelineClip, TimelineTrack } from '../../shared/desktop/dto';
import { timelineSelectionState, timelineTrackSelection } from './timelineSelection';

function clip(id: string, start: number): TimelineClip {
  return {
    id,
    name: id,
    capture_intent: null,
    material: { kind: 'planned' },
    placement: { start, duration: 5, source_in: 0, source_out: 5, speed: 1, reverse: false, frame_hold_source_time: null, volume: 1, pan: 0, enabled: true },
    transform: { x: 0, y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
    effects: [], transitions: { video_in: null, video_out: null, audio_in: null, audio_out: null }, text: null, metadata: {},
    group_id: null, link_group_id: null, keyframes: [], speed_segments: [],
  };
}

function track(id: string, order: number): TimelineTrack {
  return { id, name: id, kind: 'video', order, muted: false, solo: false, volume: 1, pan: 0, keyframes: [], locked: false, hidden: false, clips: [clip(`${id}-a`, 0), clip(`${id}-b`, 5), clip(`${id}-c`, 10)] };
}

function document(tracks: TimelineTrack[], storyTrackId = tracks[0]?.id ?? ''): EditingDocument {
  return {
    width: 1920,
    height: 1080,
    fps: 60,
    duration_seconds: 15,
    story_track_id: storyTrackId,
    tracks,
    markers: [],
    settings: {
      source_demo_ids: [],
      ripple_sequence_markers: true,
      use_media_proxies: true,
    },
  };
}

describe('Timeline Track Select', () => {
  it('selects the clicked clip and everything forward on one track', () => {
    expect(timelineTrackSelection({
      tracks: [track('v1', 0), track('v2', 1)],
      trackId: 'v1',
      timelineTime: 7,
      direction: 'forward',
      allTracks: false,
    })).toEqual(['v1-b', 'v1-c']);
  });

  it('selects backward across every track while preserving track order', () => {
    expect(timelineTrackSelection({
      tracks: [track('v2', 1), track('v1', 0)],
      trackId: 'v1',
      timelineTime: 7,
      direction: 'backward',
      allTracks: true,
    })).toEqual(['v1-a', 'v1-b', 'v2-a', 'v2-b']);
  });
});

describe('Human Selection state', () => {
  it('groups selected clips by document track order and excludes locked groups from edits', () => {
    const unlocked = track('v1', 0);
    const locked = { ...track('v2', 1), locked: true };
    const state = timelineSelectionState(
      document([unlocked, locked]),
      ['v2-a', 'v1-b'],
      false,
    );

    expect(state.selectedTrackGroups.map((group) => group.track.id)).toEqual(['v1', 'v2']);
    expect(state.selectedClips.map((item) => item.id)).toEqual(['v1-b', 'v2-a']);
    expect(state.editableSelectedTrackGroups.map((group) => group.track.id)).toEqual(['v1']);
    expect(state.canGroup).toBe(false);
  });

  it('derives shared links and disables every editing command during an Edit Lease', () => {
    const linked = track('v1', 0);
    linked.clips = linked.clips.map((item, index) => index < 2
      ? { ...item, link_group_id: 'linked' }
      : item);

    const editable = timelineSelectionState(document([linked]), ['v1-a', 'v1-b'], false);
    expect(editable.sharedLinkGroupId).toBe('linked');
    expect(editable.canChangeLinks).toBe(true);
    expect(editable.canGroup).toBe(true);

    const leased = timelineSelectionState(document([linked]), ['v1-a', 'v1-b'], true);
    expect(leased.canChangeLinks).toBe(false);
    expect(leased.canGroup).toBe(false);
    expect(leased.canUngroup).toBe(false);
    expect(leased.canNestSelection).toBe(false);
  });

  it('allows nesting only one contiguous Story selection and identifies one nested clip', () => {
    const story = track('story', 0);
    const contiguous = timelineSelectionState(document([story]), ['story-a', 'story-b'], false);
    expect(contiguous.canNestSelection).toBe(true);

    const disjoint = timelineSelectionState(document([story]), ['story-a', 'story-c'], false);
    expect(disjoint.canNestSelection).toBe(false);

    story.clips = story.clips.map((item, index) => index === 1
      ? {
        ...item,
        material: {
          kind: 'sequence' as const,
          project_id: 'nested',
          project_revision: 1,
          media_duration_seconds: item.placement.duration,
        },
      }
      : item);
    const nested = timelineSelectionState(document([story]), ['story-b'], false);
    expect(nested.selectedNestedClip?.id).toBe('story-b');
  });
});

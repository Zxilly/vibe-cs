import type { EditingDocument, TimelineClip, TimelineTrack } from '../../shared/desktop/dto';

interface TimelineSelectionGroup {
  readonly track: TimelineTrack;
  readonly clips: readonly TimelineClip[];
}

interface TimelineSelectionState {
  readonly selectedClipIdSet: ReadonlySet<string>;
  readonly selectedTrackGroups: readonly TimelineSelectionGroup[];
  readonly selectedClips: readonly TimelineClip[];
  readonly editableSelectedTrackGroups: readonly TimelineSelectionGroup[];
  readonly sharedLinkGroupId: string | null;
  readonly canChangeLinks: boolean;
  readonly canGroup: boolean;
  readonly canUngroup: boolean;
  readonly canNestSelection: boolean;
  readonly selectedNestedClip: TimelineClip | null;
}

/**
 * Derives every Human Selection fact used by the Project Timeline.
 *
 * Selection is Workspace View State: this function never changes the Editing
 * Document. Edit Lease read-only state is included only when deriving whether
 * visible edit commands are currently available.
 */
export function timelineSelectionState(
  document: EditingDocument,
  selectedClipIds: readonly string[],
  readOnly: boolean,
): TimelineSelectionState {
  const selectedClipIdSet = new Set(selectedClipIds);
  const selectedTrackGroups = document.tracks.flatMap((track) => {
    const clips = track.clips.filter((clip) => selectedClipIdSet.has(clip.id));
    return clips.length === 0 ? [] : [{ track, clips }];
  });
  const selectedClips = selectedTrackGroups.flatMap((group) => group.clips);
  const editableSelectedTrackGroups = selectedTrackGroups.filter((group) => !group.track.locked);
  const everySelectedTrackEditable = selectedTrackGroups.every((group) => !group.track.locked);
  const sharedLinkGroupId = selectedClips.length < 2
    ? null
    : selectedClips[0]?.link_group_id !== null
      && selectedClips.every((clip) => clip.link_group_id === selectedClips[0]?.link_group_id)
      ? selectedClips[0]!.link_group_id
      : null;
  const canEditSelection = !readOnly && everySelectedTrackEditable;
  const story = document.tracks.find((track) => track.id === document.story_track_id) ?? null;
  const selectedStoryIndices = story === null ? [] : story.clips.flatMap((clip, index) => (
    selectedClipIdSet.has(clip.id) ? [index] : []
  ));
  const canNestSelection = canEditSelection
    && selectedTrackGroups.length === 1
    && selectedTrackGroups[0]?.track.id === document.story_track_id
    && selectedStoryIndices.length > 0
    && selectedStoryIndices.at(-1)! - selectedStoryIndices[0]! + 1 === selectedStoryIndices.length;
  const selectedNestedClip = selectedClips.length === 1 && selectedClips[0]?.material.kind === 'sequence'
    ? selectedClips[0]
    : null;

  return {
    selectedClipIdSet,
    selectedTrackGroups,
    selectedClips,
    editableSelectedTrackGroups,
    sharedLinkGroupId,
    canChangeLinks: canEditSelection && selectedClips.length >= 2,
    canGroup: canEditSelection && selectedClips.length >= 2,
    canUngroup: canEditSelection && selectedClips.some((clip) => clip.group_id !== null),
    canNestSelection,
    selectedNestedClip,
  };
}

export function timelineTrackSelection({
  tracks,
  trackId,
  timelineTime,
  direction,
  allTracks,
}: {
  readonly tracks: readonly TimelineTrack[];
  readonly trackId: string;
  readonly timelineTime: number;
  readonly direction: 'forward' | 'backward';
  readonly allTracks: boolean;
}): string[] {
  return [...tracks]
    .sort((left, right) => left.order - right.order)
    .filter((track) => allTracks || track.id === trackId)
    .flatMap((track) => [...track.clips]
      .sort((left, right) => left.placement.start - right.placement.start)
      .filter((clip) => direction === 'forward'
        ? clip.placement.start + clip.placement.duration > timelineTime + 1e-9
        : clip.placement.start < timelineTime - 1e-9)
      .map((clip) => clip.id));
}

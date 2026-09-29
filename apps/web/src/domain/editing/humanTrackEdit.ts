import type { EditingDocument, ProjectEditOperation, ProjectPatchScope } from '../../shared/desktop/dto';
import { planRippleSequenceMarkers } from './timelineMarkers';
import { expandSyncLockedStoryRippleUpdates } from './timelineSyncLock';

/** Complete one Human Edit before binding it to the current Project revision. */
export function planHumanTrackEdit(
  document: EditingDocument,
  operations: readonly ProjectEditOperation[],
  syncLockedTrackIds: ReadonlySet<string>,
): { readonly scope: ProjectPatchScope; readonly operations: ProjectEditOperation[] } {
  const updates = operations.flatMap((operation) => operation.op === 'replace_track_clips'
    ? [{ trackId: operation.track_id, clips: operation.clips }]
    : []);
  const expanded = expandSyncLockedStoryRippleUpdates({
    tracks: document.tracks,
    storyTrackId: document.story_track_id,
    updates,
    syncLockedTrackIds,
    fps: document.fps,
  });
  const explicitMarkers = operations.find((operation) => operation.op === 'replace_markers')?.markers;
  const story = document.tracks.find((track) => track.id === document.story_track_id);
  const storyUpdate = expanded.find((update) => update.trackId === document.story_track_id);
  const markerPlan = story === undefined || storyUpdate === undefined
    ? null
    : planRippleSequenceMarkers(
        explicitMarkers ?? document.markers,
        story.clips,
        storyUpdate.clips,
        document.settings.ripple_sequence_markers,
        document.fps,
      );
  const markers = markerPlan?.markers ?? explicitMarkers;
  const completed: ProjectEditOperation[] = [
    ...operations.filter((operation) => operation.op !== 'replace_track_clips' && operation.op !== 'replace_markers'),
    ...expanded.map((update): ProjectEditOperation => ({
      op: 'replace_track_clips', track_id: update.trackId, clips: [...update.clips],
    })),
    ...(markers === undefined ? [] : [{ op: 'replace_markers' as const, markers: [...markers] }]),
  ];
  return {
    scope: completed.length === 1 && completed[0]?.op === 'replace_track_clips'
      ? { kind: 'track', track_id: completed[0].track_id }
      : { kind: 'project' },
    operations: completed,
  };
}

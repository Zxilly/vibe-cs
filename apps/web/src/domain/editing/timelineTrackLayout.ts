import type { EditingDocument, TimelineTrack } from '../../shared/desktop/dto';

export interface TimelineTrackLayoutRow {
  readonly id: string;
  readonly kind: 'video' | 'audio' | 'text' | 'caption';
  readonly targetLabel: string;
  readonly track: TimelineTrack;
  readonly derivedAudio: boolean;
}

export function timelineTrackLayout(document: EditingDocument): TimelineTrackLayoutRow[] {
  const tracks = [...document.tracks].sort((left, right) => left.order - right.order);
  const rows: TimelineTrackLayoutRow[] = [];
  let videoIndex = 0;
  let audioIndex = 0;
  let textIndex = 0;
  let captionIndex = 0;

  for (const track of tracks) {
    if (track.id === document.story_track_id) {
      rows.push({ id: `${track.id}:video`, kind: 'video', targetLabel: `V${videoIndex += 1}`, track, derivedAudio: false });
      rows.push({ id: `${track.id}:audio`, kind: 'audio', targetLabel: `A${audioIndex += 1}`, track, derivedAudio: true });
      continue;
    }

    const kind = track.kind === 'audio'
      ? 'audio'
      : track.kind === 'caption'
        ? 'caption'
        : track.kind === 'text'
          ? 'text'
          : 'video';
    const targetLabel = kind === 'video'
      ? `V${videoIndex += 1}`
      : kind === 'audio'
        ? `A${audioIndex += 1}`
        : kind === 'caption'
          ? `C${captionIndex += 1}`
          : `T${textIndex += 1}`;
    rows.push({ id: track.id, kind, targetLabel, track, derivedAudio: false });
  }

  return [
    ...rows.filter((row) => row.kind === 'caption').reverse(),
    ...rows.filter((row) => row.kind === 'text').reverse(),
    ...rows.filter((row) => row.kind === 'video').reverse(),
    ...rows.filter((row) => row.kind === 'audio'),
  ];
}

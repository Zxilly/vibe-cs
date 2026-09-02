import type {
  CaptureIntent,
  Project,
  ProjectPatch,
  TimelineClip,
} from '../../shared/desktop/dto';

export type CollectedClipKind = 'highlight' | 'round' | 'evidence' | 'player' | 'selection';

export interface ProjectCollectedClip {
  readonly id: string;
  readonly demoId: string;
  readonly matchLabel: string;
  readonly kind: CollectedClipKind;
  readonly label: string;
  readonly round: number | null;
  readonly playerId: string | null;
  readonly highlightId: string | null;
  readonly evidenceId: string | null;
  readonly startTick: number | null;
  readonly endTick: number | null;
  readonly durationSeconds: number | null;
  readonly addedAt: string;
}

export function collectedClipsPatch(
  project: Project,
  clips: readonly ProjectCollectedClip[],
): ProjectPatch {
  const story = project.document.tracks.find((track) => track.id === project.document.story_track_id);
  const startIndex = story?.clips.length ?? 0;
  let timelineStart = story?.clips.reduce(
    (end, clip) => Math.max(end, clip.placement.start + clip.placement.duration),
    0,
  ) ?? 0;
  const sourceDemoIds = [...new Set([
    ...project.document.settings.source_demo_ids,
    ...clips.map((clip) => clip.demoId),
  ])];
  return {
    project_id: project.id,
    base_revision: project.revision,
    scope: { kind: 'project' },
    author: { kind: 'human' },
    reverts_change_group_id: null,
    summary: clips.length === 1 ? `加入 ${clips[0]?.label ?? '素材'}` : `加入 ${String(clips.length)} 个素材`,
    operations: [
      {
        op: 'replace_settings',
        settings: { source_demo_ids: sourceDemoIds, ripple_sequence_markers: false, use_media_proxies: false },
      },
      ...clips.map((clip, offset) => {
        const timelineClip = timelineClipFromCollected(clip);
        timelineClip.placement.start = timelineStart;
        timelineStart += timelineClip.placement.duration;
        return {
          op: 'insert_clip' as const,
          track_id: project.document.story_track_id,
          index: startIndex + offset,
          clip: timelineClip,
        };
      }),
    ],
  };
}

export function timelineClipFromCollected(source: ProjectCollectedClip): TimelineClip {
  const duration = source.durationSeconds ?? 0;
  return {
    id: '00000000-0000-0000-0000-000000000000',
    name: source.label,
    capture_intent: captureIntentFor(source),
    material: { kind: 'planned' },
    placement: {
      start: 0,
      duration,
      source_in: 0,
      source_out: duration,
      speed: 1,
      reverse: false,
      frame_hold_source_time: null,
      volume: 1,
      pan: 0,
      enabled: true,
    },
    transform: { x: 0, y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
    effects: [],
    transitions: { video_in: null, video_out: null, audio_in: null, audio_out: null },
    text: null,
    metadata: {
      collected_id: source.id,
      demo_id: source.demoId,
      match_label: source.matchLabel,
      kind: source.kind,
      evidence_id: source.evidenceId,
      round: source.round,
    },
    group_id: null,
    link_group_id: null,
    keyframes: [],
    speed_segments: [],
  };
}

function captureIntentFor(source: ProjectCollectedClip): CaptureIntent | null {
  if (
    source.playerId === null
    || source.startTick === null
    || source.endTick === null
    || source.endTick <= source.startTick
  ) return null;
  return {
    demo_id: source.demoId,
    highlight_id: source.highlightId,
    player_id: source.playerId,
    start_tick: source.startTick,
    end_tick: source.endTick,
    pre_roll_seconds: 1.5,
    post_roll_seconds: 1,
    victim_pov: false,
    camera_style: 'pov',
    presentation: null,
  };
}

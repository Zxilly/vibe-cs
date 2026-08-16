/*
 * pages/editor — wire fixtures (`.testing.ts`, the repo's suffix for a fixture
 * module that ships no tests of its own).
 *
 * An `EditorProject` shaped like the 「10 多轨编辑器」 artboard, built from the
 * *wire* types rather than the timeline model — the whole point of the adapter
 * tests is that the wire shape is the input, so a fixture written in the model
 * would test nothing.
 *
 * Every clip carries the fields the timeline does not describe (transform,
 * effects, keyframes, metadata) with values that are recognisably not
 * defaults, so a round trip that dropped one is visible rather than merely
 * possible.
 */

import { INDUSTRY_COLORS } from '../../design/tokens.data';
import { DEFAULT_MARKER_COLOR } from './editorDocument';
import type {
  EditorClip,
  EditorProject,
  EditorTrack,
  MediaAsset,
} from '../../shared/desktop/dto';

export const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
export const V1 = '22222222-2222-4222-8222-222222222222';
export const A1 = '33333333-3333-4333-8333-333333333333';
export const T1 = '44444444-4444-4444-8444-444444444444';
export const KAEL_VIDEO = '55555555-5555-4555-8555-555555555555';
export const KAEL_AUDIO = '66666666-6666-4666-8666-666666666666';
export const AURORA_VIDEO = '77777777-7777-4777-8777-777777777777';
export const CAPTION = '88888888-8888-4888-8888-888888888888';
export const LINK_KAEL = '99999999-9999-4999-8999-999999999999';
export const KAEL_ASSET = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const AURORA_ASSET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const MARKER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const KEYFRAME = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function clip(overrides: Partial<EditorClip> & Pick<EditorClip, 'id'>): EditorClip {
  return {
    asset_id: KAEL_ASSET,
    name: 'Clip',
    start: 0,
    duration: 10,
    source_in: 0,
    source_out: 10,
    speed: 1,
    volume: 1,
    transform: { x: 0, y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
    effects: [],
    transition_in: null,
    transition_out: null,
    text: null,
    metadata: {},
    group_id: null,
    link_group_id: null,
    keyframes: [],
    speed_segments: [],
    ...overrides,
  };
}

function track(overrides: Partial<EditorTrack> & Pick<EditorTrack, 'id' | 'kind'>): EditorTrack {
  return {
    name: 'Track',
    order: 0,
    muted: false,
    locked: false,
    hidden: false,
    clips: [],
    ...overrides,
  };
}

/**
 * The artboard's sequence: a linked A/V pair, a second video clip, a caption,
 * one marker. The Kael video carries a colour grade, a volume keyframe and a
 * `metadata` blob — none of which the timeline model knows about.
 */
export function sampleEditorProject(overrides: Partial<EditorProject> = {}): EditorProject {
  return {
    id: PROJECT_ID,
    name: 'Aurora 赛点集锦',
    width: 1920,
    height: 1080,
    fps: 60,
    duration_seconds: 60,
    revision: 24,
    created_at: '2026-08-01T09:00:00Z',
    updated_at: '2026-08-16T09:47:00Z',
    settings: { preset: 'youtube-1080p60' },
    markers: [{ id: MARKER, time: 20, label: '入场', color: DEFAULT_MARKER_COLOR }],
    tracks: [
      track({
        id: V1,
        kind: 'video',
        name: '主画面',
        order: 0,
        clips: [
          clip({
            id: KAEL_VIDEO,
            name: 'Kael_Mirage_1v3.mp4',
            start: 0,
            duration: 20,
            source_in: 3,
            source_out: 23,
            link_group_id: LINK_KAEL,
            transform: { x: 4, y: -2, scale_x: 1.04, scale_y: 1.04, rotation: 0, opacity: 1 },
            effects: [
              {
                id: 'grade-1',
                kind: 'color_adjust',
                enabled: true,
                parameters: { brightness: 0.1, contrast: 1.2, saturation: 0.8 },
              },
            ],
            keyframes: [{ id: KEYFRAME, time: 2, property: 'volume', value: 0.5 }],
            metadata: { origin: { kind: 'recorded_clip', shot: 3 } },
          }),
          clip({
            id: AURORA_VIDEO,
            asset_id: AURORA_ASSET,
            name: 'Aurora_R13_ace.mp4',
            start: 25,
            duration: 15,
            source_in: 4,
            source_out: 19,
            volume: 0.5,
          }),
        ],
      }),
      track({
        id: A1,
        kind: 'audio',
        name: '原声',
        order: 1,
        clips: [
          clip({
            id: KAEL_AUDIO,
            name: 'Kael_Mirage_1v3 · 原声',
            start: 0,
            duration: 20,
            source_in: 3,
            source_out: 23,
            link_group_id: LINK_KAEL,
          }),
        ],
      }),
      track({
        id: T1,
        kind: 'text',
        name: '字幕',
        order: 2,
        clips: [
          clip({
            id: CAPTION,
            asset_id: null,
            name: '1v3 CLUTCH',
            start: 5,
            duration: 6,
            source_in: 0,
            source_out: 6,
            text: {
              content: '1v3 CLUTCH',
              font_family: 'Inter',
              font_asset_id: null,
              font_size: 48,
              color: INDUSTRY_COLORS['--color-neutral-100'],
              background: null,
              align: 'center',
            },
          }),
        ],
      }),
    ],
    ...overrides,
  };
}

/** Media assets for the two video sources, both longer than their windows. */
export function sampleAssets(): Map<string, MediaAsset> {
  const asset = (id: string, name: string, duration: number): MediaAsset => ({
    id,
    project_id: PROJECT_ID,
    path: `C:/clips/${name}`,
    name,
    kind: 'video',
    duration_seconds: duration,
    width: 1920,
    height: 1080,
    file_size: 42_000_000,
    has_audio: true,
    proxy_path: null,
    proxy_status: { status: 'not_requested' },
    waveform: null,
    metadata_status: { status: 'ready' },
    created_at: '2026-08-01T09:00:00Z',
  });
  return new Map([
    [KAEL_ASSET, asset(KAEL_ASSET, 'Kael_Mirage_1v3.mp4', 48)],
    [AURORA_ASSET, asset(AURORA_ASSET, 'Aurora_R13_ace.mp4', 36)],
  ]);
}

/** A deterministic uuid mint, so a round trip can be asserted on. */
export function stubMint(prefix = 'e'): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `${prefix}${next}`.padStart(8, '0') + '-0000-4000-8000-000000000000';
  };
}

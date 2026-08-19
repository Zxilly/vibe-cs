/*
 * `unit` project — the pure half of 「09」's contract.
 *
 * The three things worth pinning: the timeline a sequential project implies
 * (including what it refuses to guess), the beat arithmetic the 最近拍点 /
 * 偏移 columns print, and what applying a suggestion is allowed to touch.
 */

import { i18n } from '@lingui/core';
import { beforeAll, describe, expect, it } from 'vitest';

import type {
  AudioBeat,
  BeatAlignmentDraft,
  MontageBrandingTheme,
  MontageClipRecord,
  MontageProjectRecord,
  MontageSettingsRecord,
} from '../../shared/desktop/dto';
import {
  MONTAGE_THEME,
  applyBeatDraftToProject,
  beatOrdinal,
  clipDurationSeconds,
  editorHref,
  formatBeatOffset,
  formatMontageTimecode,
  montageExportTaskHref,
  montageHref,
  montageTimeline,
  nearestBeat,
  reorderMontageClips,
  suggestedClipIds,
} from './montageContract';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'zh-CN', messages: {} });
});

/* ── fixtures ────────────────────────────────────────────────────────────── */

const SETTINGS: MontageSettingsRecord = {
  width: 1920,
  height: 1080,
  fps: 60,
  encoder: 'auto',
  quality: 60,
  background_music: null,
  music_volume: 0.8,
  transition_seconds: 0.25,
  intro_title: null,
  intro_duration_seconds: 3,
  include_name_cards: true,
  name_card_duration_seconds: 2,
  outro_title: null,
  outro_duration_seconds: 2,
  branding_theme: 'vibe',
};

function clip(overrides: Partial<MontageClipRecord> = {}): MontageClipRecord {
  return {
    clip_id: 'clip-1',
    order: 0,
    trim_start: 0,
    trim_end: null,
    transition: 'cut',
    title: null,
    avatar_asset_id: null,
    ...overrides,
  };
}

function project(clips: MontageClipRecord[]): MontageProjectRecord {
  return {
    id: 'm-1',
    name: 'Kael 个人集锦 v2',
    clips,
    settings: SETTINGS,
    created_at: '2026-08-15T09:00:00.000Z',
    updated_at: '2026-08-15T09:40:00.000Z',
  };
}

function beat(index: number, timeSeconds: number): AudioBeat {
  return { index, time_seconds: timeSeconds, strength: 0.8, phrase_position: (index % 4) + 1 };
}

/* ── addresses ───────────────────────────────────────────────────────────── */

describe('addresses', () => {
  it('is the list with no project and the project itself with one', () => {
    expect(montageHref(null)).toBe('/projects');
    expect(montageHref('m-1')).toBe('/projects/montage%3Am-1?step=shotlist');
    expect(editorHref('m-1')).toBe('/editor/m-1');
    expect(montageExportTaskHref('A-9')).toBe('/delivery/task/A-9');
  });

  it('escapes rather than pasting', () => {
    expect(montageHref('a b')).toBe('/projects/montage%3Aa%20b?step=shotlist');
  });
});

/* ── timecode ────────────────────────────────────────────────────────────── */

describe('formatMontageTimecode', () => {
  it('prints the tenth the board prints', () => {
    expect(formatMontageTimecode(0)).toBe('00:00.0');
    expect(formatMontageTimecode(42)).toBe('00:42.0');
    expect(formatMontageTimecode(60.4)).toBe('01:00.4');
    expect(formatMontageTimecode(73.1)).toBe('01:13.1');
  });

  it('rounds to tenths before splitting, so 59.98 is a minute and not 00:60.0', () => {
    expect(formatMontageTimecode(59.98)).toBe('01:00.0');
  });

  it('keeps counting in minutes past an hour', () => {
    expect(formatMontageTimecode(3_723.4)).toBe('62:03.4');
  });

  it('says nothing rather than zero for a value it does not have', () => {
    expect(formatMontageTimecode(Number.NaN)).toBe('--:--.-');
  });
});

describe('formatBeatOffset', () => {
  it('signs the offset the way the board does', () => {
    expect(formatBeatOffset(0.18)).toBe('+0.18s');
    expect(formatBeatOffset(-0.06)).toBe('−0.06s');
  });

  it('answers null inside the tolerance, so the column can print 「对齐」', () => {
    expect(formatBeatOffset(0)).toBeNull();
    expect(formatBeatOffset(0.004)).toBeNull();
  });

  it('answers null rather than a fiction for a value it does not have', () => {
    expect(formatBeatOffset(Number.NaN)).toBeNull();
  });
});

/* ── the implied timeline ────────────────────────────────────────────────── */

describe('clipDurationSeconds', () => {
  it('prefers the trim window when the project has one', () => {
    expect(clipDurationSeconds(clip({ trim_start: 2, trim_end: 10 }), {})).toBe(8);
  });

  it('falls back to the source length when trim_end is 「到末尾」', () => {
    expect(clipDurationSeconds(clip({ trim_start: 2 }), { 'clip-1': 12 })).toBe(10);
  });

  it('answers null — not zero — when the source length is not loaded yet', () => {
    expect(clipDurationSeconds(clip(), {})).toBeNull();
  });

  it('never answers a negative length', () => {
    expect(clipDurationSeconds(clip({ trim_start: 20, trim_end: 5 }), {})).toBe(0);
  });
});

describe('montageTimeline', () => {
  const clips = [
    clip({ clip_id: 'a', order: 0, trim_end: 42 }),
    clip({ clip_id: 'b', order: 1, trim_end: 18.4 }),
    clip({ clip_id: 'c', order: 2, trim_end: 12.7 }),
  ];

  it('stacks the starts the way the board prints them', () => {
    const timeline = montageTimeline(project(clips), {});
    expect(timeline.rows.map((row) => row.startSeconds)).toEqual([0, 42, 60.4]);
    expect(timeline.totalSeconds).toBeCloseTo(73.1, 6);
  });

  it('sorts by order rather than trusting the array', () => {
    const shuffled = [clips[2], clips[0], clips[1]] as MontageClipRecord[];
    const timeline = montageTimeline(project(shuffled), {});
    expect(timeline.rows.map((row) => row.clip.clip_id)).toEqual(['a', 'b', 'c']);
  });

  it('stops guessing once a length is unknown, and reports no total', () => {
    const unknown = [
      clip({ clip_id: 'a', order: 0, trim_end: 42 }),
      clip({ clip_id: 'b', order: 1 }),
      clip({ clip_id: 'c', order: 2, trim_end: 12.7 }),
    ];
    const timeline = montageTimeline(project(unknown), {});
    expect(timeline.rows.map((row) => row.startSeconds)).toEqual([0, 42, null]);
    expect(timeline.totalSeconds).toBeNull();
  });

  it('is empty, not broken, for a project with no clips', () => {
    expect(montageTimeline(project([]), {})).toEqual({ rows: [], totalSeconds: 0 });
  });
});

/* ── beats ───────────────────────────────────────────────────────────────── */

describe('beatOrdinal', () => {
  it('turns the zero-based wire index into the board’s 「第 1 拍」', () => {
    expect(beatOrdinal(beat(0, 0))).toBe(1);
    expect(beatOrdinal(beat(32, 42))).toBe(33);
  });
});

describe('nearestBeat', () => {
  const beats = [beat(0, 0), beat(32, 41.82), beat(64, 60.46)];

  it('finds the closest beat and signs the offset from it', () => {
    const found = nearestBeat(beats, 42);
    expect(found?.beat.index).toBe(32);
    expect(found?.offsetSeconds).toBeCloseTo(0.18, 6);
  });

  it('signs a clip that starts before its beat negatively', () => {
    const found = nearestBeat(beats, 60.4);
    expect(found?.beat.index).toBe(64);
    expect(found?.offsetSeconds).toBeCloseTo(-0.06, 6);
  });

  it('keeps the first of two equidistant beats rather than drifting later', () => {
    const found = nearestBeat([beat(0, 0), beat(1, 2)], 1);
    expect(found?.beat.index).toBe(0);
  });

  it('answers null for a track with no detected beats', () => {
    expect(nearestBeat([], 12)).toBeNull();
  });
});

/* ── applying a suggestion ───────────────────────────────────────────────── */

function draftFor(
  entries: Array<{ clipId: string; planned: number; source: number }>,
  unplaced: string[] = [],
): BeatAlignmentDraft {
  return {
    advisory_only: true,
    clips: entries.map((entry, index) => ({
      clip_id: entry.clipId,
      timeline_start_seconds: index * 10,
      timeline_end_seconds: index * 10 + entry.planned,
      planned_duration_seconds: entry.planned,
      source_duration_seconds: entry.source,
      duration_change_ratio: 1,
      start_beat_index: index * 32,
      end_beat_index: index * 32 + 16,
      rationale: ['对齐段落起点'],
    })),
    unplaced_clip_ids: unplaced,
    constraints: [],
  };
}

describe('suggestedClipIds', () => {
  it('leaves out the clips the aligner could not place', () => {
    const draft = draftFor(
      [
        { clipId: 'a', planned: 40, source: 42 },
        { clipId: 'b', planned: 18, source: 18.4 },
      ],
      ['b'],
    );
    expect(suggestedClipIds(draft)).toEqual(['a']);
  });
});

describe('applyBeatDraftToProject', () => {
  const clips = [
    clip({ clip_id: 'a', order: 0, trim_start: 0, trim_end: 42 }),
    clip({ clip_id: 'b', order: 1, trim_start: 1, trim_end: 18.4 }),
  ];
  const draft = draftFor([
    { clipId: 'a', planned: 40, source: 42 },
    { clipId: 'b', planned: 17, source: 18.4 },
  ]);

  it('applies only the clips the user ticked', () => {
    const next = applyBeatDraftToProject(project(clips), draft, ['a']);
    expect(next.clips.map((one) => one.trim_end)).toEqual([40, 18.4]);
  });

  it('measures the new end from the clip’s own in-point', () => {
    const next = applyBeatDraftToProject(project(clips), draft, ['b']);
    expect(next.clips[1]?.trim_end).toBe(18);
  });

  it('never runs past the source the draft itself reports', () => {
    const greedy = draftFor([{ clipId: 'a', planned: 500, source: 42 }]);
    const next = applyBeatDraftToProject(project(clips), greedy, ['a']);
    expect(next.clips[0]?.trim_end).toBe(42);
  });

  it('touches nothing but trim_end — no order, no transitions, no settings', () => {
    const next = applyBeatDraftToProject(project(clips), draft, ['a', 'b']);
    expect(next.clips.map((one) => one.order)).toEqual([0, 1]);
    expect(next.clips.map((one) => one.trim_start)).toEqual([0, 1]);
    expect(next.clips.map((one) => one.transition)).toEqual(['cut', 'cut']);
    expect(next.settings).toBe(SETTINGS);
    expect(next.name).toBe('Kael 个人集锦 v2');
  });

  it('returns the project untouched when nothing was ticked', () => {
    const before = project(clips);
    expect(applyBeatDraftToProject(before, draft, [])).toBe(before);
  });

  it('ignores a ticked clip the aligner marked unplaced', () => {
    const unplaced = draftFor([{ clipId: 'a', planned: 40, source: 42 }], ['a']);
    const before = project(clips);
    expect(applyBeatDraftToProject(before, unplaced, ['a'])).toBe(before);
  });

  it('ignores a suggestion with no usable duration', () => {
    const broken = draftFor([{ clipId: 'a', planned: 0, source: 42 }]);
    const next = applyBeatDraftToProject(project(clips), broken, ['a']);
    expect(next.clips[0]?.trim_end).toBe(42);
  });
});

/* ── reordering ──────────────────────────────────────────────────────────── */

describe('reorderMontageClips', () => {
  const clips = [
    clip({ clip_id: 'a', order: 0 }),
    clip({ clip_id: 'b', order: 1 }),
    clip({ clip_id: 'c', order: 2 }),
  ];

  it('moves a clip and renumbers order so the two agree', () => {
    const next = reorderMontageClips(2, 0)(project(clips));
    expect(next.clips.map((one) => one.clip_id)).toEqual(['c', 'a', 'b']);
    expect(next.clips.map((one) => one.order)).toEqual([0, 1, 2]);
  });

  it('renumbers from the order field, not the array', () => {
    const shuffled = [clips[1], clips[2], clips[0]] as MontageClipRecord[];
    const next = reorderMontageClips(0, 2)(project(shuffled));
    expect(next.clips.map((one) => one.clip_id)).toEqual(['b', 'c', 'a']);
    expect(next.clips.map((one) => one.order)).toEqual([0, 1, 2]);
  });

  it('drops a gesture whose source index no longer exists', () => {
    const before = project(clips);
    expect(reorderMontageClips(9, 0)(before)).toBe(before);
  });

  it('clamps a drop past the end rather than refusing it', () => {
    const next = reorderMontageClips(0, 99)(project(clips));
    expect(next.clips.map((one) => one.clip_id)).toEqual(['b', 'c', 'a']);
  });

  it('is a no-op when nothing moved', () => {
    const before = project(clips);
    expect(reorderMontageClips(1, 1)(before)).toBe(before);
  });
});

/* ── packaging vocabulary ────────────────────────────────────────────────── */

describe('MONTAGE_THEME', () => {
  it('labels all four wire members, including the one the board omits', () => {
    const codes: MontageBrandingTheme[] = ['vibe', 'minimal', 'broadcast', 'neon'];
    for (const code of codes) {
      expect(`${code}:${i18n._(MONTAGE_THEME[code]) !== ''}`).toBe(`${code}:true`);
    }
  });

  it('gives every theme a distinct label', () => {
    const labels = Object.values(MONTAGE_THEME).map((label) => i18n._(label));
    expect(new Set(labels).size).toBe(labels.length);
  });
});

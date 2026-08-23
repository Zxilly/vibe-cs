import { describe, expect, it } from 'vitest';

import type {
  AudioAnalysis,
  AudioBeat,
  BeatAlignmentDraft,
  MontageProjectRecord,
} from '../../shared/desktop/dto';
import {
  BEAT_ALIGNMENT_OPTIONS,
  beatPeriodSeconds,
  buildBeatAlignmentRequest,
  previewBeatDraft,
  readBeatSuggestions,
} from './montageBeats';
import { defaultMontageSettings } from './montageSettings';

function beats(count: number, period = 0.5): AudioBeat[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    time_seconds: index * period,
    strength: 0.8,
    phrase_position: (index % 4) + 1,
  }));
}

function analysis(overrides: Partial<AudioAnalysis> = {}): AudioAnalysis {
  return {
    duration_seconds: 120,
    analysis_sample_rate: 22_050,
    bpm: 120,
    tempo_confidence: 0.92,
    beats: beats(64),
    onsets: [],
    energy: [],
    sections: [],
    spectral_map: { floor_db: -80, bands: [], points: [] },
    rhythm_diagnostics: {
      onset_rate_per_second: 0,
      strong_onset_rate_per_second: 0,
      dynamic_range_db: 0,
      silence_ratio: 0,
      silence_regions: [],
      recommended_cut_points: [],
    },
    limitations: [],
    ...overrides,
  };
}

function project(): MontageProjectRecord {
  return {
    id: 'project-1',
    name: '集锦',
    clips: [
      { clip_id: 'a', order: 0, trim_start: 0, trim_end: 4, transition: 'cut', title: null, avatar_asset_id: null },
      { clip_id: 'b', order: 1, trim_start: 1, trim_end: 7, transition: 'cut', title: null, avatar_asset_id: null },
    ],
    settings: defaultMontageSettings(),
    created_at: '2026-08-16T08:00:00.000Z',
    updated_at: '2026-08-16T09:00:00.000Z',
  };
}

const DURATIONS = { a: 12, b: 12 };

function draftFor(plannedA: number, plannedB: number): BeatAlignmentDraft {
  return {
    advisory_only: true,
    clips: [
      {
        clip_id: 'a',
        timeline_start_seconds: 0,
        timeline_end_seconds: plannedA,
        planned_duration_seconds: plannedA,
        source_duration_seconds: 12,
        duration_change_ratio: 0,
        start_beat_index: 0,
        end_beat_index: 8,
        rationale: ['Snapped to beat 0 through beat 8.'],
      },
      {
        clip_id: 'b',
        timeline_start_seconds: plannedA,
        timeline_end_seconds: plannedA + plannedB,
        planned_duration_seconds: plannedB,
        source_duration_seconds: 11,
        duration_change_ratio: 0,
        start_beat_index: 8,
        end_beat_index: 20,
        rationale: [],
      },
    ],
    unplaced_clip_ids: [],
    constraints: [],
  };
}

describe('beatPeriodSeconds', () => {
  it('prefers the analysis’s own tempo', () => {
    expect(beatPeriodSeconds(analysis({ bpm: 120 }))).toBeCloseTo(0.5, 9);
  });

  it('falls back to the median gap when the analysis declined to commit', () => {
    expect(beatPeriodSeconds(analysis({ bpm: null, beats: beats(9, 0.4) }))).toBeCloseTo(0.4, 9);
  });

  it('answers null when there is no grid to measure', () => {
    expect(beatPeriodSeconds(analysis({ bpm: null, beats: [] }))).toBeNull();
  });
});

describe('buildBeatAlignmentRequest', () => {
  it('asks about every clip, in order', () => {
    const built = buildBeatAlignmentRequest(project(), DURATIONS, analysis());
    expect(typeof built).not.toBe('string');
    if (typeof built === 'string') return;
    expect(built.request.clips.map((clip) => clip.clip_id)).toEqual(['a', 'b']);
    expect(built.request.options).toEqual(BEAT_ALIGNMENT_OPTIONS);
  });

  it('reports how much material is left from the in-point, not the current cut', () => {
    /* Clip b is trimmed to 6s out of a 12s take starting at 1s: 11s remain, and
       that is the clamp `applyBeatDraftToProject` will use. Passing the current
       6s would make every suggestion a shortening. */
    const built = buildBeatAlignmentRequest(project(), DURATIONS, analysis());
    if (typeof built === 'string') throw new Error('expected a request');
    expect(built.request.clips[1]?.source_duration_seconds).toBe(11);
  });

  it('bounds the change to ±15% of the current length', () => {
    const built = buildBeatAlignmentRequest(project(), DURATIONS, analysis());
    if (typeof built === 'string') throw new Error('expected a request');
    expect(built.request.clips[0]?.minimum_duration_seconds).toBeCloseTo(3.4, 6);
    expect(built.request.clips[0]?.maximum_duration_seconds).toBeCloseTo(4.6, 6);
  });

  it('names the beat span the current cut already covers, so the aligner stays near it', () => {
    const built = buildBeatAlignmentRequest(project(), DURATIONS, analysis());
    if (typeof built === 'string') throw new Error('expected a request');
    /* 4 seconds at 120 BPM is eight beats. */
    expect(built.request.clips[0]?.preferred_beats).toBe(8);
  });

  it('refuses rather than asking a question it would misread the answer to', () => {
    expect(buildBeatAlignmentRequest({ ...project(), clips: [] }, DURATIONS, analysis())).toBe('no-clips');
    expect(buildBeatAlignmentRequest(project(), DURATIONS, analysis({ beats: [] }))).toBe('no-beats');
    const open = project();
    open.clips = [{ ...open.clips[0]!, trim_end: null }, open.clips[1]!];
    expect(buildBeatAlignmentRequest(open, {}, analysis())).toBe('unknown-durations');
  });
});

describe('readBeatSuggestions', () => {
  it('is one card per clip the draft would actually change', () => {
    const suggestions = readBeatSuggestions(project(), DURATIONS, draftFor(4, 8));
    expect(suggestions.map((entry) => entry.clipId)).toEqual(['b']);
    expect(suggestions[0]).toMatchObject({
      position: 2,
      currentDurationSeconds: 6,
      plannedDurationSeconds: 8,
      startBeat: 9,
      endBeat: 21,
    });
    expect(suggestions[0]?.deltaSeconds).toBeCloseTo(2, 6);
  });

  it('draws no card for a clip the aligner gave up on', () => {
    const draft = { ...draftFor(6, 8), unplaced_clip_ids: ['b'] };
    expect(readBeatSuggestions(project(), DURATIONS, draft)).toHaveLength(1);
  });

  it('reports the clamped length, not the one the draft asked for', () => {
    /* Clip b starts at 1s in a 12s take, so 20s of planned duration lands at
       11s — exactly what applying would produce. */
    const suggestions = readBeatSuggestions(project(), DURATIONS, draftFor(4, 20));
    expect(suggestions[0]?.plannedDurationSeconds).toBe(11);
  });
});

describe('previewBeatDraft', () => {
  it('leaves the project it was given untouched — 「预览」 writes nothing', () => {
    const current = project();
    const snapshot = structuredClone(current);
    const previewed = previewBeatDraft(current, draftFor(4, 8), ['b']);

    expect(current).toEqual(snapshot);
    expect(previewed).not.toBe(current);
    expect(previewed.clips[1]?.trim_end).toBe(9);
  });

  it('touches only the ticked clip', () => {
    const previewed = previewBeatDraft(project(), draftFor(9, 9), ['b']);
    expect(previewed.clips[0]?.trim_end).toBe(4);
    expect(previewed.clips[1]?.trim_end).toBe(10);
  });

  it('changes nothing but trim_end — not order, not transitions, not settings', () => {
    const current = project();
    const previewed = previewBeatDraft(current, draftFor(9, 9), ['a', 'b']);
    expect(previewed.settings).toEqual(current.settings);
    expect(previewed.clips.map((clip) => clip.order)).toEqual([0, 1]);
    expect(previewed.clips.map((clip) => clip.transition)).toEqual(['cut', 'cut']);
    expect(previewed.clips.map((clip) => clip.trim_start)).toEqual([0, 1]);
  });
});

import { describe, expect, it } from 'vitest';

import type { RecordedClip } from '../../shared/api/dto';
import { buildMontageDraft, montageDuration, toMontageTimelineItem } from './montageProject';

const clip = (id: string, duration: number): RecordedClip => ({
  id,
  title: `Clip ${id}`,
  player_name: 'Player',
  map_name: 'de_dust2',
  duration_seconds: duration,
  created_at: '2026-08-10T00:00:00Z',
  stream_url: `/api/v1/recorded-clips/${id}/stream`,
});

describe('montage project mapping', () => {
  it('accounts for only overlapping transitions and the intro', () => {
    const first = toMontageTimelineItem(clip('a', 4));
    const second = { ...toMontageTimelineItem(clip('b', 5)), transition: 'fade' as const };
    expect(montageDuration([first, second], 0.5, 2)).toBe(10.5);
  });

  it('preserves per-clip trims and forces the first transition to cut', () => {
    const first = { ...toMontageTimelineItem(clip('a', 4)), trimStart: 1, trimEnd: 3, transition: 'whip' as const };
    const second = { ...toMontageTimelineItem(clip('b', 5)), trimEnd: 4, transition: 'fade' as const };
    const draft = buildMontageDraft({
      name: '  Highlights  ', timeline: [first, second], resolution: '1440p', fps: 60,
      transitionSeconds: 0.4, introEnabled: true, introTitle: 'Night', introDuration: 2,
      includeNameCards: true, backgroundMusic: 'D:/music.wav', musicVolume: 0.3,
      outroEnabled: true, outroTitle: 'Thanks', outroDuration: 1.5, brandingTheme: 'neon',
    });
    expect(draft.name).toBe('Highlights');
    expect(draft.clips[0]).toMatchObject({ trim_start: 1, trim_end: 3, transition: 'cut' });
    expect(draft.clips[1]?.transition).toBe('fade');
    expect(draft.settings).toMatchObject({
      width: 2560,
      height: 1440,
      background_music: 'D:/music.wav',
      intro_title: 'Night',
      include_name_cards: true,
      outro_title: 'Thanks',
      branding_theme: 'neon',
    });
  });

  it('disables packaging fields without leaving stale values', () => {
    const draft = buildMontageDraft({
      name: 'Cut', timeline: [toMontageTimelineItem(clip('a', 4))], resolution: '1080p', fps: 30,
      transitionSeconds: 0.35, introEnabled: false, introTitle: 'stale', introDuration: 3,
      includeNameCards: false, backgroundMusic: '   ', musicVolume: 0,
      outroEnabled: false, outroTitle: 'stale', outroDuration: 2, brandingTheme: 'vibe',
    });
    expect(draft.settings.intro_title).toBeNull();
    expect(draft.settings.intro_duration_seconds).toBe(0);
    expect(draft.settings.background_music).toBeNull();
    expect(draft.settings.outro_title).toBeNull();
  });
});

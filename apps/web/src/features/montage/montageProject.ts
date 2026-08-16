import type { CreateMontageProject } from '../../shared/desktop/dto';
import type { RecordedClip } from '../../shared/desktop/viewModels';

export type MontageTransition = 'cut' | 'fade' | 'flash' | 'dip' | 'zoom' | 'wipe' | 'whip' | 'blur' | 'glitch' | 'spin';
export type MontageBrandingTheme = 'vibe' | 'broadcast' | 'minimal' | 'neon';
export type MontageTimelineItem = {
  clip: RecordedClip;
  trimStart: number;
  trimEnd: number;
  transition: MontageTransition;
  avatarAssetId: string | null;
};

export type MontageDraftOptions = {
  name: string;
  timeline: MontageTimelineItem[];
  resolution: '1080p' | '1440p' | '2160p';
  fps: 30 | 60;
  transitionSeconds: number;
  introEnabled: boolean;
  introTitle: string;
  introDuration: number;
  includeNameCards: boolean;
  backgroundMusic: string;
  musicVolume: number;
  outroEnabled: boolean;
  outroTitle: string;
  outroDuration: number;
  brandingTheme: MontageBrandingTheme;
};

export const toMontageTimelineItem = (clip: RecordedClip): MontageTimelineItem => ({
  clip,
  trimStart: 0,
  trimEnd: clip.duration_seconds,
  transition: 'cut',
  avatarAssetId: null,
});

export function montageDuration(
  timeline: MontageTimelineItem[],
  transitionSeconds: number,
  introDuration: number,
  outroDuration = 0,
): number {
  return Math.max(0, timeline.reduce((sum, item, index) => (
    sum
    + item.trimEnd - item.trimStart
    - (index > 0 && item.transition !== 'cut' ? transitionSeconds : 0)
  ), introDuration + outroDuration));
}

export function buildMontageDraft(options: MontageDraftOptions): CreateMontageProject {
  const dimensions = options.resolution === '2160p'
    ? { width: 3840, height: 2160 }
    : options.resolution === '1440p'
      ? { width: 2560, height: 1440 }
      : { width: 1920, height: 1080 };
  return {
    name: options.name.trim(),
    clips: options.timeline.map((item, order) => ({
      clip_id: item.clip.id,
      order,
      trim_start: item.trimStart,
      trim_end: item.trimEnd,
      transition: order === 0 ? 'cut' : item.transition,
      title: item.clip.title,
      avatar_asset_id: item.avatarAssetId,
    })),
    settings: {
      ...dimensions,
      fps: options.fps,
      encoder: 'auto',
      quality: 80,
      background_music: options.backgroundMusic.trim() || null,
      music_volume: options.musicVolume,
      transition_seconds: options.transitionSeconds,
      intro_title: options.introEnabled ? options.introTitle.trim() : null,
      intro_duration_seconds: options.introEnabled ? options.introDuration : 0,
      include_name_cards: options.includeNameCards,
      name_card_duration_seconds: 2.5,
      outro_title: options.outroEnabled ? options.outroTitle.trim() : null,
      outro_duration_seconds: options.outroEnabled ? options.outroDuration : 0,
      branding_theme: options.brandingTheme,
    },
  };
}

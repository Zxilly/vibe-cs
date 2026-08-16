import { describe, expect, it } from 'vitest';

import type { MontageProjectRecord } from '../../shared/desktop/dto';
import {
  MONTAGE_EXPORT_BLOCKERS,
  MONTAGE_EXPORT_BLOCKER_REASON,
  MONTAGE_QUALITY_LABEL,
  MONTAGE_QUALITY_TIERS,
  MONTAGE_QUALITY_VALUE,
  MONTAGE_TRANSITIONS,
  MONTAGE_TRANSITION_LABEL,
  defaultMontageSettings,
  editAllTransitions,
  editAppendClips,
  editClipTrim,
  editMontageSettings,
  editRemoveClips,
  formatResolution,
  montageRenderPlan,
  normaliseTransition,
  qualityIsExactTier,
  qualityTierOf,
  qualityToCrf,
  sharedTransition,
} from './montageSettings';

function project(overrides: Partial<MontageProjectRecord> = {}): MontageProjectRecord {
  return {
    id: 'project-1',
    name: '集锦',
    clips: [
      { clip_id: 'a', order: 0, trim_start: 0, trim_end: 10, transition: 'cut', title: null, avatar_asset_id: null },
      { clip_id: 'b', order: 1, trim_start: 0, trim_end: 20, transition: 'cut', title: null, avatar_asset_id: null },
    ],
    settings: defaultMontageSettings(),
    created_at: '2026-08-16T08:00:00.000Z',
    updated_at: '2026-08-16T09:00:00.000Z',
    ...overrides,
  };
}

describe('画质策略 → quality', () => {
  it('reproduces the encoder mapping, `35 - quality / 4`', () => {
    /* `crates/media/src/plan.rs`, `quality_to_crf`. If this test fails after a
       backend change, the three tier numbers below are wrong too. */
    expect(qualityToCrf(0)).toBe(35);
    expect(qualityToCrf(80)).toBe(15);
    expect(qualityToCrf(100)).toBe(10);
    expect(qualityToCrf(120)).toBe(10);
    expect(qualityToCrf(61)).toBe(20);
  });

  it('pins the three tiers to whole CRF steps', () => {
    expect(qualityToCrf(MONTAGE_QUALITY_VALUE.speed)).toBe(20);
    expect(qualityToCrf(MONTAGE_QUALITY_VALUE.balanced)).toBe(15);
    expect(qualityToCrf(MONTAGE_QUALITY_VALUE.quality)).toBe(12);
    for (const tier of MONTAGE_QUALITY_TIERS) {
      expect(MONTAGE_QUALITY_VALUE[tier] % 4).toBe(0);
    }
  });

  it('keeps 均衡 on the domain default so a new project matches every other one', () => {
    expect(MONTAGE_QUALITY_VALUE.balanced).toBe(80);
    expect(defaultMontageSettings().quality).toBe(80);
  });

  it('labels all three tiers', () => {
    for (const tier of MONTAGE_QUALITY_TIERS) {
      expect(MONTAGE_QUALITY_LABEL[tier]).toBeDefined();
    }
  });

  it('maps a stored value to the nearest tier without claiming it is exact', () => {
    expect(qualityTierOf(80)).toBe('balanced');
    expect(qualityTierOf(74)).toBe('balanced');
    expect(qualityIsExactTier(74)).toBe(false);
    expect(qualityIsExactTier(80)).toBe(true);
    expect(qualityTierOf(0)).toBe('speed');
    expect(qualityTierOf(100)).toBe('quality');
  });

  it('breaks a tie toward the cheaper encode', () => {
    expect(qualityTierOf(70)).toBe('speed');
  });
});

describe('片段转场', () => {
  it('labels every member of the renderer’s closed set', () => {
    for (const kind of MONTAGE_TRANSITIONS) {
      expect(MONTAGE_TRANSITION_LABEL[kind]).toBeDefined();
    }
    expect(MONTAGE_TRANSITIONS).toHaveLength(10);
  });

  it('accepts the parser’s aliases', () => {
    expect(normaliseTransition('')).toBe('cut');
    expect(normaliseTransition('none')).toBe('cut');
    expect(normaliseTransition('DISSOLVE')).toBe('fade');
    expect(normaliseTransition(' whip ')).toBe('slide');
    expect(normaliseTransition('slideleft')).toBe('slide');
  });

  it('answers null for a value the renderer would reject, rather than guessing', () => {
    expect(normaliseTransition('sparkle')).toBeNull();
  });

  it('reports one shared transition, and null when they differ', () => {
    expect(sharedTransition(project())).toBe('cut');
    const mixed = project();
    mixed.clips = [
      { ...mixed.clips[0]!, transition: 'cut' },
      { ...mixed.clips[1]!, transition: 'fade' },
    ];
    expect(sharedTransition(mixed)).toBeNull();
  });
});

describe('formatResolution', () => {
  it('uses the artboard’s multiplication sign, not the letter x', () => {
    expect(formatResolution(1920, 1080)).toBe('1920×1080');
    expect(formatResolution(1920, 1080)).not.toContain('x');
  });
});

describe('montageRenderPlan', () => {
  const durations = { a: 10, b: 20 };

  it('adds the clips and the two title cards', () => {
    const withCards = project();
    withCards.settings = {
      ...withCards.settings,
      intro_title: '开场',
      intro_duration_seconds: 3,
      outro_title: '结束',
      outro_duration_seconds: 2,
    };
    expect(montageRenderPlan(withCards, durations).durationSeconds).toBe(35);
  });

  it('subtracts a non-cut transition, because it overlaps the two clips it joins', () => {
    const faded = project();
    faded.clips = faded.clips.map((clip) => ({ ...clip, transition: 'fade' }));
    faded.settings = { ...faded.settings, transition_seconds: 0.5 };
    /* 10 + 20 − 0.5; the first clip has no transition before it. */
    expect(montageRenderPlan(faded, durations).durationSeconds).toBeCloseTo(29.5, 6);
  });

  it('answers null when a clip’s source length is unknown, never a short total', () => {
    const open = project();
    open.clips = [{ ...open.clips[0]!, trim_end: null }, open.clips[1]!];
    expect(montageRenderPlan(open, {}).durationSeconds).toBeNull();
  });

  it('blocks an export the renderer would refuse', () => {
    expect(montageRenderPlan(project({ clips: [] }), durations).blockers).toEqual(['no-clips']);

    const untitled = project();
    untitled.settings = { ...untitled.settings, intro_duration_seconds: 3, intro_title: '  ' };
    expect(montageRenderPlan(untitled, durations).blockers).toContain('intro-title-missing');

    const outro = project();
    outro.settings = { ...outro.settings, outro_duration_seconds: 3, outro_title: null };
    expect(montageRenderPlan(outro, durations).blockers).toContain('outro-title-missing');

    const long = project();
    /* Two three-second clips joined by a four-and-a-half-second cross-fade —
       the exact condition `montage_duration` errors on. */
    long.clips = long.clips.map((clip) => ({ ...clip, transition: 'fade', trim_end: 3 }));
    long.settings = { ...long.settings, transition_seconds: 4.5 };
    expect(montageRenderPlan(long, { a: 3, b: 3 }).blockers).toContain('transition-too-long');

    const strange = project();
    strange.clips = [{ ...strange.clips[0]!, transition: 'sparkle' }, strange.clips[1]!];
    expect(montageRenderPlan(strange, durations).blockers).toContain('unsupported-transition');
  });

  it('has a written reason for every blocker code', () => {
    for (const code of MONTAGE_EXPORT_BLOCKERS) {
      expect(MONTAGE_EXPORT_BLOCKER_REASON[code]).toBeDefined();
    }
  });

  it('passes a project the renderer would accept', () => {
    expect(montageRenderPlan(project(), durations).blockers).toEqual([]);
  });
});

describe('the edits', () => {
  it('patches settings without touching the clips', () => {
    const next = editMontageSettings({ quality: 92 })(project());
    expect(next.settings.quality).toBe(92);
    expect(next.settings.fps).toBe(60);
    expect(next.clips).toHaveLength(2);
  });

  it('applies one transition to every clip', () => {
    const next = editAllTransitions('fade')(project());
    expect(next.clips.map((clip) => clip.transition)).toEqual(['fade', 'fade']);
  });

  it('writes a trim, including the 「到素材末尾」 null', () => {
    const next = editClipTrim('b', { trimStart: 1.5, trimEnd: null })(project());
    expect(next.clips[1]).toMatchObject({ clip_id: 'b', trim_start: 1.5, trim_end: null });
    expect(next.clips[0]).toMatchObject({ trim_start: 0, trim_end: 10 });
  });

  it('renumbers order after a removal so the array and the field agree', () => {
    const next = editRemoveClips(['a'])(project());
    expect(next.clips).toHaveLength(1);
    expect(next.clips[0]).toMatchObject({ clip_id: 'b', order: 0 });
  });

  it('appends new clips at the end and refuses to add one twice', () => {
    const next = editAppendClips(['c', 'a', 'c'], 'fade')(project());
    expect(next.clips.map((clip) => clip.clip_id)).toEqual(['a', 'b', 'c']);
    expect(next.clips.map((clip) => clip.order)).toEqual([0, 1, 2]);
    expect(next.clips[2]).toMatchObject({ transition: 'fade', trim_start: 0, trim_end: null });
  });

  it('returns the same document when an append would add nothing', () => {
    const current = project();
    expect(editAppendClips(['a'])(current)).toBe(current);
  });

  it('composes, which is the whole point of an edit function', () => {
    /* Two panels, one after the other, over one document — the property the
       read-modify-write save exists to give. */
    const first = editMontageSettings({ branding_theme: 'neon' })(project());
    const second = editAllTransitions('fade')(first);
    expect(second.settings.branding_theme).toBe('neon');
    expect(second.clips.every((clip) => clip.transition === 'fade')).toBe(true);
  });
});

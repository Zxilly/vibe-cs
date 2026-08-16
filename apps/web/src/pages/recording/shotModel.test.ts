/*
 * `unit` project — the shot inspector's edits.
 *
 * Each of these is a rule the backend enforces with a 400 and the interface has
 * to enforce with a patch. Reading the panel cannot tell you whether it does;
 * these can.
 */

import { i18n } from '@lingui/core';
import { beforeAll, describe, expect, it } from 'vitest';

import type { AppConfig, RecordingRequest, RecordingShotPreset } from '../../shared/desktop/dto';
import {
  NEUTRAL_CAMERA_FOV,
  NEUTRAL_VIEWMODEL_FOV,
  type CameraStyle,
} from './recordingContract';
import {
  CAMERA_STYLE,
  CAMERA_STYLES,
  DEFAULT_OBSERVER_STYLE,
  SHOT_VIEW,
  SHOT_VIEWS,
  VOICE_POLICIES,
  VOICE_POLICY,
  applyToAllPatch,
  detachedPresentationPatch,
  nextShotIndex,
  patchCameraStyle,
  patchPresentation,
  patchShotView,
  presetDraftFromShot,
  presetPatch,
  reorderShots,
  shotDurationSeconds,
  shotViewOf,
  totalShotSeconds,
} from './shotModel';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'zh-CN', messages: {} });
});

const DEFAULTS: AppConfig['recording'] = {
  pre_roll_seconds: 1.5,
  post_roll_seconds: 1,
  resolution: '1920x1080',
  fps: 60,
  show_radar: true,
  show_hud: true,
  mute_voice: false,
  isolate_target_voice: false,
  camera_fov: 110,
  viewmodel_fov: 60,
  flash_alpha: 255,
};

function item(overrides: Partial<RecordingRequest> = {}): RecordingRequest {
  return {
    id: 'item-1',
    demo_id: 'demo-a',
    highlight_id: 'h-1',
    player_id: '76561198000000001',
    title: '跟随突破',
    start_tick: 148_812,
    end_tick: 149_356,
    pre_roll_seconds: 1.5,
    post_roll_seconds: 1,
    victim_pov: false,
    camera_style: 'tracking',
    presentation: null,
    ...overrides,
  };
}

/* ── the vocabularies ────────────────────────────────────────────────────── */

describe('the closed sets', () => {
  it('labels all seven camera styles and lists each exactly once', () => {
    expect(Object.keys(CAMERA_STYLE).sort()).toEqual(
      ['pov', 'orbit', 'dolly', 'static', 'tracking', 'crane', 'flyby'].sort(),
    );
    expect(new Set(CAMERA_STYLES).size).toBe(CAMERA_STYLES.length);
    expect([...CAMERA_STYLES].sort()).toEqual(Object.keys(CAMERA_STYLE).sort());
  });

  it('gives every style a distinct label and a hint that says what it is for', () => {
    const labels = CAMERA_STYLES.map((style) => i18n._(CAMERA_STYLE[style].label));
    expect(new Set(labels).size).toBe(labels.length);
    for (const style of CAMERA_STYLES) {
      expect(i18n._(CAMERA_STYLE[style].hint).length).toBeGreaterThan(0);
    }
  });

  it('names the three voice policies the wire has, not two', () => {
    expect([...VOICE_POLICIES].sort()).toEqual(['all_players', 'muted', 'target_only']);
    expect(new Set(VOICE_POLICIES.map((policy) => i18n._(VOICE_POLICY[policy]))).size).toBe(3);
  });

  it('names the three views the artboard draws', () => {
    expect(SHOT_VIEWS).toEqual(['observer', 'player_pov', 'victim_pov']);
    expect(new Set(SHOT_VIEWS.map((view) => i18n._(SHOT_VIEW[view]))).size).toBe(3);
  });
});

/* ── 视角, which is one control over two wire fields ─────────────────────── */

describe('shotViewOf', () => {
  it('reads a non-POV style as an observer shot whatever victim_pov says', () => {
    expect(shotViewOf({ camera_style: 'crane', victim_pov: false })).toBe('observer');
    expect(shotViewOf({ camera_style: 'crane', victim_pov: true })).toBe('observer');
  });

  it('separates 选手 POV from 受害者 by victim_pov alone', () => {
    expect(shotViewOf({ camera_style: 'pov', victim_pov: false })).toBe('player_pov');
    expect(shotViewOf({ camera_style: 'pov', victim_pov: true })).toBe('victim_pov');
  });
});

describe('patchShotView', () => {
  it('turns an observer shot into a POV one', () => {
    expect(patchShotView(item(), 'player_pov', DEFAULTS)).toEqual({
      camera_style: 'pov',
      victim_pov: false,
    });
  });

  it('sets both fields for 受害者 — the backend rejects victim_pov off POV', () => {
    expect(patchShotView(item(), 'victim_pov', DEFAULTS)).toEqual({
      camera_style: 'pov',
      victim_pov: true,
    });
  });

  it('**clears victim_pov** when leaving 受害者 for 观察者', () => {
    const patch = patchShotView(item({ camera_style: 'pov', victim_pov: true }), 'observer', DEFAULTS);
    expect(patch.camera_style).toBe(DEFAULT_OBSERVER_STYLE);
    expect(patch.victim_pov).toBe(false);
  });

  it('neutralises both fields of view on the way out of POV', () => {
    const patch = patchShotView(
      item({
        camera_style: 'pov',
        presentation: {
          camera_fov: 120,
          viewmodel_fov: 54,
          flash_alpha: 102,
          show_hud: true,
          show_radar: true,
          voice: 'all_players',
        },
      }),
      'observer',
      DEFAULTS,
    );
    expect(patch.presentation?.camera_fov).toBe(NEUTRAL_CAMERA_FOV);
    expect(patch.presentation?.viewmodel_fov).toBe(NEUTRAL_VIEWMODEL_FOV);
    /* The other four are the shot's own and must survive the move. */
    expect(patch.presentation?.flash_alpha).toBe(102);
  });

  it('leaves an observer shot alone — it keeps the style it already had', () => {
    /* An empty patch and 「set camera_style to the value it already has」 are the
       same edit; the empty one does not set `dirty`, which is the difference the
       page can feel. */
    expect(patchShotView(item({ camera_style: 'crane' }), 'observer', DEFAULTS)).toEqual({});
  });

  it('is a no-op when the view does not move', () => {
    expect(patchShotView(item({ camera_style: 'pov' }), 'player_pov', DEFAULTS)).toEqual({});
  });
});

describe('patchCameraStyle', () => {
  it('is a no-op for the style already chosen', () => {
    expect(patchCameraStyle(item(), 'tracking', DEFAULTS)).toEqual({});
  });

  it('carries no presentation when moving to POV — nothing needs neutralising', () => {
    expect(patchCameraStyle(item(), 'pov', DEFAULTS)).toEqual({ camera_style: 'pov' });
  });

  it.each(CAMERA_STYLES.filter((style) => style !== 'pov'))(
    'sends the neutral pair for %s, even when the shot followed the defaults',
    (style: CameraStyle) => {
      /* The global defaults carry a POV field of view (110/60 above), and the
         queue is validated per item — so a shot that "followed the defaults"
         would be rejected the moment it stopped being a POV shot. */
      const patch = patchCameraStyle(item({ camera_style: 'pov' }), style, DEFAULTS);
      expect(patch.camera_style).toBe(style);
      expect(patch.victim_pov).toBe(false);
      expect(patch.presentation?.camera_fov).toBe(NEUTRAL_CAMERA_FOV);
      expect(patch.presentation?.viewmodel_fov).toBe(NEUTRAL_VIEWMODEL_FOV);
    },
  );
});

/* ── presentation ────────────────────────────────────────────────────────── */

describe('patchPresentation', () => {
  it('expands the global defaults on the first touch — 「跟随」 becomes 「自己的」', () => {
    const patch = patchPresentation(item({ camera_style: 'pov' }), { show_hud: false }, DEFAULTS);
    expect(patch.presentation).toEqual({
      camera_fov: 110,
      viewmodel_fov: 60,
      flash_alpha: 255,
      show_hud: false,
      show_radar: true,
      voice: 'all_players',
    });
  });

  it('re-neutralises the POV-only pair for an observer shot on every write', () => {
    const patch = patchPresentation(item({ camera_style: 'crane' }), { show_radar: false }, DEFAULTS);
    expect(patch.presentation?.camera_fov).toBe(NEUTRAL_CAMERA_FOV);
    expect(patch.presentation?.viewmodel_fov).toBe(NEUTRAL_VIEWMODEL_FOV);
  });

  it('offers a way back to 「跟随全局默认」', () => {
    expect(detachedPresentationPatch()).toEqual({ presentation: null });
  });
});

/* ── presets and 应用到全部 ──────────────────────────────────────────────── */

describe('presetDraftFromShot', () => {
  it('freezes the values rather than the intention to follow a default', () => {
    const draft = presetDraftFromShot(item({ camera_style: 'pov' }), '我的 POV 参数', DEFAULTS);
    expect(draft.presentation.camera_fov).toBe(110);
    expect(draft.name).toBe('我的 POV 参数');
  });

  it('carries nothing that could retarget a shot at different footage', () => {
    const draft = presetDraftFromShot(item(), 'p', DEFAULTS) as Record<string, unknown>;
    for (const forbidden of ['demo_id', 'player_id', 'start_tick', 'end_tick', 'title', 'id']) {
      expect(draft[forbidden]).toBeUndefined();
    }
  });
});

describe('presetPatch', () => {
  const preset: RecordingShotPreset = {
    id: 'preset-1',
    name: '我的 POV 参数',
    camera_style: 'crane',
    victim_pov: false,
    pre_roll_seconds: 2,
    post_roll_seconds: 0.5,
    presentation: {
      camera_fov: 130,
      viewmodel_fov: 54,
      flash_alpha: 102,
      show_hud: false,
      show_radar: true,
      voice: 'muted',
    },
    created_at: '2026-08-15T09:02:00.000Z',
    updated_at: '2026-08-15T09:02:00.000Z',
  };

  it('neutralises against the preset’s own style, not the shot’s', () => {
    const patch = presetPatch(preset);
    expect(patch.camera_style).toBe('crane');
    expect(patch.presentation?.camera_fov).toBe(NEUTRAL_CAMERA_FOV);
    expect(patch.presentation?.flash_alpha).toBe(102);
  });

  it('moves every field at once — 「应用时作为一次原子变更」', () => {
    expect(Object.keys(presetPatch(preset)).sort()).toEqual(
      ['camera_style', 'post_roll_seconds', 'pre_roll_seconds', 'presentation', 'victim_pov'],
    );
  });
});

describe('applyToAllPatch', () => {
  it('copies exactly what a preset would, and nothing that names footage', () => {
    const patch = applyToAllPatch(item({ camera_style: 'pov', victim_pov: true }), DEFAULTS);
    expect(Object.keys(patch).sort()).toEqual(
      ['camera_style', 'post_roll_seconds', 'pre_roll_seconds', 'presentation', 'victim_pov'],
    );
    expect(patch.victim_pov).toBe(true);
  });
});

/* ── ordering ────────────────────────────────────────────────────────────── */

describe('nextShotIndex', () => {
  it('stops at the ends rather than wrapping', () => {
    expect(nextShotIndex(0, -1, 4)).toBe(0);
    expect(nextShotIndex(3, 1, 4)).toBe(3);
  });

  it('moves by one in the middle', () => {
    expect(nextShotIndex(1, 1, 4)).toBe(2);
    expect(nextShotIndex(2, -1, 4)).toBe(1);
  });

  it('answers -1 for an index the list does not have', () => {
    expect(nextShotIndex(9, 1, 4)).toBe(-1);
    expect(nextShotIndex(0, 1, 0)).toBe(-1);
  });
});

describe('reorderShots', () => {
  const items = [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })];

  it('moves one shot and leaves the rest in order', () => {
    expect(reorderShots(items, 0, 2).map((entry) => entry.id)).toEqual(['b', 'c', 'a']);
  });

  it('never mutates the array it was given', () => {
    reorderShots(items, 0, 2);
    expect(items.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
  });
});

/* ── durations, which are only sometimes knowable ────────────────────────── */

describe('shotDurationSeconds', () => {
  it('divides ticks by the rate it was given', () => {
    expect(shotDurationSeconds({ start_tick: 0, end_tick: 128 }, 64)).toBe(2);
    expect(shotDurationSeconds({ start_tick: 0, end_tick: 128 }, 128)).toBe(1);
  });

  it('answers null rather than assuming 64', () => {
    expect(shotDurationSeconds({ start_tick: 0, end_tick: 128 }, null)).toBeNull();
    expect(shotDurationSeconds({ start_tick: 0, end_tick: 128 }, 0)).toBeNull();
  });

  it('counts the shots it could not measure instead of treating them as zero', () => {
    const total = totalShotSeconds([item({ id: 'a' }), item({ id: 'b' })], (entry) =>
      entry.id === 'a' ? 3 : null,
    );
    expect(total).toEqual({ seconds: 3, unknownCount: 1 });
  });
});

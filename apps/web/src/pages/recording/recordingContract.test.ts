/*
 * `unit` project — the pure half of 「08」's contract.
 *
 * The two conversions here are the ones a reviewer cannot check by reading:
 * flash alpha, whose direction is inverted one layer further down, and the
 * preflight signature, which decides whether a check list survives an edit.
 */

import { i18n } from '@lingui/core';
import { beforeAll, describe, expect, it } from 'vitest';

import type {
  AgentPlan,
  AgentPlanShot,
  AppConfig,
  DirectorPlan,
  RecordingPresentation,
  RecordingRequest,
} from '../../shared/desktop/dto';
import {
  CAMERA_FOV_RANGE,
  FLASH_ALPHA_MAX,
  NEUTRAL_CAMERA_FOV,
  NEUTRAL_VIEWMODEL_FOV,
  PREFLIGHT_CHECK,
  agentPlanHasRecordableShot,
  agentPlanShotsNeedingBinding,
  directorShotForItem,
  flashAlphaToPercent,
  globalPresentationDefaults,
  isPovStyle,
  mergedItemCount,
  percentToFlashAlpha,
  presentationFieldsFor,
  presentationForStyle,
  recordingHref,
  recordingShotSignature,
  recordingTaskHref,
  resolveShotPresentation,
} from './recordingContract';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'zh-CN', messages: {} });
});

/* ── fixtures ────────────────────────────────────────────────────────────── */

const DEFAULTS: AppConfig['recording'] = {
  pre_roll_seconds: 1.5,
  post_roll_seconds: 1,
  resolution: '1920x1080',
  fps: 60,
  show_radar: true,
  show_hud: true,
  voice: 'all_players',
  camera_fov: 90,
  viewmodel_fov: 68,
  flash_alpha: 255,
};

const PRESENTATION: RecordingPresentation = {
  camera_fov: 110,
  viewmodel_fov: 60,
  flash_alpha: 102,
  show_hud: false,
  show_radar: false,
  voice: 'target_only',
};

function item(overrides: Partial<RecordingRequest> = {}): RecordingRequest {
  return {
    id: 'item-1',
    demo_id: 'demo-a',
    highlight_id: null,
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

function shot(overrides: Partial<AgentPlanShot> = {}): AgentPlanShot {
  return {
    id: 'shot-1',
    title: '建立地点',
    kind: 'static',
    view: 'observer',
    start_tick: 148_700,
    end_tick: 148_812,
    duration_seconds: 3,
    rationale: '',
    evidence_refs: [],
    risks: [],
    source: 'agent',
    removed_by: null,
    params: null,
    ...overrides,
  };
}

function planOf(shots: AgentPlanShot[]): AgentPlan {
  return {
    id: 'P-118',
    title: 'Kael Mirage 1v3',
    status: 'awaiting_confirmation',
    revision: 7,
    shots,
    origin: [],
    agent_baseline: { revision: 1, captured_at: '2026-08-15T09:02:00.000Z', shots },
    created_at: '2026-08-15T09:02:00.000Z',
    updated_at: '2026-08-15T09:47:00.000Z',
  };
}

/* ── the address ─────────────────────────────────────────────────────────── */

describe('recordingHref', () => {
  it('is the bare list with no plan and the plan itself with one', () => {
    expect(recordingHref(null)).toBe('/projects');
    expect(recordingHref('P-118')).toBe('/projects/plan%3AP-118?step=record&prepare=1');
  });

  it('escapes an id rather than pasting it into the path', () => {
    expect(recordingHref('a/b')).toBe('/projects/plan%3Aa%2Fb?step=record&prepare=1');
  });

  it('sends a started recording to the task address, not back here', () => {
    expect(recordingTaskHref('A-2481')).toBe('/delivery/task/recording%3AA-2481');
  });
});

/* ── flash ───────────────────────────────────────────────────────────────── */

describe('flash alpha ↔ 闪光强度', () => {
  /* `crates/hlae/src/scene_presentation.rs`'s own test: 「40% remaining flash
     alpha is 60% suppression」, i.e. `flash_alpha: 102` → `mirv_noflash 0.6`.
     The artboard's 「闪光强度 40%」 is therefore 102, not 153. */
  it('reads the board’s 40% as the backend’s 102', () => {
    expect(flashAlphaToPercent(102)).toBe(40);
    expect(percentToFlashAlpha(40)).toBe(102);
  });

  it('keeps full remaining flash at 100%, not 0%', () => {
    expect(flashAlphaToPercent(FLASH_ALPHA_MAX)).toBe(100);
    expect(flashAlphaToPercent(0)).toBe(0);
    expect(percentToFlashAlpha(100)).toBe(FLASH_ALPHA_MAX);
    expect(percentToFlashAlpha(0)).toBe(0);
  });

  it('round-trips every whole percent to within a percent', () => {
    for (let percent = 0; percent <= 100; percent += 1) {
      expect(`${percent}:${flashAlphaToPercent(percentToFlashAlpha(percent))}`).toBe(
        `${percent}:${percent}`,
      );
    }
  });

  it('answers an integer the u8 field can hold', () => {
    for (let percent = 0; percent <= 100; percent += 1) {
      const alpha = percentToFlashAlpha(percent);
      expect(`${percent}:${Number.isInteger(alpha) && alpha >= 0 && alpha <= 255}`).toBe(
        `${percent}:true`,
      );
    }
  });

  it('clamps rather than throwing on a value no control can produce', () => {
    expect(flashAlphaToPercent(-40)).toBe(0);
    expect(flashAlphaToPercent(4_000)).toBe(100);
    expect(flashAlphaToPercent(Number.NaN)).toBe(100);
    expect(percentToFlashAlpha(-1)).toBe(0);
    expect(percentToFlashAlpha(400)).toBe(FLASH_ALPHA_MAX);
    expect(percentToFlashAlpha(Number.NaN)).toBe(FLASH_ALPHA_MAX);
  });
});

/* ── presentation ────────────────────────────────────────────────────────── */

describe('presentationFieldsFor', () => {
  it('offers both fields of view to a POV shot', () => {
    const fields = presentationFieldsFor('pov');
    expect(fields.camera_fov.editable).toBe(true);
    expect(fields.viewmodel_fov.editable).toBe(true);
    expect(fields.camera_fov.disabledReason).toBeUndefined();
  });

  it('disables both — with a reason — for every observer style', () => {
    for (const style of ['orbit', 'dolly', 'static', 'tracking', 'crane', 'flyby'] as const) {
      const fields = presentationFieldsFor(style);
      expect(`${style}:${fields.camera_fov.editable}`).toBe(`${style}:false`);
      expect(`${style}:${fields.viewmodel_fov.editable}`).toBe(`${style}:false`);
      expect(`${style}:${fields.camera_fov.disabledReason !== undefined}`).toBe(`${style}:true`);
    }
  });

  it('keeps the other four editable for both kinds of shot', () => {
    for (const style of ['pov', 'crane'] as const) {
      const fields = presentationFieldsFor(style);
      for (const field of ['flash_alpha', 'show_hud', 'show_radar', 'voice'] as const) {
        expect(`${style}.${field}:${fields[field].editable}`).toBe(`${style}.${field}:true`);
      }
    }
  });

  it('agrees with isPovStyle', () => {
    expect(isPovStyle('pov')).toBe(true);
    expect(isPovStyle('crane')).toBe(false);
  });
});

describe('globalPresentationDefaults', () => {
  it('passes the stored voice policy through, because there is nothing to map', () => {
    /* This test used to assert a precedence rule over two booleans, including
       the combination config validation refused. Phase 3g collapsed the config
       to the same three-member enum the wire uses (§10 note 5), so the illegal
       combination is unrepresentable and the mapping is a field copy. */
    for (const voice of ['all_players', 'muted', 'target_only'] as const) {
      expect(globalPresentationDefaults({ ...DEFAULTS, voice }).voice).toBe(voice);
    }
  });

  it('carries the other five values through unchanged', () => {
    expect(globalPresentationDefaults(DEFAULTS)).toEqual({
      camera_fov: 90,
      viewmodel_fov: 68,
      flash_alpha: 255,
      show_hud: true,
      show_radar: true,
      voice: 'all_players',
    });
  });
});

describe('resolveShotPresentation', () => {
  it('treats null and undefined as 「跟随全局默认」, not as 「关掉」', () => {
    for (const empty of [null, undefined]) {
      const resolved = resolveShotPresentation(empty, DEFAULTS);
      expect(`${String(empty)}:${resolved.overridden}`).toBe(`${String(empty)}:false`);
      expect(resolved.value.show_hud).toBe(true);
      expect(resolved.value.flash_alpha).toBe(255);
    }
  });

  it('reports an override even when it happens to equal today’s default', () => {
    const same = globalPresentationDefaults(DEFAULTS);
    expect(resolveShotPresentation(same, DEFAULTS).overridden).toBe(true);
  });

  it('returns the shot’s own values when it has them', () => {
    const resolved = resolveShotPresentation(PRESENTATION, DEFAULTS);
    expect(resolved.overridden).toBe(true);
    expect(resolved.value).toEqual(PRESENTATION);
  });
});

describe('presentationForStyle', () => {
  it('leaves a POV shot alone', () => {
    expect(presentationForStyle(PRESENTATION, 'pov')).toEqual(PRESENTATION);
  });

  it('forces both fields of view back to neutral for an observer shot', () => {
    const normalized = presentationForStyle(PRESENTATION, 'crane');
    expect(normalized.camera_fov).toBe(NEUTRAL_CAMERA_FOV);
    expect(normalized.viewmodel_fov).toBe(NEUTRAL_VIEWMODEL_FOV);
    /* …and changes nothing else: the other four apply to both kinds. */
    expect(normalized.flash_alpha).toBe(PRESENTATION.flash_alpha);
    expect(normalized.show_hud).toBe(PRESENTATION.show_hud);
    expect(normalized.show_radar).toBe(PRESENTATION.show_radar);
    expect(normalized.voice).toBe(PRESENTATION.voice);
  });

  it('keeps the neutral values inside the ranges the backend accepts', () => {
    expect(NEUTRAL_CAMERA_FOV >= CAMERA_FOV_RANGE.min).toBe(true);
    expect(NEUTRAL_CAMERA_FOV <= CAMERA_FOV_RANGE.max).toBe(true);
  });
});

/* ── the preflight signature ─────────────────────────────────────────────── */

describe('recordingShotSignature', () => {
  it('is stable for an unchanged list', () => {
    expect(recordingShotSignature([item()])).toBe(recordingShotSignature([item()]));
  });

  it('changes when the order changes — the director merges adjacent shots', () => {
    const a = item({ id: 'a' });
    const b = item({ id: 'b' });
    expect(recordingShotSignature([a, b])).not.toBe(recordingShotSignature([b, a]));
  });

  it('changes on every field a check actually measures', () => {
    const base = recordingShotSignature([item()]);
    const moved: Array<Partial<RecordingRequest>> = [
      { demo_id: 'demo-b' },
      { player_id: '76561198000000002' },
      { start_tick: 1 },
      { end_tick: 2 },
      { pre_roll_seconds: 3 },
      { post_roll_seconds: 4 },
      { victim_pov: true },
      { camera_style: 'pov' },
      { presentation: PRESENTATION },
    ];
    for (const patch of moved) {
      const label = Object.keys(patch)[0] as string;
      expect(`${label}:${recordingShotSignature([item(patch)]) === base}`).toBe(`${label}:false`);
    }
  });

  it('changes when only one presentation field moves', () => {
    const withFlash = recordingShotSignature([item({ presentation: PRESENTATION })]);
    const withMoreFlash = recordingShotSignature([
      item({ presentation: { ...PRESENTATION, flash_alpha: 200 } }),
    ]);
    expect(withFlash).not.toBe(withMoreFlash);
  });

  it('does not change for a title, which no check reads', () => {
    expect(recordingShotSignature([item({ title: '别的名字' })])).toBe(
      recordingShotSignature([item()]),
    );
  });

  it('separates 「跟随全局默认」 from an override that equals it', () => {
    const inherited = recordingShotSignature([item({ presentation: null })]);
    const explicit = recordingShotSignature([
      item({ presentation: globalPresentationDefaults(DEFAULTS) }),
    ]);
    expect(inherited).not.toBe(explicit);
  });
});

/* ── director shots ──────────────────────────────────────────────────────── */

describe('directorShotForItem', () => {
  const director: DirectorPlan = {
    shots: [
      {
        demo_id: 'demo-a',
        source_item_ids: ['item-1', 'item-2'],
        player_id: '76561198000000001',
        kind: 'player',
        start_tick: 1,
        end_tick: 2,
        score: 1,
        evidence: [],
        explanation: '',
      },
    ],
    warnings: [],
    source_item_count: 3,
    merged_item_count: 2,
    victim_reaction_count: 0,
    unresolved_victim_requests: 0,
  };

  it('finds the merged shot two items share', () => {
    expect(directorShotForItem(director, 'item-1')).toBe(director.shots[0]);
    expect(directorShotForItem(director, 'item-2')).toBe(director.shots[0]);
  });

  it('answers null for an item the director dropped', () => {
    expect(directorShotForItem(director, 'item-3')).toBeNull();
  });

  it('counts how many items landed in one shot', () => {
    expect(mergedItemCount(director.shots[0] as DirectorPlan['shots'][number])).toBe(2);
  });
});

/* ── unbound Agent plan shots ────────────────────────────────────────────── */

describe('agentPlanShotsNeedingBinding', () => {
  const bound: AgentPlanShot = shot({
    id: 'bound',
    recording: {
      demo_id: 'demo-a',
      player_id: '76561198000000001',
      highlight_id: null,
      victim_pov: false,
      pre_roll_seconds: 1.5,
      post_roll_seconds: 1,
      presentation: null,
    },
  });

  it('names the live shots that carry no footage', () => {
    const unbound = shot({ id: 'unbound' });
    expect(agentPlanShotsNeedingBinding(planOf([bound, unbound])).map((one) => one.id)).toEqual([
      'unbound',
    ]);
  });

  it('treats a shot with an absent recording key the same as an explicit null', () => {
    const legacy = shot({ id: 'legacy' });
    delete (legacy as { recording?: unknown }).recording;
    expect(agentPlanShotsNeedingBinding(planOf([legacy])).map((one) => one.id)).toEqual(['legacy']);
  });

  it('ignores a soft-removed shot — the server ignores it too', () => {
    const removed = shot({ id: 'removed', removed_by: 'user' });
    expect(agentPlanShotsNeedingBinding(planOf([bound, removed]))).toEqual([]);
  });

  it('reports a plan whose every shot is removed as not recordable', () => {
    expect(agentPlanHasRecordableShot(planOf([shot({ removed_by: 'agent' })]))).toBe(false);
    expect(agentPlanHasRecordableShot(planOf([bound]))).toBe(true);
    expect(agentPlanHasRecordableShot(planOf([]))).toBe(false);
  });
});

/* ── the check-list vocabulary ───────────────────────────────────────────── */

describe('PREFLIGHT_CHECK', () => {
  it('labels all eight members of the closed set and nothing more', () => {
    expect(Object.keys(PREFLIGHT_CHECK).sort()).toEqual([
      'camera_collision_unverified',
      'capture_component_ready',
      'demo_content_matches',
      'encoder_available',
      'game_ready',
      'output_directory_writable',
      'spectator_evidence_complete',
      'tick_range_within_demo',
    ]);
  });

  it('gives every row a label and a hint', () => {
    for (const [code, meta] of Object.entries(PREFLIGHT_CHECK)) {
      expect(`${code}:${i18n._(meta.label) !== ''}`).toBe(`${code}:true`);
      expect(`${code}:${i18n._(meta.hint) !== ''}`).toBe(`${code}:true`);
    }
  });

  it('gives every row a distinct label', () => {
    const labels = Object.values(PREFLIGHT_CHECK).map((meta) => i18n._(meta.label));
    expect(new Set(labels).size).toBe(labels.length);
  });

  /* The wording of this one row is load-bearing: the check reports an unknown,
     not a detected collision, and it is never `blocked`. */
  it('says the collision geometry is unknown, not that a collision was found', () => {
    const label = i18n._(PREFLIGHT_CHECK.camera_collision_unverified.label);
    expect(label.includes('未知')).toBe(true);
    expect(label.includes('检测到')).toBe(false);
  });
});

/*
 * `unit` project — what 「用 Agent 制作视频」 actually hands over.
 *
 * `agentHandoff.test.ts` pins the *address*. This file pins the *payload*, which
 * is the half phase 3f-be made possible and the half that is easy to get wrong
 * quietly: a plan whose shots carry no `recording` binding looks fine on
 * `/agent` and can only be refused by `/recording/:planId` (422
 * `agent_plan_shots_unbound`). Every assertion below is a backend rule mirrored
 * on this side so the button can be disabled *before* the write.
 */

import { describe, expect, it } from 'vitest';

import {
  agentPlanDraftFromHighlights,
  agentPlanShotFromHighlight,
  handoffRefusalFor,
  isSteamId64,
  type HighlightHandoffSource,
} from './agentHandoff';

function source(overrides: Partial<HighlightHandoffSource> = {}): HighlightHandoffSource {
  return {
    highlightId: 'h-1',
    title: '1v3 残局',
    demoId: '0d1f0a2c-0000-4000-8000-000000000001',
    playerId: '76561198000000001',
    startTick: 148_920,
    endTick: 150_440,
    tickRate: 64,
    ...overrides,
  };
}

let counter = 0;
const newId = (): string => `shot-${(counter += 1)}`;

/* ── the binding ─────────────────────────────────────────────────────────── */

describe('agentPlanShotFromHighlight', () => {
  it('binds demo_id, player_id and highlight_id — the three §10.6 was waiting for', () => {
    const shot = agentPlanShotFromHighlight(source(), newId);
    expect(shot?.recording?.demo_id).toBe('0d1f0a2c-0000-4000-8000-000000000001');
    expect(shot?.recording?.player_id).toBe('76561198000000001');
    expect(shot?.recording?.highlight_id).toBe('h-1');
  });

  it('gives the shot its own identity, not the highlight’s', () => {
    const shot = agentPlanShotFromHighlight(source(), () => 'fresh');
    expect(shot?.id).toBe('fresh');
    /* The highlight still travels — twice, and both are read: the binding is
       what the recording plan uses, the evidence reference is what a reader
       follows. */
    expect(shot?.evidence_refs).toEqual(['h-1']);
  });

  it('computes duration_seconds from the analysis’ own tick rate', () => {
    expect(agentPlanShotFromHighlight(source({ tickRate: 64 }), newId)?.duration_seconds)
      .toBeCloseTo(23.75, 5);
    expect(agentPlanShotFromHighlight(source({ tickRate: 128 }), newId)?.duration_seconds)
      .toBeCloseTo(11.875, 5);
  });

  it('writes 0 rather than a guess when the tick rate is unknown', () => {
    expect(agentPlanShotFromHighlight(source({ tickRate: null }), newId)?.duration_seconds).toBe(0);
  });

  it('follows the global presentation defaults rather than freezing today’s', () => {
    expect(agentPlanShotFromHighlight(source(), newId)?.recording?.presentation).toBeNull();
  });

  it('sends params as an object — the backend rejects anything else', () => {
    expect(agentPlanShotFromHighlight(source(), newId)?.params).toEqual({});
  });

  it('starts as an observer shot; 视角 is 「08」’s decision, not this module’s', () => {
    const shot = agentPlanShotFromHighlight(source(), newId);
    expect(shot?.view).toBe('observer');
    expect(shot?.kind).toBe('tracking');
    expect(shot?.recording?.victim_pov).toBe(false);
  });
});

/* ── the three refusals ──────────────────────────────────────────────────── */

describe('isSteamId64', () => {
  it('accepts a canonical 17-digit id', () => {
    expect(isSteamId64('76561198000000001')).toBe(true);
  });

  it.each(['', '7656119800000000', '765611980000000012', '7656119800000000a', '00000000000000000'])(
    'rejects %s, which the backend rejects too',
    (value) => {
      expect(isSteamId64(value)).toBe(false);
    },
  );
});

describe('handoffRefusalFor', () => {
  it('names a missing Demo', () => {
    expect(handoffRefusalFor(source({ demoId: null }))).toBe('no_demo');
    expect(handoffRefusalFor(source({ demoId: '' }))).toBe('no_demo');
  });

  it('names a player the backend cannot accept', () => {
    expect(handoffRefusalFor(source({ playerId: 'kael' }))).toBe('no_player');
  });

  it('names a window that is not strictly positive', () => {
    expect(handoffRefusalFor(source({ endTick: 148_920 }))).toBe('empty_window');
    expect(handoffRefusalFor(source({ endTick: 100 }))).toBe('empty_window');
  });

  it('says nothing about a bindable highlight', () => {
    expect(handoffRefusalFor(source())).toBeNull();
  });
});

/* ── the draft ───────────────────────────────────────────────────────────── */

describe('agentPlanDraftFromHighlights', () => {
  it('turns N highlights into N bound shots of one draft plan', () => {
    const draft = agentPlanDraftFromHighlights({
      title: 'Mirage · 2 条高光',
      highlights: [source({ highlightId: 'h-1' }), source({ highlightId: 'h-2' })],
      newId,
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(draft.plan.title).toBe('Mirage · 2 条高光');
    expect(draft.plan.status).toBe('draft');
    expect(draft.plan.shots).toHaveLength(2);
    expect(draft.plan.shots.every((shot) => shot.recording !== null)).toBe(true);
  });

  it('creates no session — a handoff arrives before any conversation exists', () => {
    const draft = agentPlanDraftFromHighlights({ title: 't', highlights: [source()], newId });
    expect(draft.ok && draft.plan.origin).toBeNull();
  });

  it('gives each shot a distinct id — a plan rejects duplicate shot identities', () => {
    const draft = agentPlanDraftFromHighlights({
      title: 't',
      highlights: [source({ highlightId: 'h-1' }), source({ highlightId: 'h-1' })],
      newId,
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(new Set(draft.plan.shots.map((shot) => shot.id)).size).toBe(2);
  });

  it('refuses the whole selection rather than quietly dropping one shot', () => {
    const draft = agentPlanDraftFromHighlights({
      title: 't',
      highlights: [source(), source({ highlightId: 'h-2', demoId: null })],
      newId,
    });
    expect(draft).toEqual({ ok: false, refusal: 'no_demo' });
  });

  it('refuses an empty selection', () => {
    expect(agentPlanDraftFromHighlights({ title: 't', highlights: [], newId })).toEqual({
      ok: false,
      refusal: 'no_selection',
    });
  });

  it('reports the first missing fact, so one sentence can explain it', () => {
    expect(
      agentPlanDraftFromHighlights({ title: 't', highlights: [source({ playerId: '0' })], newId }),
    ).toEqual({ ok: false, refusal: 'no_player' });
  });
});

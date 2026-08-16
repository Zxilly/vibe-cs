/*
 * `unit` project — the pure half of `data/recording.ts`: the lease clock and
 * the two error vocabularies.
 *
 * These are separated from the hook tests because they are the parts a page
 * branches on, and a boundary condition is much easier to exhaust without a
 * React tree — `recordingPlanExpiry` takes `now` as an argument for exactly
 * that reason.
 */

import { describe, expect, it } from 'vitest';

import type { RecordingPlanResponse } from '../shared/desktop/dto';
import {
  RECORDING_PLAN_TTL_MS,
  agentPlanRecordingRefusal,
  isRecordingPlanLost,
  recordingPlanExpiresAt,
  recordingPlanExpiry,
  recordingPlanLoss,
} from './recording';

const MINTED_AT = Date.parse('2026-08-15T09:40:00.000Z');

function plan(expiresAt: string): RecordingPlanResponse {
  return {
    plan_id: 'plan-1',
    expires_at: expiresAt,
    active_items: 4,
    disabled_items: 0,
    estimated_seconds: 42,
    warnings: [],
    items: [],
    director: {
      shots: [],
      warnings: [],
      source_item_count: 4,
      merged_item_count: 0,
      victim_reaction_count: 0,
      unresolved_victim_requests: 0,
    },
  };
}

const FRESH = plan('2026-08-15T09:45:00.000Z');

describe('the five-minute lease', () => {
  it('mirrors the backend TTL', () => {
    expect(RECORDING_PLAN_TTL_MS).toBe(5 * 60 * 1000);
    expect(recordingPlanExpiresAt(FRESH)).toBe(MINTED_AT + RECORDING_PLAN_TTL_MS);
  });

  it('counts down while the lease holds', () => {
    expect(recordingPlanExpiry(FRESH, MINTED_AT)).toEqual({
      expired: false,
      remainingMs: RECORDING_PLAN_TTL_MS,
    });
    expect(recordingPlanExpiry(FRESH, MINTED_AT + 60_000)).toEqual({
      expired: false,
      remainingMs: 4 * 60_000,
    });
  });

  it('expires exactly at the boundary, not a tick after it', () => {
    expect(recordingPlanExpiry(FRESH, MINTED_AT + RECORDING_PLAN_TTL_MS - 1).expired).toBe(false);
    expect(recordingPlanExpiry(FRESH, MINTED_AT + RECORDING_PLAN_TTL_MS)).toEqual({
      expired: true,
      remainingMs: 0,
    });
  });

  it('clamps at zero rather than counting negative', () => {
    expect(recordingPlanExpiry(FRESH, MINTED_AT + 60 * 60_000).remainingMs).toBe(0);
  });

  it('is not 「已过期」 when there is no plan — that is a different screen', () => {
    expect(recordingPlanExpiry(null, MINTED_AT)).toEqual({ expired: false, remainingMs: null });
    expect(recordingPlanExpiresAt(null)).toBeNull();
  });

  it('refuses to call an unreadable timestamp expired', () => {
    const broken = plan('not a date');
    expect(recordingPlanExpiresAt(broken)).toBeNull();
    expect(recordingPlanExpiry(broken, MINTED_AT)).toEqual({ expired: false, remainingMs: null });
  });
});

describe('recordingPlanLoss', () => {
  it('names the two 409 codes the routes answer with', () => {
    expect(recordingPlanLoss({ status: 409, code: 'recording_plan_expired' })).toBe('expired');
    expect(recordingPlanLoss({ status: 409, code: 'recording_plan_unavailable' })).toBe(
      'unavailable',
    );
    expect(isRecordingPlanLost({ status: 409, code: 'recording_plan_expired' })).toBe(true);
  });

  it('does not claim every 409 is a lost plan', () => {
    expect(recordingPlanLoss({ status: 409, code: 'revision_conflict' })).toBeNull();
    expect(isRecordingPlanLost({ status: 409, code: 'revision_conflict' })).toBe(false);
  });

  it('does not claim a transport failure is a lost plan', () => {
    expect(recordingPlanLoss({ status: 0, code: 'REQUEST_ABORTED' })).toBeNull();
    expect(recordingPlanLoss(null)).toBeNull();
    expect(recordingPlanLoss(new Error('offline'))).toBeNull();
  });
});

describe('agentPlanRecordingRefusal', () => {
  it('names the two 422 codes', () => {
    expect(agentPlanRecordingRefusal({ status: 422, code: 'agent_plan_shots_unbound' })).toBe(
      'shots_unbound',
    );
    expect(agentPlanRecordingRefusal({ status: 422, code: 'agent_plan_not_recordable' })).toBe(
      'not_recordable',
    );
  });

  it('ignores anything else, including the 422 shape from another route', () => {
    expect(agentPlanRecordingRefusal({ status: 422, code: 'validation_failed' })).toBeNull();
    expect(agentPlanRecordingRefusal({ status: 400, code: 'agent_plan_shots_unbound' })).toBeNull();
    expect(agentPlanRecordingRefusal(undefined)).toBeNull();
  });
});

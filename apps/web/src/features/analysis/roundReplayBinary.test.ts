import { describe, expect, it } from 'vitest';

import { decodeRoundReplayBinary } from './roundReplayBinary';

const runId = '11111111-1111-4111-8111-111111111111';
const demoId = '22222222-2222-4222-8222-222222222222';

function artifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const players = Array.from({ length: 10 }, (_, index) => ({
    steam_id: `7656119${String(index + 1).padStart(10, '0')}`,
    name: `P${index + 1}`,
    team: index < 5 ? 'A' : 'B',
    side: index < 5 ? 'T' : 'CT',
    position: [index, index + 1, index + 2],
    yaw: 90,
    health: 100,
    armor: 100,
    life_state: 0,
    alive: true,
    active_weapon_name: index === 0 ? null : 'ak47',
  }));
  return {
    metadata: {
      producer_run_id: runId,
      demo_id: demoId,
      input_sha256: 'a'.repeat(64),
      input_size: 1024,
      round: 20,
      start_tick: 100,
      end_tick: 116,
      tick_rate: 64,
      sampling_contract_version: 1,
      sample_interval_ticks: 16,
      requested_tick_count: 2,
      accepted_tick_count: 2,
      event_tick_count: 0,
      players_per_frame: 10,
      fields: {
        position: 'required', yaw: 'required', health: 'required', armor: 'required',
        life_state: 'required', active_weapon_name: 'nullable',
      },
    },
    frames: [{ tick: 100, players }, { tick: 116, players }],
    ...overrides,
  };
}

function envelope(value: unknown): ArrayBuffer {
  const payload = new TextEncoder().encode(JSON.stringify(value));
  const bytes = new Uint8Array(12 + payload.length);
  bytes.set(new TextEncoder().encode('RRPL'));
  const view = new DataView(bytes.buffer);
  view.setUint16(4, 1, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, payload.length, true);
  bytes.set(payload, 12);
  return bytes.buffer;
}

describe('selected-round replay binary', () => {
  it('decodes exact source-bound ten-player frames without inventing a missing weapon', () => {
    const replay = decodeRoundReplayBinary(envelope(artifact()), { runId, demoId, round: 20 });
    expect(replay.frames).toHaveLength(2);
    expect(replay.frames[0]?.players).toHaveLength(10);
    expect(replay.frames[0]?.players[0]?.weapon).toBe('');
    expect(replay.fidelity.mode).toBe('entity_snapshots');
  });

  it('rejects a producer identity mismatch', () => {
    expect(() => decodeRoundReplayBinary(envelope(artifact()), {
      runId: '33333333-3333-4333-8333-333333333333', demoId, round: 20,
    })).toThrow(/identity/i);
  });

  it('rejects duplicate players and missing nullable fields', () => {
    const duplicate = artifact();
    const frames = duplicate.frames as Array<{ players: Array<Record<string, unknown>> }>;
    frames[0]!.players[1]!.steam_id = frames[0]!.players[0]!.steam_id;
    expect(() => decodeRoundReplayBinary(envelope(duplicate), { runId, demoId, round: 20 })).toThrow();

    const missing = artifact();
    delete (missing.frames as Array<{ players: Array<Record<string, unknown>> }>)[0]!.players[0]!.active_weapon_name;
    expect(() => decodeRoundReplayBinary(envelope(missing), { runId, demoId, round: 20 })).toThrow();
  });
});

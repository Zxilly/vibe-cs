import type { ReplayPayload } from '../../shared/desktop/dto';

const maximumBytes = 128 * 1024 * 1024;
const maximumFrames = 2_048;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256 = /^[0-9a-f]{64}$/;

type ExpectedRoundReplay = { runId: string; demoId: string; round: number };

function record(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  const candidate = value as Record<string, unknown>;
  const actual = Object.keys(candidate).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`Invalid ${label}`);
  }
  return candidate;
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`Invalid ${label}`);
  }
  return value as number;
}

function finite(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

export function decodeRoundReplayBinary(buffer: ArrayBuffer, expected: ExpectedRoundReplay): ReplayPayload {
  if (buffer.byteLength < 12 || buffer.byteLength > maximumBytes) throw new Error('Invalid round replay envelope');
  const bytes = new Uint8Array(buffer);
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== 'RRPL') throw new Error('Invalid round replay magic');
  const view = new DataView(buffer);
  if (view.getUint16(4, true) !== 1 || view.getUint16(6, true) !== 0) throw new Error('Unsupported round replay version');
  const payloadLength = view.getUint32(8, true);
  if (payloadLength !== buffer.byteLength - 12) throw new Error('Invalid round replay length');
  const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(12))) as unknown;
  const root = record(parsed, ['metadata', 'frames'], 'round replay');
  const metadata = record(root.metadata, [
    'producer_run_id', 'demo_id', 'input_sha256', 'input_size', 'round', 'start_tick', 'end_tick',
    'tick_rate', 'sampling_contract_version', 'sample_interval_ticks', 'requested_tick_count',
    'accepted_tick_count', 'event_tick_count', 'freeze_end_tick', 'players_per_frame', 'fields',
  ], 'round replay metadata');
  if (metadata.producer_run_id !== expected.runId || !uuid.test(String(metadata.producer_run_id))
      || metadata.demo_id !== expected.demoId || !uuid.test(String(metadata.demo_id))
      || metadata.round !== expected.round || !sha256.test(String(metadata.input_sha256))) {
    throw new Error('Round replay identity mismatch');
  }
  integer(metadata.input_size, 1, Number.MAX_SAFE_INTEGER, 'round replay input size');
  const startTick = integer(metadata.start_tick, 0, Number.MAX_SAFE_INTEGER, 'round replay start tick');
  const endTick = integer(metadata.end_tick, startTick, Number.MAX_SAFE_INTEGER, 'round replay end tick');
  const tickRate = finite(metadata.tick_rate, 8, 1024, 'round replay tick rate');
  if (metadata.sampling_contract_version !== 2 || metadata.sample_interval_ticks !== 16 || metadata.players_per_frame !== 10) {
    throw new Error('Unsupported round replay sampling contract');
  }
  const fields = record(metadata.fields, [
    'position', 'yaw', 'health', 'armor', 'life_state', 'money', 'current_equipment_value',
    'round_start_equipment_value', 'has_helmet', 'active_weapon_name',
  ], 'round replay fields');
  for (const required of [
    'position', 'yaw', 'health', 'armor', 'life_state', 'money', 'current_equipment_value',
    'round_start_equipment_value', 'has_helmet',
  ]) {
    if (fields[required] !== 'required') throw new Error('Invalid round replay field availability');
  }
  if (fields.active_weapon_name !== 'nullable') throw new Error('Invalid round replay weapon availability');
  if (!Array.isArray(root.frames)) throw new Error('Invalid round replay frames');
  const rawFrames = root.frames;
  const frameCount = integer(metadata.accepted_tick_count, 1, maximumFrames, 'accepted tick count');
  const eventTickCount = integer(metadata.event_tick_count, 0, maximumFrames, 'event tick count');
  const freezeEndTick = metadata.freeze_end_tick === null
    ? null
    : integer(metadata.freeze_end_tick, startTick, endTick, 'freeze end tick');
  if (metadata.requested_tick_count !== frameCount || rawFrames.length !== frameCount) throw new Error('Round replay frame count mismatch');

  let previousTick: number | null = null;
  let expectedRoster: string[] | null = null;
  const frames = rawFrames.map((rawFrame, frameIndex) => {
    const frame = record(rawFrame, ['tick', 'players'], 'round replay frame');
    const tick = integer(frame.tick, startTick, endTick, 'round replay frame tick');
    if ((previousTick !== null && tick <= previousTick) || (frameIndex === 0 && tick !== startTick)
        || (frameIndex === rawFrames.length - 1 && tick !== endTick)) throw new Error('Invalid round replay tick order');
    previousTick = tick;
    if (!Array.isArray(frame.players) || frame.players.length !== 10) throw new Error('Invalid round replay roster');
    const roster = new Set<string>();
    const teams = { A: 0, B: 0 };
    const sides = { T: 0, CT: 0 };
    const players = frame.players.map((rawPlayer) => {
      const player = record(rawPlayer, [
        'steam_id', 'name', 'team', 'side', 'position', 'yaw', 'health', 'armor', 'life_state', 'alive',
        'money', 'current_equipment_value', 'round_start_equipment_value', 'has_helmet', 'active_weapon_name',
      ], 'round replay player');
      const id = String(player.steam_id);
      if (!/^7656119[0-9]{10}$/.test(id) || roster.has(id)) throw new Error('Invalid round replay player identity');
      roster.add(id);
      if (player.team !== 'A' && player.team !== 'B') throw new Error('Invalid round replay team');
      if (player.side !== 'T' && player.side !== 'CT') throw new Error('Invalid round replay side');
      teams[player.team] += 1;
      sides[player.side] += 1;
      if (!Array.isArray(player.position) || player.position.length !== 3) throw new Error('Invalid round replay position');
      const position = player.position.map((value) => finite(value, -1_000_000, 1_000_000, 'round replay position')) as [number, number, number];
      const health = integer(player.health, 0, 200, 'round replay health');
      const armor = integer(player.armor, 0, 200, 'round replay armor');
      const lifeState = integer(player.life_state, 0, 255, 'round replay life state');
      if (typeof player.alive !== 'boolean' || player.alive !== (lifeState === 0 && health > 0)) throw new Error('Invalid round replay alive state');
      const money = integer(player.money, 0, 100_000, 'round replay money');
      const currentEquipmentValue = integer(player.current_equipment_value, 0, 100_000, 'round replay current equipment value');
      const roundStartEquipmentValue = integer(player.round_start_equipment_value, 0, 100_000, 'round replay round-start equipment value');
      if (typeof player.has_helmet !== 'boolean') throw new Error('Invalid round replay helmet state');
      if (!(player.active_weapon_name === null || (typeof player.active_weapon_name === 'string' && player.active_weapon_name.length <= 128))) {
        throw new Error('Invalid round replay weapon');
      }
      return {
        id,
        name: String(player.name),
        team: player.team,
        position,
        yaw: finite(player.yaw, -360, 360, 'round replay yaw'),
        health,
        armor,
        alive: player.alive,
        weapon: player.active_weapon_name ?? '',
        money,
        current_equipment_value: currentEquipmentValue,
        round_start_equipment_value: roundStartEquipmentValue,
        has_helmet: player.has_helmet,
        input: null,
      };
    });
    if (teams.A !== 5 || teams.B !== 5 || sides.T !== 5 || sides.CT !== 5) throw new Error('Invalid round replay team split');
    const rosterIds = [...roster].sort();
    if (expectedRoster && rosterIds.some((id, index) => id !== expectedRoster?.[index])) throw new Error('Round replay roster changed between frames');
    expectedRoster = rosterIds;
    return { tick, players, projectiles: [], bomb: null };
  });
  return {
    frames,
    fidelity: {
      mode: 'entity_snapshots', tick_rate: tickRate, frame_count: frameCount,
      positioned_event_count: eventTickCount, start_tick: startTick, end_tick: endTick,
    },
    cache: {
      state: 'bypassed', key: null, bytes: buffer.byteLength, generated_at: null, repaired: false,
      reason: freezeEndTick === null ? 'selected_round_source_bound' : `freeze_end_tick:${freezeEndTick}`,
    },
    freeze_end_tick: freezeEndTick,
  };
}

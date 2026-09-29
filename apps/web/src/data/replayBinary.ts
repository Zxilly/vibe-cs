/** ARPL v2. Old envelopes are rejected, never upgraded or read compatibly. */
import { t } from '@lingui/core/macro';

import { inflateVerified, MAXIMUM_BINARY_BYTES } from './compressedBinary';
import type { ReplayCacheMetadata, ReplayFidelityMetadata, ReplayFrameRecord, ReplayInputState, ReplayPayload } from '../shared/desktop/dto';

const maximumPlayerRecords = 1_000_000;
const maximumEffectRecords = 1_000_000;
const maximumFrames = 100_000;

function invalid(): never { throw new Error(t`回放数据无效或超出限制，请重新生成。`); }

class Reader {
  private offset = 0;
  private readonly view: DataView;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  constructor(private readonly bytes: Uint8Array<ArrayBuffer>) { this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
  private take(length: number): number {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytes.length) invalid();
    const start = this.offset; this.offset += length; return start;
  }
  u8(): number { return this.view.getUint8(this.take(1)); }
  u16(): number { return this.view.getUint16(this.take(2), true); }
  i16(): number { return this.view.getInt16(this.take(2), true); }
  u32(): number { return this.view.getUint32(this.take(4), true); }
  f32(): number { return this.view.getFloat32(this.take(4), true); }
  raw(length: number): Uint8Array { return this.bytes.subarray(this.take(length), this.offset); }
  text(): string { const length = this.u16(); if (length > 512) invalid(); return this.decoder.decode(this.raw(length)); }
  json(): unknown { const length = this.u32(); if (length > 64 * 1024) invalid(); return JSON.parse(this.decoder.decode(this.raw(length))) as unknown; }
  delta(): number {
    let value = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      const byte = this.u8();
      if (shift === 28 && byte > 15) invalid();
      value += (byte & 127) * 2 ** shift;
      if ((byte & 128) === 0) {
        if (shift !== 0 && byte === 0) invalid();
        return Math.floor(value / 2) ^ -(value & 1);
      }
    }
    return invalid();
  }
  position(previous: number[]): [number, number, number] {
    const position: [number, number, number] = [0, 0, 0];
    for (let axis = 0; axis < 3; axis += 1) {
      const value = previous[axis]! + this.delta();
      if (value < -16_000_000 || value > 16_000_000) invalid();
      previous[axis] = value; position[axis] = value / 16;
    }
    return position;
  }
  done(): boolean { return this.offset === this.bytes.length; }
}

function cacheMetadata(value: unknown): ReplayCacheMetadata {
  if (!value || typeof value !== 'object') throw new Error(t`战术回放缓存元数据无效`);
  const record = value as Record<string, unknown>;
  const expected = ['state', 'key', 'bytes', 'generated_at', 'repaired', 'reason'];
  if (Object.keys(record).some((key) => !expected.includes(key))) throw new Error(t`当前回放缓存字段无效`);
  const cache = record as ReplayCacheMetadata;
  if (!['hit', 'generated', 'bypassed'].includes(cache.state)
      || !(typeof cache.key === 'string' || cache.key === null)
      || !Number.isSafeInteger(cache.bytes) || cache.bytes < 0
      || !(typeof cache.generated_at === 'string' || cache.generated_at === null)
      || typeof cache.repaired !== 'boolean'
      || !(typeof cache.reason === 'string' || cache.reason === null)) throw new Error(t`当前回放缓存字段无效`);
  return cache;
}

function fidelityMetadata(value: unknown): ReplayFidelityMetadata {
  if (!value || typeof value !== 'object') throw new Error(t`战术回放缓存元数据无效`);
  const fidelity = value as ReplayFidelityMetadata;
  if (!['entity_snapshots', 'hybrid'].includes(fidelity.mode)
      || !Number.isFinite(fidelity.tick_rate) || fidelity.tick_rate < 8 || fidelity.tick_rate > 1024
      || !Number.isSafeInteger(fidelity.frame_count) || fidelity.frame_count < 0
      || !Number.isSafeInteger(fidelity.positioned_event_count) || fidelity.positioned_event_count < 0
      || fidelity.positioned_event_count > maximumEffectRecords
      || !Number.isSafeInteger(fidelity.start_tick) || fidelity.start_tick < 0
      || !Number.isSafeInteger(fidelity.end_tick) || fidelity.end_tick < fidelity.start_tick) {
    throw new Error(t`战术回放缓存元数据无效`);
  }
  return fidelity;
}



export async function decodeReplayBinary(buffer: ArrayBuffer): Promise<ReplayPayload> {
  if (buffer.byteLength < 16 || buffer.byteLength > MAXIMUM_BINARY_BYTES) invalid();
  const header = new DataView(buffer);
  if (header.getUint32(0, true) !== 0x4c505241 || header.getUint16(4, true) !== 2 || header.getUint16(6, true) !== 1) throw new Error(t`不支持的二进制回放格式`);
  const reader = new Reader(await inflateVerified(new Uint8Array(buffer, 16), header.getUint32(8, true), header.getUint32(12, true)));
  const cache = cacheMetadata(reader.json());
  const fidelity = fidelityMetadata(reader.json());
  const stringCount = reader.u16();
  if (stringCount > 16_384) invalid();
  const strings = Array.from({ length: stringCount }, () => reader.text());
  if (new Set(strings).size !== strings.length) invalid();
  const string = (index: number): string => { const value = strings[index]; if (value === undefined) invalid(); return value; };
  const optionalString = (index: number): string | null => index === 0xffff ? null : string(index);
  const rosterCount = reader.u16();
  if (rosterCount > 64) invalid();
  const identities = Array.from({ length: rosterCount }, () => {
    const id = string(reader.u16()); const name = string(reader.u16()); const side = reader.u8();
    if (id.length === 0 || side > 1) invalid();
    return { id, name, team: side === 0 ? 'A' as const : 'B' as const };
  });
  if (new Set(identities.map((identity) => identity.id)).size !== identities.length) invalid();
  const frameCount = reader.u32();
  if (frameCount > maximumFrames || frameCount !== fidelity.frame_count) invalid();
  if (frameCount === 0 && (fidelity.start_tick !== 0 || fidelity.end_tick !== 0)) invalid();
  const playerPositions = identities.map(() => [0, 0, 0]);
  const projectilePositions = new Map<number, number[]>();
  const bombPosition = [0, 0, 0];
  const frames: ReplayFrameRecord[] = [];
  // A dense match has hundreds of thousands of player records, but only 1,024
  // possible input masks. Share frozen values; player poses remain independent.
  const inputs = new Map<number, ReplayInputState>();
  let previousTick = -1;
  let playerRecords = 0;
  let effectRecords = 0;
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const tick = reader.u32();
    if (tick <= previousTick || (frameIndex === 0 && tick !== fidelity.start_tick) || (frameIndex === frameCount - 1 && tick !== fidelity.end_tick)) invalid();
    previousTick = tick;
    const playerCount = reader.u8();
    playerRecords += playerCount;
    if (playerCount > rosterCount || playerRecords > maximumPlayerRecords) invalid();
    const players: ReplayFrameRecord['players'] = [];
    const seenPlayers = new Set<number>();
    for (let index = 0; index < playerCount; index += 1) {
      const playerIndex = reader.u8(); const identity = identities[playerIndex];
      if (identity === undefined || seenPlayers.has(playerIndex)) invalid();
      seenPlayers.add(playerIndex);
      const position = reader.position(playerPositions[playerIndex]!);
      const yaw = reader.i16() / 128; const pitch = reader.i16() / 128;
      if (Math.abs(yaw) > 180 || Math.abs(pitch) > 180) invalid();
      const health = reader.u8(); const armor = reader.u8(); const alive = reader.u8();
      const weapon = string(reader.u16()); const mask = reader.u16();
      if (alive > 1 || (mask !== 0xffff && (mask & ~1023) !== 0)) invalid();
      let input = mask === 0xffff ? null : inputs.get(mask);
      if (input === undefined) {
        input = Object.freeze({
          forward: Boolean(mask & 1), left: Boolean(mask & 2), backward: Boolean(mask & 4), right: Boolean(mask & 8),
          jump: Boolean(mask & 16), crouch: Boolean(mask & 32), walk: Boolean(mask & 64), reload: Boolean(mask & 128),
          fire: Boolean(mask & 256), secondary_fire: Boolean(mask & 512),
        });
        inputs.set(mask, input);
      }
      players.push({ ...identity, position, yaw, pitch, health, armor, alive: alive === 1, weapon, input });
    }
    const effectCount = reader.u16(); effectRecords += effectCount;
    if (effectCount > 512 || effectRecords > maximumEffectRecords) invalid();
    const projectiles: ReplayFrameRecord['projectiles'] = [];
    const seenProjectiles = new Set<number>();
    for (let index = 0; index < effectCount; index += 1) {
      const idIndex = reader.u16(); const id = string(idIndex); const kind = string(reader.u16());
      const owner_id = optionalString(reader.u16()); const flags = reader.u8();
      if (flags > 7 || seenProjectiles.has(idIndex)) invalid();
      seenProjectiles.add(idIndex);
      let previous = projectilePositions.get(idIndex);
      if (previous === undefined) { previous = [0, 0, 0]; projectilePositions.set(idIndex, previous); }
      const position = reader.position(previous);
      const rawRadius = reader.f32();
      const radius = Number.isNaN(rawRadius) ? null : rawRadius;
      if (radius !== null && (!Number.isFinite(radius) || radius < 0 || radius > 4096)) invalid();
      const start_tick = reader.u32(); const end_tick = reader.u32();
      if (start_tick > end_tick) invalid();
      projectiles.push({ id, kind, owner_id, phase: (flags & 4) === 0 ? 'flying' : 'effect', start_tick, end_tick, position, active: Boolean(flags & 1), masks_vision: Boolean(flags & 2), radius });
    }
    const hasBomb = reader.u8();
    if (hasBomb > 1) invalid();
    const bomb = hasBomb === 1 ? { position: reader.position(bombPosition), state: string(reader.u16()), carrier_id: optionalString(reader.u16()) } : null;
    frames.push({ tick, players, projectiles, bomb });
  }
  if (!reader.done()) invalid();
  return { frames, cache, fidelity };
}

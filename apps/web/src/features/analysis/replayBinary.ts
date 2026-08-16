import { msg, msgf } from '../../shared/i18n';
import type { ReplayCacheMetadata, ReplayFidelityMetadata, ReplayFrameRecord, ReplayPayload } from '../../shared/desktop/dto';

const maximumBytes = 128 * 1024 * 1024;
const maximumPlayerRecords = 200_000;
const maximumEffectRecords = 100_000;

class Reader {
  private offset = 0;
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });

  constructor(buffer: ArrayBuffer) {
    if (buffer.byteLength > maximumBytes) throw new Error(msg("m0176"));
    this.view = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
  }

  private take(length: number): number {
    const start = this.offset;
    this.offset += length;
    if (!Number.isSafeInteger(length) || length < 0 || this.offset > this.view.byteLength) throw new Error(msg("m0174"));
    return start;
  }

  u8(): number { return this.view.getUint8(this.take(1)); }
  u16(): number { return this.view.getUint16(this.take(2), true); }
  u32(): number { return this.view.getUint32(this.take(4), true); }
  u64(): number {
    const value = this.view.getBigUint64(this.take(8), true);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(msg("m0375"));
    return Number(value);
  }
  f64(): number { return this.view.getFloat64(this.take(8), true); }
  finite(): number {
    const value = this.f64();
    if (!Number.isFinite(value)) throw new Error(msg("m0173"));
    return value;
  }
  raw(length: number): Uint8Array { return this.bytes.subarray(this.take(length), this.offset); }
  text(optional = false): string | null {
    const length = this.u16();
    if (optional && length === 0xffff) return null;
    return this.decoder.decode(this.raw(length));
  }
  done(): boolean { return this.offset === this.view.byteLength; }
}

function cacheMetadata(value: unknown): ReplayCacheMetadata {
  if (!value || typeof value !== 'object') throw new Error(msg("m0379"));
  const record = value as Record<string, unknown>;
  const expected = ['state', 'key', 'bytes', 'generated_at', 'repaired', 'reason'];
  if (Object.keys(record).some((key) => !expected.includes(key))) throw new Error(msg("m0380"));
  const cache = record as ReplayCacheMetadata;
  if (!['hit', 'generated', 'bypassed'].includes(cache.state)
      || !(typeof cache.key === 'string' || cache.key === null)
      || !Number.isSafeInteger(cache.bytes) || cache.bytes < 0
      || !(typeof cache.generated_at === 'string' || cache.generated_at === null)
      || typeof cache.repaired !== 'boolean'
      || !(typeof cache.reason === 'string' || cache.reason === null)) throw new Error(msg("m0380"));
  return cache;
}

function fidelityMetadata(value: unknown): ReplayFidelityMetadata {
  if (!value || typeof value !== 'object') throw new Error(msg("m0379"));
  const fidelity = value as ReplayFidelityMetadata;
  if (!['entity_snapshots', 'hybrid', 'event_sparse'].includes(fidelity.mode)
      || !Number.isFinite(fidelity.tick_rate) || fidelity.tick_rate < 8 || fidelity.tick_rate > 1024
      || !Number.isSafeInteger(fidelity.frame_count) || fidelity.frame_count < 0
      || !Number.isSafeInteger(fidelity.positioned_event_count) || fidelity.positioned_event_count < 0
      || fidelity.positioned_event_count > maximumEffectRecords
      || !Number.isSafeInteger(fidelity.start_tick) || fidelity.start_tick < 0
      || !Number.isSafeInteger(fidelity.end_tick) || fidelity.end_tick < fidelity.start_tick) {
    throw new Error(msg("m0379"));
  }
  return fidelity;
}

export function decodeReplayBinary(buffer: ArrayBuffer): ReplayPayload {
  const reader = new Reader(buffer);
  if (new TextDecoder().decode(reader.raw(4)) !== 'ARPL') throw new Error(msg("m0151"));
  const cacheLength = reader.u32();
  if (cacheLength > 64 * 1024) throw new Error(msg("m0381"));
  const cache = cacheMetadata(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(reader.raw(cacheLength))) as unknown);
  const fidelityLength = reader.u32();
  if (fidelityLength > 64 * 1024) throw new Error(msg("m0381"));
  const fidelity = fidelityMetadata(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(reader.raw(fidelityLength))) as unknown);
  const frameCount = reader.u32();
  if (frameCount > 20_000) throw new Error(msg("m0377"));
  if (fidelity.frame_count !== frameCount) throw new Error(msg("m0379"));
  if (frameCount === 0 && (fidelity.start_tick !== 0 || fidelity.end_tick !== 0)) throw new Error(msg("m0379"));
  const frames: ReplayFrameRecord[] = [];
  let previousTick: number | null = null;
  let playerRecords = 0;
  let effectRecords = 0;
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const tick = reader.u64();
    if (previousTick !== null && tick <= previousTick) throw new Error(msg("m0379"));
    if ((frameIndex === 0 && tick !== fidelity.start_tick)
        || (frameIndex === frameCount - 1 && tick !== fidelity.end_tick)) {
      throw new Error(msg("m0379"));
    }
    previousTick = tick;
    const playerCount = reader.u16();
    if (playerCount > 64) throw new Error(msg("m0311"));
    playerRecords += playerCount;
    if (playerRecords > maximumPlayerRecords) throw new Error(msg("m0311"));
    const players: ReplayFrameRecord['players'] = [];
    for (let index = 0; index < playerCount; index += 1) {
      const id = reader.text()!;
      const name = reader.text()!;
      const team = reader.text()! as 'A' | 'B';
      if (team !== 'A' && team !== 'B') throw new Error(msgf("m0171", [team]));
      const position: [number, number, number] = [reader.finite(), reader.finite(), reader.finite()];
      const yaw = reader.finite();
      const health = reader.u32();
      const armor = reader.u32();
      const alive = reader.u8() === 1;
      const weapon = reader.text()!;
      const mask = reader.u16();
      players.push({
        id, name, team, position, yaw, health, armor, alive, weapon,
        input: mask === 0xffff ? null : {
          forward: Boolean(mask & 1), left: Boolean(mask & 2), backward: Boolean(mask & 4), right: Boolean(mask & 8),
          jump: Boolean(mask & 16), crouch: Boolean(mask & 32), walk: Boolean(mask & 64), reload: Boolean(mask & 128),
          fire: Boolean(mask & 256), secondary_fire: Boolean(mask & 512),
        },
      });
    }
    const effectCount = reader.u16();
    if (effectCount > 512) throw new Error(msg("m0312"));
    effectRecords += effectCount;
    if (effectRecords > maximumEffectRecords) throw new Error(msg("m0312"));
    const projectiles: ReplayFrameRecord['projectiles'] = [];
    for (let index = 0; index < effectCount; index += 1) {
      const kind = reader.text()!;
      const position: [number, number, number] = [reader.finite(), reader.finite(), reader.finite()];
      const active = reader.u8() === 1;
      const rawRadius = reader.f64();
      const masksVision = reader.u8() === 1;
      projectiles.push({ kind, position, active, radius: Number.isFinite(rawRadius) ? rawRadius : null, masks_vision: masksVision });
    }
    const hasBomb = reader.u8();
    const bomb = hasBomb === 1 ? {
      position: [reader.finite(), reader.finite(), reader.finite()] as [number, number, number],
      state: reader.text()!,
      carrier_id: reader.text(true),
    } : null;
    if (hasBomb > 1) throw new Error(msg("m0175"));
    frames.push({ tick, players, projectiles, bomb });
  }
  if (!reader.done()) throw new Error(msg("m0172"));
  return { frames, fidelity, cache };
}

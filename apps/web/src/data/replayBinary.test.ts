import { readFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { crc32 } from './compressedBinary';
import { decodeReplayBinary } from './replayBinary';

const fixture = (): ArrayBuffer => Uint8Array.from(readFileSync(new URL('./test/fixtures/replay-v2.bin', import.meta.url))).buffer;

function rewrite(mutate: (payload: Uint8Array) => void): ArrayBuffer {
  const bytes = new Uint8Array(fixture());
  const payload = Uint8Array.from(inflateSync(bytes.subarray(16)));
  mutate(payload);
  const compressed = deflateSync(payload);
  const out = new Uint8Array(16 + compressed.length);
  out.set(bytes.subarray(0, 16)); out.set(compressed, 16);
  new DataView(out.buffer).setUint32(8, payload.length, true);
  new DataView(out.buffer).setUint32(12, crc32(payload), true);
  return out.buffer;
}

function stringTableOffset(payload: Uint8Array): number {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const fidelity = 4 + view.getUint32(0, true);
  return fidelity + 4 + view.getUint32(fidelity, true);
}

describe('ARPL v2 replay', () => {
  it('shares immutable input combinations without sharing mutable player poses', async () => {
    const replay = await decodeReplayBinary(fixture());
    const first = replay.frames[0]!.players[0]!;
    const next = replay.frames[1]!.players[0]!;
    expect(first.input).toBe(next.input);
    expect(Object.isFrozen(first.input)).toBe(true);
    expect(() => { first.input!.forward = false; }).toThrow(TypeError);
    expect(next.input!.forward).toBe(true);
    expect(first.position).not.toBe(next.position);
    expect(next.position).toEqual([-999.9375, 65, 31.9375]);
  });

  it('decodes Rust-produced identities, pose deltas, input, utility lifetimes and bomb state', async () => {
    const replay = await decodeReplayBinary(fixture());
    expect(replay.frames.map((frame) => frame.tick)).toEqual([8, 16, 24]);
    expect(replay.frames[0]?.players[0]).toMatchObject({ id: '76561198000000001', name: 'Player', team: 'A', position: [-1000, 64, 32], yaw: 179, pitch: -32, input: { forward: true, fire: true } });
    expect(replay.frames[1]?.players[0]).toMatchObject({ position: [-999.9375, 65, 31.9375], yaw: -179, pitch: 45 });
    expect(replay.frames[0]?.projectiles[0]).toMatchObject({ id: 'projectile:42:3', phase: 'flying', owner_id: '76561198000000001', start_tick: 8, end_tick: 15, radius: null });
    expect(replay.frames[1]?.projectiles[0]).toMatchObject({ phase: 'effect', kind: 'smoke', radius: 144, start_tick: 16, end_tick: 64, masks_vision: true });
    expect(replay.frames[2]?.bomb).toEqual({ position: [4, 5, 0], state: 'planted', carrier_id: null });
  });

  it('rejects old versions and every truncated prefix instead of returning a partial replay', async () => {
    const bytes = fixture();
    for (let length = 0; length < bytes.byteLength; length += 1) await expect(decodeReplayBinary(bytes.slice(0, length))).rejects.toThrow();
    const old = fixture(); new DataView(old).setUint16(4, 1, true);
    await expect(decodeReplayBinary(old)).rejects.toThrow();
    const extra = new Uint8Array(bytes.byteLength + 1); extra.set(new Uint8Array(bytes));
    await expect(decodeReplayBinary(extra.buffer)).rejects.toThrow();
  });

  it('rejects allocation bombs, CRC corruption and oversized shared tables', async () => {
    for (const offset of [8, 12]) {
      const bytes = fixture(); new DataView(bytes).setUint32(offset, 0xffffffff, true);
      await expect(decodeReplayBinary(bytes)).rejects.toThrow();
    }
    const badTable = rewrite((bytes) => new DataView(bytes.buffer).setUint16(stringTableOffset(bytes), 0xffff, true));
    await expect(decodeReplayBinary(badTable)).rejects.toThrow();
  });

  it.runIf(process.env.VIBE_REPLAY_V2_BIN !== undefined)('decodes the real dense demo and keeps all measured records', async () => {
    const bytes = Uint8Array.from(readFileSync(process.env.VIBE_REPLAY_V2_BIN!));
    const replay = await decodeReplayBinary(bytes.buffer);
    expect(replay.frames.length).toBeGreaterThan(10_000);
    expect(replay.frames.reduce((total, frame) => total + frame.players.length, 0)).toBeGreaterThan(100_000);
    const inputs = replay.frames.flatMap((frame) => frame.players.map((player) => player.input)).filter((input) => input !== null);
    const combinations = new Set(inputs);
    expect(combinations.size).toBeLessThanOrEqual(1024);
    expect(combinations.size).toBe(new Set(inputs.map((input) => JSON.stringify(input))).size);
    expect([...combinations].every(Object.isFrozen)).toBe(true);
    console.info(`Real replay input records: ${inputs.length}; shared combinations: ${combinations.size}`);
    expect(replay.frames.some((frame) => frame.players.some((player) => Math.abs(player.pitch) > 1))).toBe(true);
    expect(replay.frames.some((frame) => frame.projectiles.some((projectile) => projectile.phase === 'flying'))).toBe(true);
    expect(replay.frames.some((frame) => frame.projectiles.some((projectile) => projectile.phase === 'effect' && projectile.kind === 'smoke' && projectile.radius !== null))).toBe(true);
  });
});

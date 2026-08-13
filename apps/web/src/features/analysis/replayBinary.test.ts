import { describe, expect, it } from 'vitest';

import { decodeReplayBinary } from './replayBinary';

function text(value: string): number[] {
  const bytes = [...new TextEncoder().encode(value)];
  return [bytes.length & 0xff, bytes.length >> 8, ...bytes];
}

function u32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
}

function u64(value: number): number[] {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
  return [...bytes];
}

function f64(value: number): number[] {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, true);
  return [...bytes];
}

function concatBytes(chunks: Uint8Array[]): ArrayBuffer {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes.buffer;
}

function replayWithRecords({
  playerRecords = 0,
  effectRecords = 0,
}: {
  playerRecords?: number;
  effectRecords?: number;
}): ArrayBuffer {
  const cache = new TextEncoder().encode(JSON.stringify({
    state: 'generated', key: 'key', bytes: 256, generated_at: null, repaired: false, reason: null,
  }));
  const frameCount = Math.max(Math.ceil(playerRecords / 64), Math.ceil(effectRecords / 512));
  const fidelity = new TextEncoder().encode(JSON.stringify({
    mode: 'event_sparse', tick_rate: 64, frame_count: frameCount, positioned_event_count: 0,
    start_tick: frameCount === 0 ? 0 : 1, end_tick: frameCount,
  }));
  const player = Uint8Array.from([
    ...text(''), ...text(''), ...text('A'),
    ...f64(0), ...f64(0), ...f64(0), ...f64(0),
    ...u32(100), ...u32(0), 1, ...text(''), 0xff, 0xff,
  ]);
  const effect = Uint8Array.from([
    ...text(''), ...f64(0), ...f64(0), ...f64(0), 1, ...f64(144), 1,
  ]);
  const chunks = [Uint8Array.from([
    ...new TextEncoder().encode('ARPL'),
    ...u32(cache.length), ...cache,
    ...u32(fidelity.length), ...fidelity,
    ...u32(frameCount),
  ])];
  let remainingPlayers = playerRecords;
  let remainingEffects = effectRecords;
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const playerCount = Math.min(remainingPlayers, 64);
    const effectCount = Math.min(remainingEffects, 512);
    const frame = new Uint8Array(8 + 2 + player.length * playerCount + 2 + effect.length * effectCount + 1);
    const view = new DataView(frame.buffer);
    view.setBigUint64(0, BigInt(frameIndex + 1), true);
    view.setUint16(8, playerCount, true);
    let offset = 10;
    for (let index = 0; index < playerCount; index += 1) {
      frame.set(player, offset);
      offset += player.length;
    }
    view.setUint16(offset, effectCount, true);
    offset += 2;
    for (let index = 0; index < effectCount; index += 1) {
      frame.set(effect, offset);
      offset += effect.length;
    }
    frame[offset] = 0;
    chunks.push(frame);
    remainingPlayers -= playerCount;
    remainingEffects -= effectCount;
  }
  return concatBytes(chunks);
}

function replayBinary(
  ticks: number[] = [128],
  fidelityOverrides: Record<string, number> = {},
  cacheOverrides: Record<string, unknown> = {},
): ArrayBuffer {
  const cache = new TextEncoder().encode(JSON.stringify({
    state: 'generated', key: 'key', bytes: 256, generated_at: null, repaired: false, reason: null,
    ...cacheOverrides,
  }));
  const fidelity = new TextEncoder().encode(JSON.stringify({
    mode: 'event_sparse', tick_rate: 64, frame_count: ticks.length, positioned_event_count: ticks.length,
    start_tick: ticks[0] ?? 0, end_tick: ticks.at(-1) ?? 0,
    ...fidelityOverrides,
  }));
  const frames = ticks.flatMap((tick) => [
    ...u64(tick), 1, 0,
    ...text('76561197960690195'), ...text('FalleN'), ...text('A'),
    ...f64(12), ...f64(34), ...f64(5), ...f64(0),
    64, 0, 0, 0, 20, 0, 0, 0, 1, ...text('ak47'), 0xff, 0xff,
    0, 0, 0,
  ]);
  return Uint8Array.from([
    ...new TextEncoder().encode('ARPL'),
    ...u32(cache.length), ...cache,
    ...u32(fidelity.length), ...fidelity,
    ...u32(ticks.length), ...frames,
  ]).buffer;
}

describe('binary replay decoder', () => {
  it('rejects unknown cache metadata fields', () => {
    expect(() => decodeReplayBinary(replayBinary([], {}, { unexpected: true }))).toThrow();
  });

  it('rejects unknown or truncated payloads', () => {
    expect(() => decodeReplayBinary(new Uint8Array([1, 2, 3]).buffer)).toThrow();
    expect(() => decodeReplayBinary(new TextEncoder().encode('ARPL\x01').buffer)).toThrow();
  });

  it('decodes canonical players with truthful sparse fidelity', () => {
    const replay = decodeReplayBinary(replayBinary());

    expect(replay.frames[0]?.players[0]).toMatchObject({ name: 'FalleN', team: 'A', health: 64 });
    expect(replay.fidelity).toEqual({
      mode: 'event_sparse', tick_rate: 64, frame_count: 1, positioned_event_count: 1, start_tick: 128, end_tick: 128,
    });
  });

  it('rejects duplicate replay ticks', () => {
    expect(() => decodeReplayBinary(replayBinary([128, 128]))).toThrow();
  });

  it('rejects empty payloads whose fidelity advertises non-empty tick bounds', () => {
    expect(() => decodeReplayBinary(replayBinary([], { start_tick: 1, end_tick: 1 }))).toThrow();
  });

  it('rejects fidelity that exceeds the positioned-event evidence budget', () => {
    expect(() => decodeReplayBinary(replayBinary([128], { positioned_event_count: 100_001 }))).toThrow();
  });

  it('rejects more than two hundred thousand player records', () => {
    expect(() => decodeReplayBinary(replayWithRecords({ playerRecords: 200_001 }))).toThrow();
  });

  it('rejects more than one hundred thousand effect records', () => {
    expect(() => decodeReplayBinary(replayWithRecords({ effectRecords: 100_001 }))).toThrow();
  });
});

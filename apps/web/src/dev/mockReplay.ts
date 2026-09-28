/** Synthetic ARPL v2 fixture for browser development, never production data. */
import { crc32 } from '../data/compressedBinary';

interface ReplaySource {
  readonly tick_rate: number;
  readonly rounds: readonly { readonly number: number; readonly start_tick: number; readonly end_tick: number }[];
  readonly players: readonly { readonly steam_id: string; readonly name: string; readonly team: string }[];
  readonly highlights: readonly { readonly start_tick: number; readonly end_tick: number }[];
}

const encoder = new TextEncoder();
class Writer {
  private buffer = new Uint8Array(4096);
  private view = new DataView(this.buffer.buffer);
  private offset = 0;
  private take(length: number): number {
    const offset = this.offset;
    if (offset + length > this.buffer.length) {
      const next = new Uint8Array(Math.max(this.buffer.length * 2, offset + length));
      next.set(this.buffer); this.buffer = next; this.view = new DataView(next.buffer);
    }
    this.offset += length; return offset;
  }
  bytes(bytes: Uint8Array): void { const at = this.take(bytes.length); this.buffer.set(bytes, at); }
  u8(value: number): void { const at = this.take(1); this.view.setUint8(at, value); }
  u16(value: number): void { const at = this.take(2); this.view.setUint16(at, value, true); }
  i16(value: number): void { const at = this.take(2); this.view.setInt16(at, value, true); }
  u32(value: number): void { const at = this.take(4); this.view.setUint32(at, value, true); }
  f32(value: number): void { const at = this.take(4); this.view.setFloat32(at, value, true); }
  text(value: string): void { const bytes = encoder.encode(value); this.u16(bytes.length); this.bytes(bytes); }
  json(value: unknown): void { const bytes = encoder.encode(JSON.stringify(value)); this.u32(bytes.length); this.bytes(bytes); }
  position(point: number[], previous: number[]): void {
    point.forEach((value, axis) => {
      const quantized = Math.round(value * 16);
      const delta = quantized - previous[axis]!; previous[axis] = quantized;
      let encoded = delta >= 0 ? delta * 2 : -delta * 2 - 1;
      while (encoded >= 128) { this.u8((encoded & 127) | 128); encoded = Math.floor(encoded / 128); }
      this.u8(encoded);
    });
  }
  angle(value: number): void { this.i16(Math.round((((value + 180) % 360 + 360) % 360 - 180) * 128)); }
  finish(): Uint8Array<ArrayBuffer> { return this.buffer.slice(0, this.offset); }
}

export async function mockReplayBinary(source: ReplaySource): Promise<ArrayBuffer> {
  const tickSet = new Set<number>();
  for (const round of source.rounds) { for (let tick = round.start_tick; tick < round.end_tick; tick += 16) tickSet.add(tick); tickSet.add(round.end_tick); }
  for (const highlight of source.highlights) { for (let tick = highlight.start_tick; tick < highlight.end_tick; tick += 8) tickSet.add(tick); tickSet.add(highlight.end_tick); }
  const ticks = [...tickSet].sort((a, b) => a - b);
  const strings: string[] = [];
  const lookup = new Map<string, number>();
  const intern = (text: string): number => {
    let index = lookup.get(text);
    if (index === undefined) { index = strings.length; strings.push(text); lookup.set(text, index); }
    return index;
  };
  source.players.forEach((player) => { intern(player.steam_id); intern(player.name); });
  intern('awp'); intern('ak47'); intern('smoke');
  source.rounds.forEach((round) => { intern(`mock-flight:${round.number}`); intern(`mock-smoke:${round.number}`); });
  const writer = new Writer();
  writer.json({ state: 'generated', key: null, bytes: 0, generated_at: null, repaired: false, reason: null });
  writer.json({ mode: 'hybrid', tick_rate: source.tick_rate, frame_count: ticks.length, positioned_event_count: source.rounds.length, start_tick: ticks[0] ?? 0, end_tick: ticks.at(-1) ?? 0 });
  writer.u16(strings.length); strings.forEach((text) => writer.text(text));
  writer.u16(source.players.length);
  source.players.forEach((player) => {
    if (player.team !== 'A' && player.team !== 'B') throw new Error('Mock replay requires Team A/B identities');
    writer.u16(intern(player.steam_id)); writer.u16(intern(player.name)); writer.u8(player.team === 'B' ? 1 : 0);
  });
  writer.u32(ticks.length);
  const playerPositions = source.players.map(() => [0, 0, 0]);
  const projectilePositions = new Map<number, number[]>();
  for (const tick of ticks) {
    writer.u32(tick); writer.u8(source.players.length);
    source.players.forEach((player, index) => {
      const seconds = tick / source.tick_rate; const phase = index * 0.9; const side = player.team === 'A' ? -1 : 1;
      writer.u8(index);
      writer.position([-670 + side * 700 + Math.cos(seconds * 0.35 + phase) * 650, -850 + Math.sin(seconds * 0.27 + phase * 1.3) * 900, 0], playerPositions[index]!);
      writer.angle(seconds * 40 + index * 36); writer.angle(Math.sin(seconds * 0.6 + phase) * 25);
      writer.u8(100); writer.u8(100); writer.u8(1); writer.u16(intern(index % 5 === 0 ? 'awp' : 'ak47')); writer.u16(0xffff);
    });
    const round = source.rounds.find((round) => tick >= round.start_tick && tick <= round.end_tick);
    const throwTick = round === undefined ? Infinity : round.start_tick + Math.round(source.tick_rate * 5);
    const detonateTick = throwTick + Math.round(source.tick_rate * 2);
    const expires = Math.min(round?.end_tick ?? 0, detonateTick + Math.round(source.tick_rate * 18));
    const visible = round !== undefined && tick >= throwTick && tick <= expires && source.players.length > 0;
    writer.u16(visible ? 1 : 0);
    if (visible) {
      const flying = tick < detonateTick;
      const id = intern(`mock-${flying ? 'flight' : 'smoke'}:${round.number}`);
      const previous = projectilePositions.get(id) ?? [0, 0, 0]; projectilePositions.set(id, previous);
      writer.u16(id); writer.u16(intern('smoke')); writer.u16(intern(source.players[0]!.steam_id)); writer.u8(flying ? 1 : 7);
      const fraction = (tick - throwTick) / (detonateTick - throwTick);
      writer.position(flying ? [-700 + 300 * fraction, -850 + 250 * fraction, 32 + Math.sin(fraction * Math.PI) * 180] : [-400, -600, 0], previous);
      writer.f32(flying ? Number.NaN : 144); writer.u32(flying ? throwTick : detonateTick); writer.u32(flying ? detonateTick - 1 : expires);
    }
    writer.u8(0);
  }
  const payload = writer.finish();
  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({ start(controller) { controller.enqueue(payload); controller.close(); } });
  const compressed = new Uint8Array(await new Response(stream.pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const output = new Uint8Array(16 + compressed.length);
  output.set(encoder.encode('ARPL')); const header = new DataView(output.buffer);
  header.setUint16(4, 2, true); header.setUint16(6, 1, true); header.setUint32(8, payload.length, true); header.setUint32(12, crc32(payload), true);
  output.set(compressed, 16); return output.buffer;
}

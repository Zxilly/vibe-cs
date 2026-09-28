/**
 * A synthetic `ARPL` replay for browser mode.
 *
 * `desktop_binary` used to answer an empty buffer, so every 2D replay in
 * `pnpm dev` failed with 「二进制回放在字段边界前结束」 and nothing that plays a
 * tick range — the 回放 view, a highlight preview — could be looked at. This
 * writes the exact byte layout `data/replayBinary.ts` decodes: ten players on
 * smooth loops around de_mirage's playable area, dense (8 ticks) in rounds that
 * hold a highlight and sparse (64 ticks) elsewhere. It is a shape, not a match.
 */

interface ReplaySource {
  readonly tick_rate: number;
  readonly rounds: readonly { readonly number: number; readonly start_tick: number; readonly end_tick: number }[];
  readonly players: readonly { readonly steam_id: string; readonly name: string; readonly team: string }[];
  readonly highlights: readonly { readonly round: number }[];
}

const encoder = new TextEncoder();

class Writer {
  private readonly chunks: Uint8Array[] = [];
  private length = 0;

  bytes(value: Uint8Array): void {
    this.chunks.push(value);
    this.length += value.byteLength;
  }
  private number(size: number, write: (view: DataView) => void): void {
    const buffer = new Uint8Array(size);
    write(new DataView(buffer.buffer));
    this.bytes(buffer);
  }
  u8(value: number): void { this.number(1, (view) => view.setUint8(0, value)); }
  u16(value: number): void { this.number(2, (view) => view.setUint16(0, value, true)); }
  u32(value: number): void { this.number(4, (view) => view.setUint32(0, value, true)); }
  u64(value: number): void { this.number(8, (view) => view.setBigUint64(0, BigInt(value), true)); }
  f64(value: number): void { this.number(8, (view) => view.setFloat64(0, value, true)); }
  text(value: string): void {
    const encoded = encoder.encode(value);
    this.u16(encoded.byteLength);
    this.bytes(encoded);
  }
  json(value: unknown): void {
    const encoded = encoder.encode(JSON.stringify(value));
    this.u32(encoded.byteLength);
    this.bytes(encoded);
  }
  finish(): ArrayBuffer {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out.buffer;
  }
}

export function mockReplayBinary(source: ReplaySource): ArrayBuffer {
  const highlightRounds = new Set(source.highlights.map((highlight) => highlight.round));
  const ticks = source.rounds.flatMap((round) => {
    const step = highlightRounds.has(round.number) ? 8 : 64;
    const out: number[] = [];
    for (let tick = round.start_tick; tick < round.end_tick; tick += step) out.push(tick);
    out.push(round.end_tick);
    return out;
  });
  const writer = new Writer();
  writer.bytes(encoder.encode('ARPL'));
  writer.json({ state: 'generated', key: null, bytes: 0, generated_at: null, repaired: false, reason: null });
  writer.json({
    mode: 'entity_snapshots',
    tick_rate: source.tick_rate,
    frame_count: ticks.length,
    positioned_event_count: 0,
    start_tick: ticks[0] ?? 0,
    end_tick: ticks.at(-1) ?? 0,
  });
  writer.u32(ticks.length);
  for (const tick of ticks) {
    writer.u64(tick);
    writer.u16(source.players.length);
    source.players.forEach((player, index) => {
      const seconds = tick / source.tick_rate;
      const phase = index * 0.9;
      const side = player.team === 'A' ? -1 : 1;
      // Loops around de_mirage's centre, each team biased to its own half.
      const x = -670 + side * 700 + Math.cos(seconds * 0.35 + phase) * 650;
      const y = -850 + Math.sin(seconds * 0.27 + phase * 1.3) * 900;
      writer.text(player.steam_id);
      writer.text(player.name);
      writer.text(player.team === 'A' ? 'A' : 'B');
      writer.f64(x);
      writer.f64(y);
      writer.f64(0);
      writer.f64(((seconds * 40 + index * 36) % 360) - 180);
      writer.u32(100);
      writer.u32(100);
      writer.u8(1);
      writer.text(index % 5 === 0 ? 'awp' : 'ak47');
      writer.u16(0xffff);
    });
    writer.u16(0);
    writer.u8(0);
  }
  return writer.finish();
}

import { describe, expect, it } from 'vitest';

import { decodeReplayBinary } from '../data/replayBinary';
import { mockReplayBinary } from './mockReplay';

describe('browser replay fixture', () => {
  it('uses the production v2 reader, base 16-tick and highlight 8-tick samples', async () => {
    const replay = await decodeReplayBinary(await mockReplayBinary({
      tick_rate: 64,
      rounds: [{ number: 1, start_tick: 0, end_tick: 1024 }],
      players: Array.from({ length: 10 }, (_, index) => ({ steam_id: `7656119800000000${index}`, name: `Player ${index}`, team: index < 5 ? 'A' : 'B' })),
      highlights: [{ start_tick: 256, end_tick: 512 }],
    }));
    expect(replay.frames).toHaveLength(81);
    expect(replay.frames.slice(0, 3).map((frame) => frame.tick)).toEqual([0, 16, 32]);
    expect(replay.frames.filter((frame) => frame.tick >= 256 && frame.tick <= 280).map((frame) => frame.tick)).toEqual([256, 264, 272, 280]);
    expect(replay.frames.every((frame) => frame.players.length === 10 && frame.players.every((player) => Number.isFinite(player.pitch)))).toBe(true);
    expect(replay.frames.some((frame) => frame.projectiles.some((projectile) => projectile.phase === 'flying'))).toBe(true);
    expect(replay.frames.some((frame) => frame.projectiles.some((projectile) => projectile.phase === 'effect'))).toBe(true);
  });
});

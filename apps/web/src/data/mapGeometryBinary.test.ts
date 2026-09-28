import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { decodeMapGeometry } from './mapGeometryBinary';

const fixture = (): ArrayBuffer => Uint8Array.from(readFileSync(new URL('../dev/fixtures/scene3d.vmap', import.meta.url))).buffer;

describe('VMAP binary geometry', () => {
  it('decodes the fixture produced by the Rust VPK extraction and encoder', async () => {
    const geometry = await decodeMapGeometry(fixture());
    expect(geometry.positions.length / 3).toBe(28);
    expect(geometry.indices.length / 3).toBe(38);
    expect(Array.from(geometry.positions.slice(0, 3))).toEqual([-2048, -2048, 0]);
    expect(Array.from(geometry.indices.slice(0, 6))).toEqual([0, 1, 2, 0, 2, 3]);
    expect(geometry.includedShapes).toBe(1);
    expect(geometry.excludedShapes).toBe(0);
    expect(Math.max(...geometry.indices)).toBeLessThan(28);
  });

  it('rejects every truncated prefix, including missing zlib trailers', async () => {
    const bytes = fixture();
    for (let length = 0; length < bytes.byteLength; length += 1) {
      await expect(decodeMapGeometry(bytes.slice(0, length))).rejects.toThrow();
    }
  });

  it('rejects unsupported versions, allocation bombs, corrupt CRCs and trailing bytes', async () => {
    for (const offset of [4, 8, 12, 24, 28]) {
      const bytes = fixture();
      new DataView(bytes).setUint32(offset, 0xffffffff, true);
      await expect(decodeMapGeometry(bytes)).rejects.toThrow();
    }
    const extra = new Uint8Array(fixture().byteLength + 1);
    extra.set(new Uint8Array(fixture()));
    await expect(decodeMapGeometry(extra.buffer)).rejects.toThrow();
  });

  it.runIf(process.env.VIBE_GEOMETRY_FIXTURE !== undefined)('decodes a real locally exported map', async () => {
    const bytes = Uint8Array.from(readFileSync(process.env.VIBE_GEOMETRY_FIXTURE!));
    const geometry = await decodeMapGeometry(bytes.buffer);
    expect(geometry.positions.length / 3).toBeGreaterThan(10_000);
    expect(geometry.indices.length / 3).toBeGreaterThan(10_000);
    expect(geometry.positions.every(Number.isFinite)).toBe(true);
    expect(geometry.indices.every((index) => index < geometry.positions.length / 3)).toBe(true);
  });
});

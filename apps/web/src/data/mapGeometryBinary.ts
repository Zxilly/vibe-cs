import { t } from '@lingui/core/macro';
import { inflateVerified } from './compressedBinary';

/** Source coordinates (Z up), ready for one indexed scene mesh. */
export interface MapGeometry {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly includedShapes: number;
  readonly excludedShapes: number;
}

const maximumBytes = 128 * 1024 * 1024;
const headerBytes = 32;
export const MAP_GEOMETRY_QUANTIZATION = 16;
function invalid(): never {
  throw new Error(t`地图几何文件无效，请重新生成。`);
}

/** The VMAP v1 contract is shared with source-assets/geometry_binary.rs. */
export async function decodeMapGeometry(buffer: ArrayBuffer): Promise<MapGeometry> {
  if (buffer.byteLength < headerBytes || buffer.byteLength > maximumBytes) invalid();
  const header = new DataView(buffer);
  if (header.getUint32(0, true) !== 0x50414d56 || header.getUint16(4, true) !== 1 || header.getUint16(6, true) !== MAP_GEOMETRY_QUANTIZATION) invalid();
  const vertices = header.getUint32(8, true);
  const triangles = header.getUint32(12, true);
  const length = header.getUint32(24, true);
  if (vertices === 0 || vertices > 2_000_000 || triangles === 0 || triangles > 4_000_000
    || length > maximumBytes || length < (vertices + triangles) * 3) invalid();
  const payload = await inflateVerified(new Uint8Array(buffer, headerBytes), length, header.getUint32(28, true));
  let offset = 0;
  const delta = (): number => {
    let encoded = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      const byte = payload[offset++];
      if (byte === undefined || (shift === 28 && byte > 15)) invalid();
      encoded += (byte & 127) * 2 ** shift;
      if ((byte & 128) === 0) {
        if (shift !== 0 && byte === 0) invalid();
        return Math.floor(encoded / 2) ^ -(encoded & 1);
      }
    }
    return invalid();
  };
  const positions = new Float32Array(vertices * 3);
  const previous = [0, 0, 0];
  for (let index = 0; index < positions.length; index += 1) {
    const axis = index % 3;
    const value = previous[axis]! + delta();
    if (value < -16_000_000 || value > 16_000_000) invalid();
    previous[axis] = value;
    positions[index] = value / MAP_GEOMETRY_QUANTIZATION;
  }
  const indices = new Uint32Array(triangles * 3);
  let previousIndex = 0;
  for (let index = 0; index < indices.length; index += 1) {
    previousIndex += delta();
    if (previousIndex < 0 || previousIndex >= vertices) invalid();
    indices[index] = previousIndex;
  }
  if (offset !== payload.length) invalid();
  return { positions, indices, includedShapes: header.getUint32(16, true), excludedShapes: header.getUint32(20, true) };
}

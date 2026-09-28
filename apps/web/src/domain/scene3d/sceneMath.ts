import type { CameraSample } from '../../shared/desktop/dto';
import { MAP_GEOMETRY_QUANTIZATION } from '../../data/mapGeometryBinary';

export type Point3 = readonly [number, number, number];

/** A proper rotation: Source +X forward/+Y left/+Z up -> Three Y-up. */
export function sourcePoint(point: Point3): [number, number, number] {
  return [point[0], point[2], -point[1]];
}

export function playerDirection(yaw: number, pitch: number): [number, number, number] {
  const horizontal = yaw * Math.PI / 180;
  const vertical = pitch * Math.PI / 180;
  return sourcePoint([Math.cos(vertical) * Math.cos(horizontal), Math.cos(vertical) * Math.sin(horizontal), -Math.sin(vertical)]);
}

/** HLAE/Source FOV is horizontal at 4:3; Three expects a vertical angle. */
export function verticalFov(sourceFov: number): number {
  return 2 * Math.atan(Math.tan(sourceFov * Math.PI / 360) * 3 / 4) * 180 / Math.PI;
}

/** Never bisect a horizontal VMAP surface at exactly its quantized height. */
export function cutawayHeight(footHeight: number, headHeight: number): number {
  return (Math.floor((footHeight + headHeight + 8) * MAP_GEOMETRY_QUANTIZATION) - 0.5) / MAP_GEOMETRY_QUANTIZATION;
}

/** Converts a supplied Rust pose. No campath interpolation occurs in the browser. */
export function cameraView(sample: CameraSample) {
  const [x, y, z, w] = sample.quaternion;
  const forward = sourcePoint([1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)]);
  const up = sourcePoint([2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)]);
  const position = sourcePoint([sample.position.x, sample.position.y, sample.position.z]);
  return { position, forward, up, fov: verticalFov(sample.fov) };
}

/** The nearest authoritative sampled pose, clamped at the shot endpoints. */
export function cameraSampleAtTick(samples: readonly CameraSample[], tick: number): CameraSample | null {
  if (samples.length === 0) return null;
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (samples[middle]!.tick < tick) low = middle + 1;
    else high = middle;
  }
  const right = samples[Math.min(low, samples.length - 1)]!;
  const left = samples[Math.max(0, low - 1)]!;
  return tick - left.tick <= right.tick - tick ? left : right;
}

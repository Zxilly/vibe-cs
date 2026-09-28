import { describe, expect, it } from 'vitest';

import type { CameraSample } from '../../shared/desktop/dto';
import { cameraSampleAtTick, cameraView, cameraViewport, cutawayHeight, playerDirection, sourcePoint, verticalFov } from './sceneMath';

const pose: CameraSample = { tick: 100, timeSeconds: 0, position: { x: 10, y: 20, z: 30 }, quaternion: [0, 0, 0, 1], fov: 90 };

describe('Source camera to Three coordinates', () => {
  it('keeps the recording composition in wide and tall monitor panels', () => {
    expect(cameraViewport(800, 600, 16 / 9)).toEqual({ x: 0, y: 75, width: 800, height: 450 });
    expect(cameraViewport(1200, 600, 4 / 3)).toEqual({ x: 200, y: 0, width: 800, height: 600 });
    expect(cameraViewport(800, 600, null)).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    // A vertical recording retains the same source vertical FOV too.
    const portrait = cameraViewport(800, 600, 9 / 16);
    expect(portrait.width / portrait.height).toBeCloseTo(9 / 16);
    expect(portrait.x).toBe(231.25);
  });
  it('places presentation cutaways between grid levels to avoid coplanar clipping noise', () => {
    expect(cutawayHeight(-168, 64)).toBe(-96.03125);
    expect(cutawayHeight(0, 64)).toBe(71.96875);
    expect(cutawayHeight(0, 48)).toBe(55.96875);
    expect((cutawayHeight(42.013, 64) * 16) % 1).toBe(0.5);
  });
  it('preserves handedness, height and the native forward axis', () => {
    expect(sourcePoint([10, 20, 30])).toEqual([10, 30, -20]);
    const view = cameraView(pose);
    expect(view.position).toEqual([10, 30, -20]);
    expect(view.forward).toEqual([1, 0, -0]);
    expect(view.up).toEqual([0, 1, -0]);
    expect(verticalFov(90)).toBeCloseTo(73.739795, 5);
  });

  it('respects yaw, pitch and roll instead of applying Euler angles in Three order', () => {
    const s = Math.SQRT1_2;
    const yaw = cameraView({ ...pose, quaternion: [0, 0, s, s] });
    expect(yaw.forward[0]).toBeCloseTo(0);
    expect(yaw.forward[2]).toBeCloseTo(-1);
    const roll = cameraView({ ...pose, quaternion: [s, 0, 0, s] });
    expect(roll.forward[0]).toBeCloseTo(1);
    expect(roll.up[1]).toBeCloseTo(0);
    expect(roll.up[2]).toBeCloseTo(1);
    expect(playerDirection(0, 90)[1]).toBeCloseTo(-1);
    expect(playerDirection(90, 0)[2]).toBeCloseTo(-1);
  });

  it('selects an existing Rust pose and never creates a second spline', () => {
    const second = { ...pose, tick: 102, timeSeconds: 1 / 30 };
    expect(cameraSampleAtTick([], 100)).toBeNull();
    expect(cameraSampleAtTick([pose, second], 90)).toBe(pose);
    expect(cameraSampleAtTick([pose, second], 101.2)).toBe(second);
    expect(cameraSampleAtTick([pose, second], 120)).toBe(second);
  });
});

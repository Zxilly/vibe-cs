/*
 * `unit` project — reading `HlaeProposalPreview.typed_plan`.
 *
 * The whole point of this module is that it does **not** cast. So the tests
 * that matter are the ones where the document is nearly right: a missing `z`, a
 * renamed field, a keyframe that is not an object. Every one of them must
 * answer `null`, because the alternative is an SVG attribute reading `NaN` and
 * a camera path drawn through the middle of the map.
 *
 * The happy-path document below is the **camelCase** shape the backend actually
 * sends (`HlaePlan` carries `#[serde(rename_all = "camelCase")]`), which is the
 * detail four phases went past.
 */

import { describe, expect, it } from 'vitest';

import type { HlaeProposalPreview } from '../../shared/desktop/dto';
import {
  cameraHeightProfile,
  cameraHeightRange,
  cameraPlanDurationSeconds,
  cameraPlanKeyframes,
  cameraPlanTickRange,
  cameraSampleAtSeconds,
  cameraShotIsDrawable,
  normaliseBearing,
  readHlaeCameraPlan,
  worldPointAlong,
  type CameraPlan,
} from './cameraPlan';

/* ── fixtures ────────────────────────────────────────────────────────────── */

function keyframe(tick: number, x: number, y: number, z: number, yaw = 0, fov = 90) {
  return { tick, position: { x, y, z }, rotation: { pitch: 0, yaw, roll: 0 }, fov };
}

/** What `build_hlae_preview` serialises, field for field. */
function typedPlan(): unknown {
  return {
    mode: 'preview',
    tickRate: 64,
    demoPath: 'D:\\CS2\\demos\\aurora.dem',
    outputDirectory: 'D:\\CS2\\out',
    preRollTicks: 96,
    capture: { fps: 60, width: 1920, height: 1080, recordWav: true, layers: {} },
    presentation: {},
    shots: [
      {
        id: 'shot-a',
        startTick: 128,
        endTick: 384,
        positionInterpolation: 'cubic',
        rotationInterpolation: 'sphericalCubic',
        keyframes: [
          keyframe(128, 0, 0, 64, 0),
          keyframe(192, 100, 0, 128, 90),
          keyframe(256, 200, 100, 192, 180),
          keyframe(384, 300, 200, 64, 270),
        ],
      },
    ],
  };
}

function preview(overrides: Partial<HlaeProposalPreview> = {}): HlaeProposalPreview {
  return {
    proposal_revision: 1,
    ready: true,
    prerequisites: [],
    base_fingerprint: 'base',
    proposal_fingerprint: 'proposal',
    confirmation_token: 'token',
    typed_plan: typedPlan(),
    compiled_preview: null,
    notices: [],
    installation_status: null,
    ...overrides,
  };
}

function plan(): CameraPlan {
  const parsed = readHlaeCameraPlan(preview());
  if (parsed === null) throw new Error('the fixture must parse');
  return parsed;
}

/* ── the parser ──────────────────────────────────────────────────────────── */

describe('readHlaeCameraPlan', () => {
  it('reads the camelCase document the backend actually sends', () => {
    const parsed = readHlaeCameraPlan(preview());
    expect(parsed?.mode).toBe('preview');
    expect(parsed?.tickRate).toBe(64);
    expect(parsed?.shots).toHaveLength(1);
    expect(parsed?.shots[0]?.startTick).toBe(128);
    expect(parsed?.shots[0]?.endTick).toBe(384);
    expect(parsed?.shots[0]?.positionInterpolation).toBe('cubic');
    expect(parsed?.shots[0]?.rotationInterpolation).toBe('sphericalCubic');
    expect(parsed?.shots[0]?.keyframes).toHaveLength(4);
  });

  it('keeps z — the axis a radar projection would silently drop', () => {
    expect(readHlaeCameraPlan(preview())?.shots[0]?.keyframes[0]?.position.z).toBe(64);
  });

  it('reads a snake_case document too, so one renaming does not blank the preview', () => {
    const snake = {
      mode: 'preview',
      tick_rate: 128,
      shots: [
        {
          id: 'shot-a',
          start_tick: 10,
          end_tick: 20,
          position_interpolation: 'linear',
          rotation_interpolation: 'sphericalLinear',
          keyframes: [keyframe(10, 0, 0, 0), keyframe(20, 1, 1, 1)],
        },
      ],
    };
    const parsed = readHlaeCameraPlan(preview({ typed_plan: snake }));
    expect(parsed?.tickRate).toBe(128);
    expect(parsed?.shots[0]?.startTick).toBe(10);
    expect(parsed?.shots[0]?.positionInterpolation).toBe('linear');
  });

  it('answers null for a preview that carries no plan at all', () => {
    expect(readHlaeCameraPlan(preview({ typed_plan: null }))).toBeNull();
    expect(readHlaeCameraPlan(null)).toBeNull();
    expect(readHlaeCameraPlan(undefined)).toBeNull();
  });

  it.each([
    ['a keyframe missing z', { dropZ: true }],
    ['a keyframe missing its rotation', { dropRotation: true }],
    ['a keyframe that is not an object', { scalarKeyframe: true }],
    ['a shot with no id', { dropId: true }],
    ['a plan with no tick rate', { dropTickRate: true }],
    ['a tick rate of zero — every second would divide by it', { zeroTickRate: true }],
    ['shots that are not an array', { scalarShots: true }],
  ])('answers null rather than drawing: %s', (_label, mutation) => {
    const document = typedPlan() as Record<string, unknown>;
    const shots = document['shots'] as Record<string, unknown>[];
    const shot = shots[0] as Record<string, unknown>;
    const keyframes = shot['keyframes'] as Record<string, unknown>[];

    if ('dropZ' in mutation) {
      (keyframes[0] as { position: Record<string, unknown> }).position = { x: 0, y: 0 };
    }
    if ('dropRotation' in mutation) delete (keyframes[1] as Record<string, unknown>)['rotation'];
    if ('scalarKeyframe' in mutation) keyframes[2] = 'nope' as unknown as Record<string, unknown>;
    if ('dropId' in mutation) delete shot['id'];
    if ('dropTickRate' in mutation) delete document['tickRate'];
    if ('zeroTickRate' in mutation) document['tickRate'] = 0;
    if ('scalarShots' in mutation) document['shots'] = 4;

    expect(readHlaeCameraPlan(preview({ typed_plan: document }))).toBeNull();
  });

  it('does not throw on a hostile document', () => {
    expect(() => readHlaeCameraPlan(preview({ typed_plan: [] }))).not.toThrow();
    expect(() => readHlaeCameraPlan(preview({ typed_plan: 'plan' }))).not.toThrow();
  });
});

/* ── reading a parsed plan ───────────────────────────────────────────────── */

describe('cameraPlanTickRange / duration', () => {
  it('spans the first and last keyframe, not the shot’s declared window', () => {
    expect(cameraPlanTickRange(plan())).toEqual({ start: 128, end: 384 });
  });

  it('turns ticks into seconds with the plan’s own rate, never an assumed 64', () => {
    const at128 = readHlaeCameraPlan(
      preview({
        typed_plan: {
          mode: 'preview',
          tickRate: 128,
          shots: [
            {
              id: 's',
              startTick: 0,
              endTick: 256,
              keyframes: [keyframe(0, 0, 0, 0), keyframe(256, 1, 1, 1)],
            },
          ],
        },
      }),
    );
    expect(cameraPlanDurationSeconds(plan())).toBeCloseTo(4, 5);
    expect(at128 === null ? null : cameraPlanDurationSeconds(at128)).toBeCloseTo(2, 5);
  });

  it('counts every keyframe of every shot', () => {
    expect(cameraPlanKeyframes(plan())).toHaveLength(4);
  });

  it('calls a one-keyframe shot undrawable — a path needs two points', () => {
    expect(cameraShotIsDrawable({ ...plan().shots[0]!, keyframes: [] })).toBe(false);
    expect(cameraShotIsDrawable(plan().shots[0]!)).toBe(true);
  });
});

describe('cameraSampleAtSeconds', () => {
  it('sits on the first keyframe at zero and on the last at the end', () => {
    expect(cameraSampleAtSeconds(plan(), 0)?.tick).toBe(128);
    expect(cameraSampleAtSeconds(plan(), 99)?.tick).toBe(384);
  });

  it('reads a straight line between two keyframes, including z', () => {
    /* One second in at 64 tick/s is tick 192, which is a keyframe. Half a
       second is tick 160 — halfway between (0,0,64) and (100,0,128). */
    const at = cameraSampleAtSeconds(plan(), 0.5);
    expect(at?.position.x).toBeCloseTo(50, 5);
    expect(at?.position.z).toBeCloseTo(96, 5);
  });

  it('turns the short way round a wrap — 350° to 10° is 20°, not 340°', () => {
    const wrapped = readHlaeCameraPlan(
      preview({
        typed_plan: {
          mode: 'preview',
          tickRate: 64,
          shots: [
            {
              id: 's',
              startTick: 0,
              endTick: 64,
              keyframes: [keyframe(0, 0, 0, 0, 350), keyframe(64, 0, 0, 0, 10)],
            },
          ],
        },
      }),
    );
    const at = wrapped === null ? null : cameraSampleAtSeconds(wrapped, 0.5);
    expect(at?.rotation.yaw).toBeCloseTo(0, 5);
  });

  it('answers null when there is nothing to place a marker on', () => {
    expect(cameraSampleAtSeconds({ mode: 'preview', tickRate: 64, shots: [] }, 0)).toBeNull();
  });
});

describe('the height axis', () => {
  it('reports the range the radar cannot show', () => {
    const profile = cameraHeightProfile(plan());
    expect(profile?.minZ).toBe(64);
    expect(profile?.maxZ).toBe(192);
    expect(profile === null ? null : cameraHeightRange(profile)).toBe(128);
  });

  it('places every sample on a seconds axis from the path’s own start', () => {
    const profile = cameraHeightProfile(plan());
    expect(profile?.samples.map((sample) => sample.seconds)).toEqual([0, 1, 2, 4]);
    expect(profile?.durationSeconds).toBe(4);
  });

  it('refuses a one-point profile — a dot with an axis around it reads as data', () => {
    const single = readHlaeCameraPlan(
      preview({
        typed_plan: {
          mode: 'preview',
          tickRate: 64,
          shots: [{ id: 's', startTick: 0, endTick: 0, keyframes: [keyframe(0, 0, 0, 0)] }],
        },
      }),
    );
    expect(single === null ? 'unparsed' : cameraHeightProfile(single)).toBeNull();
  });
});

describe('bearings', () => {
  it('folds every angle into [0, 360)', () => {
    expect(normaliseBearing(-90)).toBe(270);
    expect(normaliseBearing(450)).toBe(90);
    expect(normaliseBearing(Number.NaN)).toBe(0);
  });

  it('walks east at 0° and north at 90° — the game’s yaw, in world space', () => {
    const east = worldPointAlong({ x: 0, y: 0 }, 0, 100);
    const north = worldPointAlong({ x: 0, y: 0 }, 90, 100);
    expect(east.x).toBeCloseTo(100, 5);
    expect(east.y).toBeCloseTo(0, 5);
    expect(north.x).toBeCloseTo(0, 5);
    expect(north.y).toBeCloseTo(100, 5);
  });
});

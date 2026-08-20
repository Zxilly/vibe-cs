/*
 * pages/recording — reading the camera path out of an HLAE proposal preview.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  The per-frame camera coordinates are on the wire. `typed_plan` is a lie of
 *  omission, not an absence.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `POST /api/agent/proposals/hlae/preview` (`client.previewHlaeProposal`)
 * answers a `HlaeProposalPreview` whose `typed_plan` is **a whole `HlaePlan`**:
 * `crates/runtime/src/proposal_execution.rs`'s `build_hlae_preview` serialises
 * the typed value it just validated and puts it in the response verbatim
 * (「the exact transport shown to a user identical to the typed value we
 * validate and later export」). Inside it is `shots: CameraShot[]`, each with a
 * tick window, two interpolation modes and a list of `CameraKeyframe`s carrying
 * `position {x,y,z}`, `rotation {pitch,yaw,roll}` and `fov`
 * (`crates/hlae/src/model.rs`). The keyframes themselves are sampled from
 * replay evidence by `sample_four_frames`, which is also why a segment with
 * fewer than four usable frames comes back as a prerequisite instead of a path.
 *
 * `apps/web/src/shared/desktop/dto.ts` types the field as `unknown | null`,
 * which is why four phases went past believing the path 「只有录制时才编译」.
 * **This module is a stopgap, not the fix.** The fix is to give `typed_plan` a
 * real type in `dto.ts` beside the rest of the HLAE group; that file is
 * read-only this round, so the shape is spelled here and the move is reported
 * as a gap.
 *
 * ── Why a parser and not a cast ───────────────────────────────────────────
 *
 * `preview.typed_plan as HlaePlan` would compile and would be wrong the first
 * time the backend renames a field: a cast asserts, it does not check, and the
 * failure would land as `undefined.x` inside an SVG attribute. So every field is
 * read and checked, and a shape that does not match answers `null` — which the
 * preview block renders as 「读不到这次预览的相机路径」 rather than as an invented
 * line. Nothing here throws: a malformed preview is a state, not a crash.
 *
 * ── camelCase, and how that is known ──────────────────────────────────────
 *
 * `HlaePlan` and every type under it carry `#[serde(rename_all = "camelCase")]`,
 * so the JSON says `startTick` / `positionInterpolation`, unlike the snake_case
 * REST DTOs around it. Both spellings are accepted below anyway — reading the
 * snake_case alias costs one `??` and removes a whole class of "worked in the
 * test, empty in the app" failure — but camelCase is what ships today and the
 * unit test pins it.
 *
 * Pure and React-free: it runs in the `unit` project.
 */

import type { HlaeProposalPreview } from '../../shared/desktop/dto';
import type { MapWorldBounds, WorldPoint } from '../../domain/map';

/* ── the shape ───────────────────────────────────────────────────────────── */

/** `crates/hlae/src/model.rs::CameraPosition`. Three-dimensional, unlike
 *  `domain/map`'s `WorldPoint` — see `cameraHeightProfile`. */
export interface CameraPlanPosition extends WorldPoint {
  readonly z: number;
}

/** `crates/hlae/src/model.rs::CameraRotation`, in degrees. */
export interface CameraPlanRotation {
  readonly pitch: number;
  readonly yaw: number;
  readonly roll: number;
}

export interface CameraPlanKeyframe {
  readonly tick: number;
  readonly position: CameraPlanPosition;
  readonly rotation: CameraPlanRotation;
  /** Horizontal field of view at this keyframe, degrees. */
  readonly fov: number;
}

export type CameraPositionInterpolation = 'linear' | 'cubic';
export type CameraRotationInterpolation = 'sphericalLinear' | 'sphericalCubic';

export interface CameraPlanShot {
  readonly id: string;
  readonly startTick: number;
  readonly endTick: number;
  readonly positionInterpolation: CameraPositionInterpolation;
  readonly rotationInterpolation: CameraRotationInterpolation;
  readonly keyframes: readonly CameraPlanKeyframe[];
}

export interface CameraPlan {
  readonly mode: 'preview' | 'capture';
  /** Parsed from the Demo, not assumed to be 64 — the backend is explicit
   *  about that and every second printed on this page depends on it. */
  readonly tickRate: number;
  readonly shots: readonly CameraPlanShot[];
}

/* ── the parser ──────────────────────────────────────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNumber(source: Record<string, unknown>, ...keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function readPosition(value: unknown): CameraPlanPosition | null {
  if (!isRecord(value)) return null;
  const x = readNumber(value, 'x');
  const y = readNumber(value, 'y');
  const z = readNumber(value, 'z');
  if (x === null || y === null || z === null) return null;
  return { x, y, z };
}

function readRotation(value: unknown): CameraPlanRotation | null {
  if (!isRecord(value)) return null;
  const pitch = readNumber(value, 'pitch');
  const yaw = readNumber(value, 'yaw');
  const roll = readNumber(value, 'roll');
  if (pitch === null || yaw === null || roll === null) return null;
  return { pitch, yaw, roll };
}

function readKeyframe(value: unknown): CameraPlanKeyframe | null {
  if (!isRecord(value)) return null;
  const tick = readNumber(value, 'tick');
  const fov = readNumber(value, 'fov');
  const position = readPosition(value['position']);
  const rotation = readRotation(value['rotation']);
  if (tick === null || fov === null || position === null || rotation === null) return null;
  return { tick, fov, position, rotation };
}

/**
 * The two interpolation enums, normalised.
 *
 * Unknown members are **not** rejected — a plan is still drawable when the
 * backend gains a third curve, and refusing the whole path over a label the
 * schematic does not use would be a worse answer than falling back. The
 * fallbacks are the two the compiler emits today.
 */
function readPositionInterpolation(value: unknown): CameraPositionInterpolation {
  return value === 'linear' ? 'linear' : 'cubic';
}

function readRotationInterpolation(value: unknown): CameraRotationInterpolation {
  return value === 'sphericalLinear' || value === 'spherical_linear'
    ? 'sphericalLinear'
    : 'sphericalCubic';
}

function readShot(value: unknown): CameraPlanShot | null {
  if (!isRecord(value)) return null;
  const id = value['id'];
  const startTick = readNumber(value, 'startTick', 'start_tick');
  const endTick = readNumber(value, 'endTick', 'end_tick');
  const rawKeyframes = value['keyframes'];
  if (typeof id !== 'string' || startTick === null || endTick === null) return null;
  if (!Array.isArray(rawKeyframes)) return null;

  const keyframes: CameraPlanKeyframe[] = [];
  for (const entry of rawKeyframes) {
    const keyframe = readKeyframe(entry);
    /* One unreadable keyframe means the shape is not the one this module was
       written against; drawing the rest would be a path with a hole in it that
       nothing on screen could distinguish from a real one. */
    if (keyframe === null) return null;
    keyframes.push(keyframe);
  }

  return {
    id,
    startTick,
    endTick,
    positionInterpolation: readPositionInterpolation(
      value['positionInterpolation'] ?? value['position_interpolation'],
    ),
    rotationInterpolation: readRotationInterpolation(
      value['rotationInterpolation'] ?? value['rotation_interpolation'],
    ),
    keyframes,
  };
}

/**
 * `HlaeProposalPreview.typed_plan` → a camera plan, or `null`.
 *
 * `null` covers all three ways there is nothing to draw and the caller tells
 * them apart from the preview itself rather than from this answer: the preview
 * was not `ready` (read `prerequisites`), the field was absent, or the document
 * is not the shape this module knows.
 */
export function readHlaeCameraPlan(
  preview: HlaeProposalPreview | null | undefined,
): CameraPlan | null {
  if (preview === null || preview === undefined) return null;
  const plan = preview.typed_plan;
  if (!isRecord(plan)) return null;

  const tickRate = readNumber(plan, 'tickRate', 'tick_rate');
  const rawShots = plan['shots'];
  if (tickRate === null || tickRate <= 0 || !Array.isArray(rawShots)) return null;

  const mode = plan['mode'] === 'capture' ? 'capture' : 'preview';
  const shots: CameraPlanShot[] = [];
  for (const entry of rawShots) {
    const shot = readShot(entry);
    if (shot === null) return null;
    shots.push(shot);
  }

  return { mode, tickRate, shots };
}

/* ── reading a plan for the schematic ────────────────────────────────────── */

/**
 * The number of keyframes HLAE needs before `mirv_campath draw enabled 1`
 * shows anything, and the number `sample_four_frames` produces. Below it the
 * in-game preview has nothing to draw either, so the page says so instead of
 * offering a door that opens on an empty path.
 */
export const MIN_DRAWABLE_KEYFRAMES = 4;

export function cameraShotIsDrawable(shot: CameraPlanShot): boolean {
  return shot.keyframes.length >= 2;
}

/** Every keyframe of every shot, in plan order. */
export function cameraPlanKeyframes(plan: CameraPlan): readonly CameraPlanKeyframe[] {
  return plan.shots.flatMap((shot) => shot.keyframes);
}

/** The local x/y region one selected camera plan actually touches. */
export function cameraPlanFocusBounds(
  plan: CameraPlan,
  contextMargin = 0,
): MapWorldBounds | null {
  const keyframes = cameraPlanKeyframes(plan);
  const first = keyframes[0];
  if (first === undefined) return null;
  const margin = Number.isFinite(contextMargin) ? Math.max(0, contextMargin) : 0;
  let minimumX = first.position.x;
  let maximumX = first.position.x;
  let minimumY = first.position.y;
  let maximumY = first.position.y;
  for (const keyframe of keyframes.slice(1)) {
    minimumX = Math.min(minimumX, keyframe.position.x);
    maximumX = Math.max(maximumX, keyframe.position.x);
    minimumY = Math.min(minimumY, keyframe.position.y);
    maximumY = Math.max(maximumY, keyframe.position.y);
  }
  return {
    minimum: { x: minimumX - margin, y: minimumY - margin },
    maximum: { x: maximumX + margin, y: maximumY + margin },
  };
}

/** First and last tick the plan covers, or `null` when it covers nothing. */
export function cameraPlanTickRange(plan: CameraPlan): { start: number; end: number } | null {
  const keyframes = cameraPlanKeyframes(plan);
  const first = keyframes[0];
  const last = keyframes[keyframes.length - 1];
  if (first === undefined || last === undefined) return null;
  let start = first.tick;
  let end = last.tick;
  for (const keyframe of keyframes) {
    if (keyframe.tick < start) start = keyframe.tick;
    if (keyframe.tick > end) end = keyframe.tick;
  }
  return { start, end };
}

/** How long the whole path runs, in seconds. `0` when it is a single instant. */
export function cameraPlanDurationSeconds(plan: CameraPlan): number {
  const range = cameraPlanTickRange(plan);
  if (range === null) return 0;
  return Math.max(0, (range.end - range.start) / plan.tickRate);
}

/**
 * Where the camera is at `seconds` into the path.
 *
 * **Linear between keyframes, and the caption says so.** The compiled path uses
 * `Cubic` / `SphericalCubic` (`positionInterpolation` above records which), and
 * re-implementing a Catmull-Rom read of HLAE's curve here would produce a
 * second, subtly different answer to the one the game will fly — the exact
 * failure 「导播预览为相机路径示意」 is warning about. A straight read between
 * two known-true samples is honest at this size; a wrong curve would not be.
 *
 * Returns `null` when there is nothing to place a marker on.
 */
export function cameraSampleAtSeconds(
  plan: CameraPlan,
  seconds: number,
): CameraPlanKeyframe | null {
  const range = cameraPlanTickRange(plan);
  if (range === null) return null;
  const keyframes = [...cameraPlanKeyframes(plan)].sort((a, b) => a.tick - b.tick);
  const first = keyframes[0];
  const last = keyframes[keyframes.length - 1];
  if (first === undefined || last === undefined) return null;

  const tick = range.start + (Number.isFinite(seconds) ? Math.max(0, seconds) : 0) * plan.tickRate;
  if (tick <= first.tick) return first;
  if (tick >= last.tick) return last;

  for (let index = 1; index < keyframes.length; index += 1) {
    const previous = keyframes[index - 1];
    const current = keyframes[index];
    if (previous === undefined || current === undefined) continue;
    if (tick > current.tick) continue;
    const span = current.tick - previous.tick;
    const ratio = span === 0 ? 0 : (tick - previous.tick) / span;
    return {
      tick,
      fov: mix(previous.fov, current.fov, ratio),
      position: {
        x: mix(previous.position.x, current.position.x, ratio),
        y: mix(previous.position.y, current.position.y, ratio),
        z: mix(previous.position.z, current.position.z, ratio),
      },
      rotation: {
        pitch: mix(previous.rotation.pitch, current.rotation.pitch, ratio),
        yaw: mixAngle(previous.rotation.yaw, current.rotation.yaw, ratio),
        roll: mix(previous.rotation.roll, current.rotation.roll, ratio),
      },
    };
  }
  return last;
}

function mix(from: number, to: number, ratio: number): number {
  return from + (to - from) * ratio;
}

/** Angles wrap; 350° → 10° is a 20° turn, not a 340° one. */
function mixAngle(from: number, to: number, ratio: number): number {
  const delta = ((((to - from) % 360) + 540) % 360) - 180;
  return normaliseBearing(from + delta * ratio);
}

/** Into `[0, 360)`. The game's yaw and `domain/map`'s `worldBearingDegrees`
 *  share this convention: 0° is east (+x) and the angle grows anticlockwise. */
export function normaliseBearing(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0;
  return ((degrees % 360) + 360) % 360;
}

/**
 * A world point `distance` units along `bearing` from `origin`.
 *
 * Used to build the heading arrow and the field-of-view wedge **in world space
 * and then project them**, rather than drawing them in canvas space from a
 * mirrored angle. Canvas y grows downward, so a canvas-space rotation of a
 * world bearing is the reflected angle — the class of bug that only shows up on
 * maps whose overview happens to be nearly symmetric.
 */
export function worldPointAlong(
  origin: WorldPoint,
  bearingDegrees: number,
  distance: number,
): WorldPoint {
  const radians = (normaliseBearing(bearingDegrees) * Math.PI) / 180;
  return {
    x: origin.x + Math.cos(radians) * distance,
    y: origin.y + Math.sin(radians) * distance,
  };
}

/* ── the height axis ─────────────────────────────────────────────────────── */

export interface CameraHeightSample {
  /** Seconds from the start of the path. */
  readonly seconds: number;
  /** World z, Hammer units. */
  readonly z: number;
  readonly tick: number;
}

export interface CameraHeightProfile {
  readonly samples: readonly CameraHeightSample[];
  readonly minZ: number;
  readonly maxZ: number;
  readonly durationSeconds: number;
}

/**
 * The side view of the path: time across, world z up.
 *
 * `domain/map`'s `WorldPoint` deliberately has no `z` — height in this product
 * is a *floor*, a two-way switch, because that is all a heat map needs. A
 * camera is not a floor: 「从高处降下来」 and 「贴地平移」 project onto the radar
 * as the same line, and the whole point of a director preview is that those two
 * shots are not the same shot. So the third dimension gets its own axis rather
 * than being folded into the plan view or dropped.
 *
 * `null` when the path has fewer than two samples — a one-point profile is a
 * dot, and a dot with an axis around it reads as data that is not there.
 */
export function cameraHeightProfile(plan: CameraPlan): CameraHeightProfile | null {
  const range = cameraPlanTickRange(plan);
  const keyframes = [...cameraPlanKeyframes(plan)].sort((a, b) => a.tick - b.tick);
  if (range === null || keyframes.length < 2) return null;

  const samples = keyframes.map((keyframe) => ({
    seconds: (keyframe.tick - range.start) / plan.tickRate,
    z: keyframe.position.z,
    tick: keyframe.tick,
  }));

  let minZ = samples[0]?.z ?? 0;
  let maxZ = minZ;
  for (const sample of samples) {
    if (sample.z < minZ) minZ = sample.z;
    if (sample.z > maxZ) maxZ = sample.z;
  }

  return {
    samples,
    minZ,
    maxZ,
    durationSeconds: Math.max(0, (range.end - range.start) / plan.tickRate),
  };
}

/**
 * How far the camera rises or falls over the whole path, in Hammer units.
 *
 * Printed beside the side view because a reader should not have to measure a
 * 60px strip to find out whether a shot descends at all.
 */
export function cameraHeightRange(profile: CameraHeightProfile): number {
  return profile.maxZ - profile.minZ;
}

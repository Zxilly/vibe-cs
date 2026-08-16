/*
 * pages/editor — the adapter between `EditorProject` and the timeline model
 * (spec §7 `/editor/:projectId?`, phase 3f-2).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  Why there is an adapter at all, rather than one shared type
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `EditorProject` is the wire document: nested tracks, uuids, transforms,
 * keyframes, effects, speed ramps, text styles. `Timeline` is what the editing
 * algorithms operate on: a flat clip list with `start`, `duration`,
 * `sourceIn`, `sourceDuration`, `speed`. Neither is a subset of the other, and
 * neither should become one.
 *
 * The flat list is what makes `razor`, `dragMove`, `rippleEdit` and `trim`
 * expressible as pure functions over a few hundred lines — a nested document
 * would put a "find the track this clip is on" walk in the middle of every one
 * of them. And the nested document is what the service stores; flattening it
 * on the server is not on offer.
 *
 * So: two types, one adapter, and **one hard rule** —
 *
 *   > Everything the timeline model does not describe survives a round trip
 *   > untouched.
 *
 * That is what `EditorDocument.clips` is for. It holds the original
 * `EditorClip` for every clip, and a save writes the timeline's five fields
 * back onto it rather than rebuilding it. A clip's colour grade, its
 * keyframes, its text style and its `metadata` therefore survive an edit that
 * knows nothing about them. Rebuilding instead would silently strip whatever
 * this file had not thought of — and `metadata` is deliberately open-ended, so
 * "whatever this file had not thought of" is a permanent category.
 *
 * ── the three joins ────────────────────────────────────────────────────────
 *
 * **Source length.** `EditorClip` carries `source_in` / `source_out` — this
 * clip's window — and *not* how long the media is. That lives on
 * `MediaAsset.duration_seconds`, a different request. The timeline needs both:
 * the window to draw, the full length to know how far a trim or a slip may
 * still travel. `toTimeline` joins them, and when the asset is unknown or has
 * no measured duration it falls back to the window itself. That is the honest
 * answer, and it has a visible consequence: a clip whose asset has not been
 * probed yet reports zero headroom, so trimming outwards is refused rather
 * than being allowed against a length nobody has measured.
 *
 * **Identity.** Wire ids are uuids; the razor mints `<uuid>~2`. A minted id is
 * not a uuid and the service would reject it, so `toEditorProject` swaps every
 * non-uuid id for a fresh one at the boundary — with the mint injected, so the
 * function stays testable and the model stays free of `crypto`.
 *
 * **Lane names.** `EditorTrack.name` is free text (`"Video"`, `"Separated
 * audio"`). The artboard's head column draws `V1 主画面` — a code and a role.
 * The code is derived from the kind and the lane's position within its kind,
 * counting from the bottom as the artboard does (V1 below V2); the role is the
 * stored name. Nothing is invented: a track called 「原声」 keeps that word.
 *
 * ── what cannot be edited, and why it says so ──────────────────────────────
 *
 * A clip with `speed_segments` — a speed ramp — has no representation in the
 * timeline model, which carries one constant `speed`. The document forbids a
 * ramp from coexisting with a base speed other than 1
 * (`validate_clip_automation`), so a ramped clip arrives with `speed: 1` and a
 * source window whose length is *not* `duration × 1`. Editing it through this
 * model would corrupt the ramp.
 *
 * Rather than hide the clip or silently flatten it, `clipRestrictions` names
 * what it cannot take, and the UI disables those actions with that reason.
 * 「不隐藏、不静默失败」 applies to a limitation as much as to a refusal.
 */

import {
  createTimeline,
  findOverlapping,
  timelineDuration,
  type Clip,
  type Marker,
  type Timeline,
  type Track,
  type TrackKind,
} from '../../design/timeline';
import { STATUS_COLORS } from '../../design/tokens.data';
import type {
  EditorClip,
  EditorKeyframe,
  EditorMarker,
  EditorProject,
  EditorTrack,
  MediaAsset,
} from '../../shared/desktop/dto';

/**
 * A project as the editor holds it: the timeline it edits, plus everything the
 * timeline does not describe, kept so a save can put it back.
 */
export interface EditorDocument {
  timeline: Timeline;
  /** The project with `tracks` emptied — its identity, canvas and revision. */
  project: EditorProject;
  /** Wire clips by id, including the ones the timeline is not editing. */
  clips: ReadonlyMap<string, EditorClip>;
  /** Wire tracks by id, `clips` emptied. */
  tracks: ReadonlyMap<string, EditorTrack>;
  /** Wire markers by id — the timeline's `Marker` has no colour. */
  markers: ReadonlyMap<string, EditorMarker>;
  /**
   * Clips whose source length is the fallback rather than a measurement.
   *
   * Recorded at load rather than inferred later, because it cannot be inferred
   * later: a clip with 3s of unused head has headroom either way, and whether
   * that headroom is real depends on where the number came from. A slip
   * against an unmeasured length is a guess that shows up as black frames.
   */
  unmeasuredClipIds: ReadonlySet<string>;
}

/* ── wire → model ────────────────────────────────────────────────────────── */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The head column's code: `V1` / `A2` / `T1` / `O1`, artboard order. */
const KIND_CODE: Record<TrackKind, string> = { video: 'V', overlay: 'O', audio: 'A', text: 'T' };

/**
 * `EditorTrack.order` decides the stack, lowest at the top — that is how the
 * artboard draws V2 above V1. The numbering therefore counts *up from the
 * bottom* within each kind, which is what a V1 below a V2 means.
 */
export function laneCodes(tracks: readonly EditorTrack[]): Map<string, string> {
  const ordered = [...tracks].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
  const counts = new Map<TrackKind, number>();
  const codes = new Map<string, string>();
  for (const track of [...ordered].reverse()) {
    const next = (counts.get(track.kind) ?? 0) + 1;
    counts.set(track.kind, next);
    codes.set(track.id, `${KIND_CODE[track.kind]}${next}`);
  }
  return codes;
}

/**
 * How much media a clip has behind it. `MediaAsset.duration_seconds` when it
 * is known; the clip's own window when it is not — see the module comment.
 */
function sourceDurationOf(
  clip: EditorClip,
  assets: ReadonlyMap<string, MediaAsset>,
): { seconds: number; measured: boolean } {
  const measured = clip.asset_id === null ? null : (assets.get(clip.asset_id)?.duration_seconds ?? null);
  if (measured === null) return { seconds: clip.source_out, measured: false };
  return { seconds: Math.max(measured, clip.source_out), measured: true };
}

export interface ToTimelineOptions {
  /** Media assets by id, for the source lengths. Missing ones fall back. */
  assets?: ReadonlyMap<string, MediaAsset>;
  /** Where the playhead was, if the caller is preserving one. */
  playhead?: number;
}

export function toEditorDocument(project: EditorProject, options: ToTimelineOptions = {}): EditorDocument {
  const { assets = new Map<string, MediaAsset>(), playhead = 0 } = options;
  const ordered = [...project.tracks].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
  const codes = laneCodes(project.tracks);

  const tracks: Track[] = ordered.map((track) => ({
    id: track.id,
    kind: track.kind,
    name: codes.get(track.id) ?? track.name,
    role: track.name,
    ...(track.locked ? { locked: true } : {}),
  }));

  const clips: Clip[] = [];
  const clipShadows = new Map<string, EditorClip>();
  const unmeasured = new Set<string>();
  for (const track of ordered) {
    for (const clip of track.clips) {
      clipShadows.set(clip.id, clip);
      const source = sourceDurationOf(clip, assets);
      // A text clip has no media, so its window *is* its length and there is
      // nothing to measure. Only a clip that names an asset can be unmeasured.
      if (!source.measured && clip.asset_id !== null) unmeasured.add(clip.id);
      clips.push({
        id: clip.id,
        trackId: track.id,
        start: clip.start,
        duration: clip.duration,
        sourceIn: clip.source_in,
        sourceDuration: source.seconds,
        // A ramped clip's constant speed is 1 by the document's own rule; the
        // ramp itself lives in the shadow and `clipRestrictions` guards it.
        speed: clip.speed,
        label: clip.name,
        ...(clip.link_group_id === null ? {} : { linkId: clip.link_group_id }),
      });
    }
  }

  const markers: Marker[] = project.markers.map((marker) => ({
    id: marker.id,
    time: marker.time,
    label: marker.label,
  }));

  return {
    timeline: createTimeline({ tracks, clips, markers, playhead, fps: project.fps }),
    project: { ...project, tracks: [] },
    clips: clipShadows,
    tracks: new Map(ordered.map((track) => [track.id, { ...track, clips: [] }])),
    markers: new Map(project.markers.map((marker) => [marker.id, marker])),
    unmeasuredClipIds: unmeasured,
  };
}

/**
 * The colour a marker takes when it has none.
 *
 * `EditorMarker.color` is *data* — a `#rrggbb` string the service stores and
 * validates — not a style, so it cannot be a CSS variable. It is still taken
 * from the design tokens rather than typed as a literal: the artboard draws
 * its guide lines in amber, `--color-warn` is that amber, and a hex copied by
 * hand would drift the day the ramp is retuned. (It is also what keeps this
 * file inside §2.1 rule 4, which forbids a bare hex under `pages/**`.)
 */
export const DEFAULT_MARKER_COLOR = STATUS_COLORS['--color-warn'].light;

/* ── putting media on the timeline ───────────────────────────────────────── */

/** Mints a wire identity. Injected so the adapter stays a pure function. */
export type MintUuid = () => string;

/** The lane kind a media asset belongs on. */
function laneKindFor(asset: MediaAsset): TrackKind {
  return asset.kind === 'audio' ? 'audio' : 'video';
}

export interface InsertAssetOptions {
  /** Where the clip's left edge goes. Defaults to the playhead. */
  at?: number;
  /** Track to place it on. Defaults to the first lane of the right kind. */
  trackId?: string;
  /** How long a clip to make. Defaults to the whole asset. */
  durationSeconds?: number;
}

export interface InsertAssetResult {
  document: EditorDocument;
  /** The clip that was created, or null when nothing could be placed. */
  clipId: string | null;
  /** Why, when nothing was placed. */
  reason?: 'overlap' | 'no-duration' | 'track-locked';
}

/**
 * Puts a media asset on the timeline — the 素材库's 「添加到时间轴」.
 *
 * This is the only place a clip is created from nothing, and it is here rather
 * than in `design/timeline` because everything it needs to decide is a
 * *document* question: which lane kind the file belongs on
 * (`MediaAsset.kind`), how long it is (`duration_seconds`), what a fresh
 * `EditorClip` looks like (every field the wire requires, including the ones
 * with no editor control). The timeline model has no concept of an asset.
 *
 * Three refusals, all of them stated rather than worked around:
 *
 *   · **no duration.** An asset whose metadata has not been probed has no
 *     length, and a clip needs one. Guessing would put a clip of the wrong
 *     size on the timeline and only reveal it on export.
 *   · **overlap.** The playhead may be inside an existing clip. Placing on top
 *     of it would be `overwrite`, which is not this editor's policy anywhere
 *     else.
 *   · **locked.** A locked lane refuses, like every other edit.
 *
 * A project with no lane of the right kind gets one, because the alternative
 * is an editor that cannot accept the first clip of a new project.
 */
export function insertAssetClip(
  document: EditorDocument,
  asset: MediaAsset,
  mint: MintUuid,
  options: InsertAssetOptions = {},
): InsertAssetResult {
  const { timeline } = document;
  const length = options.durationSeconds ?? asset.duration_seconds;
  if (length === null || !(length > 0)) return { document, clipId: null, reason: 'no-duration' };

  const kind = laneKindFor(asset);
  const start = Math.max(0, options.at ?? timeline.playhead);
  const end = start + length;

  const candidates =
    options.trackId === undefined
      ? timeline.tracks.filter((track) => track.kind === kind && track.locked !== true)
      : timeline.tracks.filter((track) => track.id === options.trackId);
  if (options.trackId !== undefined && candidates[0]?.locked === true) {
    return { document, clipId: null, reason: 'track-locked' };
  }

  // The first lane of the right kind with room. A project usually has one
  // free; when every lane is busy at this instant the answer is a refusal,
  // not a new lane — stacking a third video track because the playhead
  // happened to be over a clip would be a surprising thing to do silently.
  const target = candidates.find(
    (track) => findOverlapping(timeline, track.id, start, end).length === 0,
  );

  const clipId = mint();
  const wire: EditorClip = {
    id: clipId,
    asset_id: asset.id,
    name: asset.name,
    start,
    duration: length,
    source_in: 0,
    source_out: length,
    speed: 1,
    volume: 1,
    transform: { x: 0, y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
    effects: [],
    transition_in: null,
    transition_out: null,
    text: null,
    metadata: {},
    group_id: null,
    link_group_id: null,
    keyframes: [],
    speed_segments: [],
  };

  if (target === undefined && candidates.length > 0) {
    return { document, clipId: null, reason: 'overlap' };
  }

  let trackId: string;
  let tracks = document.tracks;
  let modelTracks = timeline.tracks;
  if (target === undefined) {
    // No lane of this kind at all — the first clip of a new project.
    trackId = mint();
    const code = `${KIND_CODE[kind]}${modelTracks.filter((track) => track.kind === kind).length + 1}`;
    const wireTrack: EditorTrack = {
      id: trackId,
      name: asset.kind === 'audio' ? '音频' : '主画面',
      kind,
      order: modelTracks.length,
      muted: false,
      locked: false,
      hidden: false,
      clips: [],
    };
    tracks = new Map(document.tracks).set(trackId, wireTrack);
    modelTracks = [...modelTracks, { id: trackId, kind, name: code, role: wireTrack.name }];
  } else {
    trackId = target.id;
  }

  const next = createTimeline({
    tracks: modelTracks,
    clips: [
      ...timeline.clips,
      {
        id: clipId,
        trackId,
        start,
        duration: length,
        sourceIn: 0,
        sourceDuration: length,
        speed: 1,
        label: asset.name,
      },
    ],
    markers: timeline.markers,
    playhead: timeline.playhead,
    fps: timeline.fps,
  });

  return {
    document: {
      ...document,
      timeline: next,
      tracks,
      clips: new Map(document.clips).set(clipId, wire),
    },
    clipId,
  };
}

/**
 * The project a save would send.
 *
 * Everything outside the timeline's five fields is copied from the shadow, so
 * a colour grade or a keyframe the editor never touched arrives back exactly
 * as it left. A clip with no shadow — one the razor produced — inherits its
 * left half's, which is what a cut means: the two halves are the same clip
 * with different windows.
 */
export function toEditorProject(document: EditorDocument, mint: MintUuid): EditorProject {
  const { timeline, clips: shadows, tracks: trackShadows, markers: markerShadows } = document;

  // One pass to decide every renamed id, so a clip and the partner it is
  // linked to agree about the group they landed in.
  const clipIds = new Map<string, string>();
  const linkIds = new Map<string, string>();
  // A lane added in the editor has whatever id the caller made up; the document
  // wants a uuid. Mint here rather than at the call site so the clips that
  // reference it are repointed in the same pass — a clip left on the old id
  // would land on a track that does not exist and be dropped without a word.
  const trackIds = new Map<string, string>();
  for (const track of timeline.tracks) {
    if (!UUID.test(track.id)) trackIds.set(track.id, mint());
  }
  for (const clip of timeline.clips) {
    if (!UUID.test(clip.id)) clipIds.set(clip.id, mint());
    if (clip.linkId !== undefined && !UUID.test(clip.linkId) && !linkIds.has(clip.linkId)) {
      linkIds.set(clip.linkId, mint());
    }
  }

  const byTrack = new Map<string, EditorClip[]>();
  for (const clip of timeline.clips) {
    const shadow = shadows.get(clip.id) ?? shadows.get(baseId(clip.id));
    if (shadow === undefined) continue;
    const minted = clipIds.has(clip.id);
    const linkGroupId =
      clip.linkId === undefined ? null : (linkIds.get(clip.linkId) ?? clip.linkId);
    const wire: EditorClip = {
      ...shadow,
      id: clipIds.get(clip.id) ?? clip.id,
      name: clip.label,
      start: clip.start,
      duration: clip.duration,
      source_in: clip.sourceIn,
      source_out: clip.sourceIn + clip.duration * clip.speed,
      speed: clip.speed,
      link_group_id: linkGroupId,
      // A minted clip carries its origin's keyframe and segment ids, which the
      // document requires to be unique across the *whole project*. Dropping
      // them is the only answer that does not need a second mint per
      // keyframe, and it is the right one: a razor splits a clip in time, and
      // an automation curve written for the whole cannot be halved by copying
      // it to both sides.
      ...(minted
        ? { keyframes: [], speed_segments: [] }
        : { keyframes: keyframesInside(shadow, clip.duration) }),
    };
    const trackId = trackIds.get(clip.trackId) ?? clip.trackId;
    const lane = byTrack.get(trackId);
    if (lane === undefined) byTrack.set(trackId, [wire]);
    else lane.push(wire);
  }

  const tracks: EditorTrack[] = timeline.tracks.map((track, index) => {
    const shadow = trackShadows.get(track.id);
    const id = trackIds.get(track.id) ?? track.id;
    return {
      id,
      name: shadow?.name ?? track.role,
      kind: track.kind,
      order: index,
      muted: shadow?.muted ?? false,
      locked: track.locked ?? false,
      hidden: shadow?.hidden ?? false,
      clips: byTrack.get(id) ?? [],
    };
  });
  dissolveOrphanedGroups(tracks);

  const markers: EditorMarker[] = timeline.markers.map((marker) => {
    const shadow = markerShadows.get(marker.id);
    return {
      id: UUID.test(marker.id) ? marker.id : mint(),
      time: marker.time,
      label: marker.label,
      color: shadow?.color ?? DEFAULT_MARKER_COLOR,
    };
  });

  return {
    ...document.project,
    fps: timeline.fps,
    // `EditorProject::validate` requires every clip *and every marker* to end
    // inside `duration_seconds`, so a trim that lengthened the last clip has
    // to lengthen the project too, and a marker parked past the content keeps
    // the project long enough to hold it.
    duration_seconds: Math.max(
      timelineDuration(timeline),
      ...timeline.markers.map((marker) => marker.time),
      0,
    ),
    tracks,
    markers,
  };
}

/** `c1~2` → `c1`: the razor's minted id, back to the clip it was cut from. */
function baseId(id: string): string {
  return id.replace(/~\d+$/u, '');
}

/**
 * Keyframes that still fall inside the clip.
 *
 * A keyframe's `time` is clip-local, and the document requires it to be inside
 * `[0, duration]`. Trimming, cutting or speeding up a clip shortens it, and a
 * curve written for the longer version then describes time that no longer
 * exists — the service answers 400 and the user is told their project is
 * invalid, with nothing to act on.
 *
 * Dropping is chosen over clamping deliberately. Clamping would pile several
 * keyframes onto the new last frame, which the document *also* rejects
 * (duplicate property-and-time), and a curve that ends in a vertical cliff is
 * not what the user drew either. `droppedKeyframeCount` lets the page say what
 * a save will cost before it costs it.
 */
function keyframesInside(shadow: EditorClip, duration: number): EditorKeyframe[] {
  if (shadow.keyframes.length === 0) return shadow.keyframes;
  return shadow.keyframes.filter((keyframe: EditorKeyframe) => keyframe.time <= duration + 1e-6);
}

/**
 * Link and clip groups that no longer have the members the document requires,
 * dissolved in place.
 *
 * `EditorProject::validate` insists a link group hold at least two clips *on
 * different tracks*, and a clip group at least two clips. Deleting one half of
 * an A/V pair, or cutting a clip whose partner the blade missed, leaves a
 * group of one — and the save fails on a rule the user never saw. A group of
 * one means nothing, so dissolving it loses nothing.
 */
function dissolveOrphanedGroups(tracks: EditorTrack[]): void {
  const linkMembers = new Map<string, { count: number; tracks: Set<string> }>();
  const groupMembers = new Map<string, number>();
  for (const track of tracks) {
    for (const clip of track.clips) {
      if (clip.link_group_id !== null) {
        const entry = linkMembers.get(clip.link_group_id) ?? { count: 0, tracks: new Set<string>() };
        entry.count += 1;
        entry.tracks.add(track.id);
        linkMembers.set(clip.link_group_id, entry);
      }
      if (clip.group_id !== null) {
        groupMembers.set(clip.group_id, (groupMembers.get(clip.group_id) ?? 0) + 1);
      }
    }
  }

  for (const track of tracks) {
    track.clips = track.clips.map((clip: EditorClip) => {
      const link = clip.link_group_id === null ? undefined : linkMembers.get(clip.link_group_id);
      const group = clip.group_id === null ? undefined : groupMembers.get(clip.group_id);
      const keepLink = link !== undefined && link.count >= 2 && link.tracks.size >= 2;
      const keepGroup = group !== undefined && group >= 2;
      if (keepLink && keepGroup) return clip;
      return {
        ...clip,
        link_group_id: keepLink ? clip.link_group_id : null,
        group_id: keepGroup ? clip.group_id : null,
      };
    });
  }
}

/**
 * How many keyframes a save would drop, and on how many clips — what the page
 * has to say *before* the save, since the loss is not recoverable by undo once
 * the service has the new document.
 */
export function droppedKeyframeCount(document: EditorDocument): { keyframes: number; clips: number } {
  let keyframes = 0;
  let clips = 0;
  for (const clip of document.timeline.clips) {
    // Only clips that are still on the timeline under their own id. A clip the
    // user deleted took its keyframes with it and needs no warning; a razor's
    // right half never had any, so counting the ones it did not inherit would
    // report a loss twice for one cut.
    const shadow = document.clips.get(clip.id);
    if (shadow === undefined || shadow.keyframes.length === 0) continue;
    const lost = shadow.keyframes.length - keyframesInside(shadow, clip.duration).length;
    if (lost > 0) {
      keyframes += lost;
      clips += 1;
    }
  }
  return { keyframes, clips };
}

/* ── what a clip will not accept ─────────────────────────────────────────── */

export interface ClipRestriction {
  /** Machine-readable, so a caller can disable exactly the right control. */
  kind: 'speed-ramp' | 'unmeasured-source' | 'locked-track';
  /** Shown to the user. Written in `editorMessages.ts`, not here. */
  reason: 'speed-ramp' | 'unmeasured-source' | 'locked-track';
  /** The operations this rules out. */
  blocks: ReadonlyArray<'trim' | 'speed' | 'razor' | 'slip'>;
}

/**
 * Why an operation is unavailable on a clip, or an empty list.
 *
 * Called by the Inspector and by the timeline's toolbar to disable a control
 * *with its reason attached*, rather than letting the user try and receive a
 * refusal they cannot act on.
 */
export function clipRestrictions(document: EditorDocument, clipId: string): ClipRestriction[] {
  const clip = document.timeline.clips.find((each) => each.id === clipId);
  if (clip === undefined) return [];
  const shadow = document.clips.get(clipId);
  const restrictions: ClipRestriction[] = [];

  if ((shadow?.speed_segments.length ?? 0) > 0) {
    // The ramp's segments are expressed against this clip's duration; a trim
    // or a cut would leave them describing a clip that no longer exists.
    restrictions.push({
      kind: 'speed-ramp',
      reason: 'speed-ramp',
      blocks: ['trim', 'speed', 'razor', 'slip'],
    });
  }
  if (document.unmeasuredClipIds.has(clipId)) {
    // The source length fell back to the clip's own window, so whatever
    // headroom the model reports is the window's, not the media's. Slipping
    // against it would be a guess, and the guess shows up as black frames.
    restrictions.push({ kind: 'unmeasured-source', reason: 'unmeasured-source', blocks: ['slip'] });
  }
  const track = document.timeline.tracks.find((each) => each.id === clip.trackId);
  if (track?.locked === true) {
    restrictions.push({
      kind: 'locked-track',
      reason: 'locked-track',
      blocks: ['trim', 'speed', 'razor', 'slip'],
    });
  }
  return restrictions;
}

/** True when `operation` is available on `clipId`. */
export function clipAllows(
  document: EditorDocument,
  clipId: string,
  operation: 'trim' | 'speed' | 'razor' | 'slip',
): boolean {
  return !clipRestrictions(document, clipId).some((restriction) => restriction.blocks.includes(operation));
}

/* ── change detection ────────────────────────────────────────────────────── */

/**
 * Whether the timeline differs from the project it was built from.
 *
 * Compared by value, not by a dirty flag: an undo that returns the document to
 * where it started should also return 「保存」 to disabled, and a flag set by
 * "an edit happened" cannot do that.
 *
 * Both sides are put through `toEditorProject` first. That matters — the
 * adapter normalises (track `order` is re-derived from position,
 * `duration_seconds` from the content, orphaned groups dissolve), and
 * comparing a normalised document against a raw one would report a change on
 * every project whose stored form differed from the normal form in any of
 * those ways, before the user touched anything.
 */
export function hasUnsavedChanges(document: EditorDocument, original: EditorProject): boolean {
  const stable = () => '00000000-0000-4000-8000-000000000000';
  const now = toEditorProject(document, stable);
  const before = toEditorProject(toEditorDocument(original), stable);
  return JSON.stringify(stripVolatile(now)) !== JSON.stringify(stripVolatile(before));
}

/** `updated_at` and `revision` move on their own; they are not edits. */
function stripVolatile(project: EditorProject): Omit<EditorProject, 'updated_at' | 'revision'> {
  const { updated_at: _updatedAt, revision: _revision, ...rest } = project;
  return rest;
}

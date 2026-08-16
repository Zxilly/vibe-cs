import { describe, expect, it } from 'vitest';

import { getClip, razorAt, rippleDelete, setClipSpeed, trimClip } from '../../design/timeline';
import type { EditorProject } from '../../shared/desktop/dto';
import {
  clipAllows,
  clipRestrictions,
  DEFAULT_MARKER_COLOR,
  droppedKeyframeCount,
  hasUnsavedChanges,
  laneCodes,
  toEditorDocument,
  toEditorProject,
  type EditorDocument,
} from './editorDocument';
import {
  A1,
  AURORA_VIDEO,
  CAPTION,
  KAEL_AUDIO,
  KAEL_VIDEO,
  LINK_KAEL,
  MARKER,
  PROJECT_ID,
  sampleAssets,
  sampleEditorProject,
  stubMint,
  T1,
  V1,
} from './editorFixtures.testing';

function load(project: EditorProject = sampleEditorProject()): EditorDocument {
  return toEditorDocument(project, { assets: sampleAssets() });
}

function save(document: EditorDocument): EditorProject {
  return toEditorProject(document, stubMint());
}

function wireClip(project: EditorProject, id: string) {
  return project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === id);
}

describe('toEditorDocument', () => {
  it('flattens the tracks into one clip list in lane order', () => {
    const { timeline } = load();
    expect(timeline.tracks.map((track) => track.id)).toEqual([V1, A1, T1]);
    expect(timeline.clips.map((clip) => clip.id)).toEqual([KAEL_VIDEO, AURORA_VIDEO, KAEL_AUDIO, CAPTION]);
  });

  it('takes the frame rate from the project', () => {
    expect(load().timeline.fps).toBe(60);
    expect(load(sampleEditorProject({ fps: 24 })).timeline.fps).toBe(24);
  });

  it('joins the source length from the media asset, not the clip window', () => {
    // The clip shows 20s of a 48s file. Without the join the model would think
    // the source was exactly as long as the window and refuse every slip.
    const kael = getClip(load().timeline, KAEL_VIDEO)!;
    expect(kael.sourceIn).toBe(3);
    expect(kael.sourceDuration).toBe(48);
  });

  it('falls back to the clip window when the asset is unknown', () => {
    // Honest rather than optimistic: a length nobody measured is not headroom,
    // and pretending otherwise puts black frames in an export.
    const withoutAssets = toEditorDocument(sampleEditorProject());
    const kael = getClip(withoutAssets.timeline, KAEL_VIDEO)!;
    expect(kael.sourceDuration).toBe(23);
  });

  it('derives the head column’s codes, counting up from the bottom', () => {
    // The artboard draws V2 above V1, so the lowest video lane is V1.
    const project = sampleEditorProject();
    const codes = laneCodes(project.tracks);
    expect(codes.get(V1)).toBe('V1');
    expect(codes.get(A1)).toBe('A1');
    expect(codes.get(T1)).toBe('T1');
    // …and the stored name becomes the role beside it, unchanged.
    expect(load().timeline.tracks[0]?.role).toBe('主画面');
  });

  it('numbers two lanes of one kind from the bottom up', () => {
    const stacked = sampleEditorProject({
      tracks: [
        { id: 'v-top', kind: 'video', name: '叠加', order: 0, muted: false, locked: false, hidden: false, clips: [] },
        { id: 'v-bottom', kind: 'video', name: '主画面', order: 1, muted: false, locked: false, hidden: false, clips: [] },
      ],
    });
    const codes = laneCodes(stacked.tracks);
    expect(codes.get('v-bottom')).toBe('V1');
    expect(codes.get('v-top')).toBe('V2');
  });

  it('carries the link group across', () => {
    const { timeline } = load();
    expect(getClip(timeline, KAEL_VIDEO)?.linkId).toBe(LINK_KAEL);
    expect(getClip(timeline, KAEL_AUDIO)?.linkId).toBe(LINK_KAEL);
    expect(getClip(timeline, AURORA_VIDEO)?.linkId).toBeUndefined();
  });

  it('keeps every wire clip in the shadow, including what the model drops', () => {
    const { clips } = load();
    expect(clips.get(KAEL_VIDEO)?.effects).toHaveLength(1);
    expect(clips.get(KAEL_VIDEO)?.metadata).toEqual({ origin: { kind: 'recorded_clip', shot: 3 } });
    expect(clips.get(CAPTION)?.text?.content).toBe('1v3 CLUTCH');
  });
});

describe('toEditorProject — the round trip', () => {
  it('is the identity when nothing was edited', () => {
    const original = sampleEditorProject();
    const saved = save(load(original));
    expect(saved.tracks).toEqual(original.tracks);
    expect(saved.markers).toEqual(original.markers);
    expect(saved.settings).toEqual(original.settings);
    expect(saved.revision).toBe(24);
  });

  it('preserves everything the timeline does not describe, through an edit', () => {
    // The hard rule of the module. Moving a clip must not cost it its colour
    // grade, its transform or its `metadata` — and `metadata` is open-ended,
    // so "what this file forgot" is a permanent category.
    const document = load();
    const moved = trimClip(document.timeline, KAEL_VIDEO, 'out', -2);
    const saved = save({ ...document, timeline: moved.timeline });
    const kael = wireClip(saved, KAEL_VIDEO)!;

    expect(kael.transform).toEqual({ x: 4, y: -2, scale_x: 1.04, scale_y: 1.04, rotation: 0, opacity: 1 });
    expect(kael.effects[0]?.parameters).toEqual({ brightness: 0.1, contrast: 1.2, saturation: 0.8 });
    expect(kael.metadata).toEqual({ origin: { kind: 'recorded_clip', shot: 3 } });
    expect(kael.volume).toBe(1);
    expect(wireClip(saved, CAPTION)?.text?.content).toBe('1v3 CLUTCH');
  });

  it('writes the five fields the timeline owns', () => {
    const document = load();
    const trimmed = trimClip(document.timeline, AURORA_VIDEO, 'in', 2);
    const saved = save({ ...document, timeline: trimmed.timeline });
    const aurora = wireClip(saved, AURORA_VIDEO)!;
    expect(aurora.start).toBe(27);
    expect(aurora.duration).toBe(13);
    expect(aurora.source_in).toBe(6);
    expect(aurora.source_out).toBe(19);
  });

  it('derives source_out from speed, not from duration', () => {
    const document = load();
    const faster = setClipSpeed(document.timeline, AURORA_VIDEO, 2);
    const aurora = wireClip(save({ ...document, timeline: faster.timeline }), AURORA_VIDEO)!;
    expect(aurora.speed).toBe(2);
    expect(aurora.duration).toBe(7.5);
    // The window is unchanged — that is what a speed change means here.
    expect(aurora.source_in).toBe(4);
    expect(aurora.source_out).toBe(19);
  });

  it('re-derives track order from the lane order', () => {
    const saved = save(load());
    expect(saved.tracks.map((track) => track.order)).toEqual([0, 1, 2]);
  });

  it('keeps the track’s stored name and its mute / hidden flags', () => {
    const project = sampleEditorProject();
    project.tracks[1]!.muted = true;
    project.tracks[1]!.hidden = true;
    const saved = save(load(project));
    expect(saved.tracks[1]?.name).toBe('原声');
    expect(saved.tracks[1]?.muted).toBe(true);
    expect(saved.tracks[1]?.hidden).toBe(true);
  });

  it('keeps a marker’s colour, which the model does not carry', () => {
    expect(save(load()).markers[0]).toEqual({
      id: MARKER,
      time: 20,
      label: '入场',
      color: DEFAULT_MARKER_COLOR,
    });
  });
});

describe('toEditorProject — identity at the boundary', () => {
  it('mints a uuid for a clip the razor produced', () => {
    const document = load();
    const cut = razorAt(document.timeline, 10);
    const saved = save({ ...document, timeline: cut.timeline });
    const halves = saved.tracks.flatMap((track) => track.clips);

    // Seven: the A/V pair and the caption all cross t = 10 and are all cut,
    // leaving three right halves beside Aurora, which does not start until 25.
    expect(halves).toHaveLength(7);
    for (const clip of halves) {
      expect(clip.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
    }
  });

  it('gives the right halves of one cut the same new link group', () => {
    const document = load();
    const cut = razorAt(document.timeline, 10);
    const saved = save({ ...document, timeline: cut.timeline });
    const rightHalves = saved.tracks
      .flatMap((track) => track.clips)
      .filter((clip) => clip.start === 10 && clip.link_group_id !== null);

    expect(rightHalves).toHaveLength(2);
    expect(rightHalves[0]?.link_group_id).toBe(rightHalves[1]?.link_group_id);
    // …and it is not the group the left halves kept.
    expect(rightHalves[0]?.link_group_id).not.toBe(LINK_KAEL);
  });

  it('inherits the origin’s wire fields on a cut, minus its automation', () => {
    // A razor splits a clip in time. The grade applies to both halves; the
    // keyframe curve was written for the whole and cannot be halved by copying
    // it, and the document requires keyframe ids to be unique project-wide.
    const document = load();
    const cut = razorAt(document.timeline, 10);
    const saved = save({ ...document, timeline: cut.timeline });
    const right = saved.tracks
      .flatMap((track) => track.clips)
      .find((clip) => clip.start === 10 && clip.effects.length > 0)!;

    expect(right.effects[0]?.kind).toBe('color_adjust');
    expect(right.keyframes).toEqual([]);
    expect(right.speed_segments).toEqual([]);
  });
});

describe('toEditorProject — the invariants the service enforces', () => {
  it('dissolves a link group left with one member', () => {
    // Deleting one half of an A/V pair leaves a group of one, which
    // `EditorProject::validate` rejects — a 400 on a rule the user never saw.
    const document = load();
    // `linked: false` is what deletes one half — the default deletes the whole
    // group, which is the behaviour that makes this situation rare rather than
    // impossible. Separating audio and then deleting it reaches it directly.
    const lifted = rippleDelete(document.timeline, KAEL_AUDIO, { scope: 'track', linked: false });
    const saved = save({ ...document, timeline: lifted.timeline });
    expect(wireClip(saved, KAEL_AUDIO)).toBeUndefined();
    expect(wireClip(saved, KAEL_VIDEO)?.link_group_id).toBeNull();
  });

  it('keeps a link group that still spans two tracks', () => {
    expect(wireClip(save(load()), KAEL_VIDEO)?.link_group_id).toBe(LINK_KAEL);
  });

  it('dissolves a clip group left with one member', () => {
    const project = sampleEditorProject();
    project.tracks[0]!.clips[0]!.group_id = 'group-1';
    project.tracks[0]!.clips[1]!.group_id = 'group-1';
    const document = load(project);
    const lifted = rippleDelete(document.timeline, AURORA_VIDEO, { scope: 'track', linked: false });
    const saved = save({ ...document, timeline: lifted.timeline });
    expect(wireClip(saved, KAEL_VIDEO)?.group_id).toBeNull();
  });

  it('drops keyframes a shortened clip no longer contains', () => {
    // The keyframe is at t = 2 inside a 20s clip. Trimming to one second puts
    // it outside, and the document requires `time <= duration`.
    const document = load();
    const trimmed = trimClip(document.timeline, KAEL_VIDEO, 'out', -19);
    const saved = save({ ...document, timeline: trimmed.timeline });
    expect(wireClip(saved, KAEL_VIDEO)?.keyframes).toEqual([]);
  });

  it('keeps keyframes that still fit', () => {
    const document = load();
    const trimmed = trimClip(document.timeline, KAEL_VIDEO, 'out', -5);
    expect(wireClip(save({ ...document, timeline: trimmed.timeline }), KAEL_VIDEO)?.keyframes).toHaveLength(1);
  });

  it('counts what a save would cost before it costs it', () => {
    const document = load();
    expect(droppedKeyframeCount(document)).toEqual({ keyframes: 0, clips: 0 });

    const trimmed = { ...document, timeline: trimClip(document.timeline, KAEL_VIDEO, 'out', -19).timeline };
    expect(droppedKeyframeCount(trimmed)).toEqual({ keyframes: 1, clips: 1 });
  });

  it('does not report a loss for a clip the user deleted', () => {
    // It took its keyframes with it, deliberately. A warning there is noise.
    const document = load();
    const deleted = {
      ...document,
      timeline: rippleDelete(document.timeline, KAEL_VIDEO, { scope: 'track' }).timeline,
    };
    expect(droppedKeyframeCount(deleted)).toEqual({ keyframes: 0, clips: 0 });
  });

  it('grows duration_seconds to hold the content and the markers', () => {
    const document = load();
    const grown = trimClip(document.timeline, AURORA_VIDEO, 'out', 5);
    expect(save({ ...document, timeline: grown.timeline }).duration_seconds).toBe(45);

    // A marker parked past the content keeps the project long enough for it.
    const short = load(sampleEditorProject({ markers: [{ id: MARKER, time: 500, label: '远', color: '#fff' }] }));
    expect(save(short).duration_seconds).toBe(500);
  });
});

describe('clipRestrictions', () => {
  it('is empty for an ordinary clip', () => {
    expect(clipRestrictions(load(), KAEL_VIDEO)).toEqual([]);
    expect(clipAllows(load(), KAEL_VIDEO, 'trim')).toBe(true);
  });

  it('refuses to edit a clip carrying a speed ramp, and says which kind', () => {
    // The ramp's segments are written against this clip's duration; a trim or
    // a cut would leave them describing a clip that no longer exists.
    const project = sampleEditorProject();
    project.tracks[0]!.clips[1]!.speed_segments = [
      { id: 'seg-1', start: 0, end: 7.5, speed: 1 },
      { id: 'seg-2', start: 7.5, end: 15, speed: 2 },
    ];
    const document = load(project);
    expect(clipRestrictions(document, AURORA_VIDEO)[0]?.kind).toBe('speed-ramp');
    for (const operation of ['trim', 'speed', 'razor', 'slip'] as const) {
      expect(clipAllows(document, AURORA_VIDEO, operation)).toBe(false);
    }
  });

  it('refuses a slip on a clip whose source was never measured', () => {
    const document = toEditorDocument(sampleEditorProject()); // no assets
    expect(clipAllows(document, KAEL_VIDEO, 'slip')).toBe(false);
    // A trim inwards is still fine — it needs no headroom.
    expect(clipAllows(document, KAEL_VIDEO, 'trim')).toBe(true);
  });

  it('refuses everything on a locked track', () => {
    const project = sampleEditorProject();
    project.tracks[0]!.locked = true;
    const document = load(project);
    expect(clipRestrictions(document, KAEL_VIDEO).map((each) => each.kind)).toContain('locked-track');
    expect(clipAllows(document, KAEL_VIDEO, 'razor')).toBe(false);
  });

  it('answers nothing for a clip that is not there', () => {
    expect(clipRestrictions(load(), 'nope')).toEqual([]);
  });
});

describe('hasUnsavedChanges', () => {
  it('is false for a freshly loaded project', () => {
    const original = sampleEditorProject();
    expect(hasUnsavedChanges(load(original), original)).toBe(false);
  });

  it('is false for a project whose stored form is not the normal form', () => {
    // Track `order` is re-derived from position and `duration_seconds` from the
    // content, so a stored project that differs in either would otherwise read
    // as edited before the user touched it.
    const odd = sampleEditorProject({ duration_seconds: 9999 });
    odd.tracks[0]!.order = 7;
    odd.tracks[1]!.order = 9;
    odd.tracks[2]!.order = 11;
    expect(hasUnsavedChanges(load(odd), odd)).toBe(false);
  });

  it('is true after an edit', () => {
    const original = sampleEditorProject();
    const document = load(original);
    const edited = { ...document, timeline: trimClip(document.timeline, AURORA_VIDEO, 'out', 1).timeline };
    expect(hasUnsavedChanges(edited, original)).toBe(true);
  });

  it('is false again after the edit is undone', () => {
    // What a dirty flag cannot do, and the reason this is a value comparison.
    const original = sampleEditorProject();
    const document = load(original);
    const there = trimClip(document.timeline, AURORA_VIDEO, 'out', 1).timeline;
    const back = trimClip(there, AURORA_VIDEO, 'out', -1).timeline;
    expect(hasUnsavedChanges({ ...document, timeline: back }, original)).toBe(false);
  });

  it('ignores revision and updated_at', () => {
    const original = sampleEditorProject();
    const document = load(original);
    expect(hasUnsavedChanges(document, { ...original, revision: 99, updated_at: '2027-01-01T00:00:00Z' })).toBe(false);
  });

  it('sees a playhead move as no change', () => {
    // The playhead is not part of the document; it is not even sent.
    const original = sampleEditorProject();
    const document = load(original);
    expect(hasUnsavedChanges({ ...document, timeline: { ...document.timeline, playhead: 12 } }, original)).toBe(false);
  });
});

describe('the project envelope', () => {
  it('keeps identity, canvas and settings untouched', () => {
    const saved = save(load());
    expect(saved.id).toBe(PROJECT_ID);
    expect(saved.name).toBe('Aurora 赛点集锦');
    expect(saved.width).toBe(1920);
    expect(saved.height).toBe(1080);
    expect(saved.settings).toEqual({ preset: 'youtube-1080p60' });
    expect(saved.created_at).toBe('2026-08-01T09:00:00Z');
  });

  it('sends back the revision it was read at — the expected_revision', () => {
    // There is no separate field on the wire: `save_editor_project` reads
    // `project.revision` as the expectation. Inventing one here would be
    // indistinguishable from sending a stale one.
    expect(save(load()).revision).toBe(24);
  });
});

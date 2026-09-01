import type { TimelineClip } from '../../shared/desktop/dto';
import { setTimelineTransitionDuration, timelineTransition } from './timelineTransitions';

export interface TimelinePasteAttributeSelection {
  readonly transform: boolean;
  readonly effects: boolean;
  readonly keyframes: boolean;
  readonly transitions: boolean;
  readonly audio: boolean;
}

export function pasteTimelineClipAttributes(
  source: TimelineClip,
  target: TimelineClip,
  selection: TimelinePasteAttributeSelection,
  fps: number,
  createId: () => string,
): TimelineClip {
  let replacement: TimelineClip = {
    ...target,
    ...(selection.transform ? { transform: { ...source.transform } } : {}),
    ...(selection.effects ? {
      effects: source.effects.map((effect) => ({ ...effect, id: createId(), parameters: structuredClone(effect.parameters) })),
    } : {}),
    ...(selection.keyframes ? {
      keyframes: source.keyframes
        .filter((keyframe) => keyframe.time <= target.placement.duration + 1e-6)
        .map((keyframe) => ({ ...keyframe, id: createId() })),
    } : {}),
    ...(selection.audio ? {
      placement: { ...target.placement, volume: source.placement.volume, pan: source.placement.pan },
    } : {}),
  };
  if (!selection.transitions) return replacement;
  for (const channel of ['video', 'audio'] as const) {
    for (const edge of ['in', 'out'] as const) {
      const sourceTransition = timelineTransition(source, channel, edge);
      replacement = setTimelineTransitionDuration(
        replacement,
        channel,
        edge,
        sourceTransition?.duration_seconds ?? 0,
        fps,
      );
      const copied = timelineTransition(replacement, channel, edge);
      if (sourceTransition !== null && copied !== null) {
        const field = `${channel}_${edge}` as keyof TimelineClip['transitions'];
        replacement = {
          ...replacement,
          transitions: { ...replacement.transitions, [field]: { ...copied, kind: sourceTransition.kind } },
        };
      }
    }
  }
  return replacement;
}

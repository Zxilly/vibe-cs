import type { TimelineClip } from '../../shared/desktop/dto';
import { evaluateClipKeyframeProperty } from './keyframeEditing';
import { clipTransition, clipTransitionDuration } from './timelineInteraction';
import { EDITOR_EFFECT_SCHEMAS, editorEffectParameter, isSupportedEditorEffectKind } from './effectEditing';

export function evaluatePreviewTransform(clip: TimelineClip, localTime: number) {
  return {
    x: evaluateClipKeyframeProperty(clip, 'x', localTime, clip.transform.x),
    y: evaluateClipKeyframeProperty(clip, 'y', localTime, clip.transform.y),
    scaleX: evaluateClipKeyframeProperty(clip, 'scale_x', localTime, clip.transform.scale_x),
    scaleY: evaluateClipKeyframeProperty(clip, 'scale_y', localTime, clip.transform.scale_y),
    rotation: evaluateClipKeyframeProperty(clip, 'rotation', localTime, clip.transform.rotation),
    opacity: evaluateClipKeyframeProperty(clip, 'opacity', localTime, clip.transform.opacity),
  };
}

interface PreviewTransitionPresentation {
  readonly kind: string;
  readonly progress: number;
  readonly opacityFactor: number;
  readonly scale: number;
  readonly rotation: number;
  readonly filter: string;
  readonly clipPath: string;
}

const NO_PREVIEW_TRANSITION: PreviewTransitionPresentation = {
  kind: '',
  progress: 1,
  opacityFactor: 1,
  scale: 1,
  rotation: 0,
  filter: '',
  clipPath: 'none',
};

export function evaluatePreviewTransition(
  clip: TimelineClip,
  localTime: number,
  projectWidth: number,
): PreviewTransitionPresentation {
  const transitionIn = clipTransition(clip, 'video', 'in');
  const transitionOut = clipTransition(clip, 'video', 'out');
  const inDuration = Math.min(clip.placement.duration, clipTransitionDuration(clip, 'video', 'in'));
  const outDuration = Math.min(clip.placement.duration, clipTransitionDuration(clip, 'video', 'out'));
  const remaining = clip.placement.duration - localTime;
  const entering = transitionIn !== null && localTime < inDuration;
  const exiting = !entering && transitionOut !== null && remaining < outDuration;
  if (!entering && !exiting) return NO_PREVIEW_TRANSITION;
  const kind = (entering ? transitionIn : transitionOut)?.kind ?? 'fade';
  const duration = entering ? inDuration : outDuration;
  const progress = Math.min(1, Math.max(0, (entering ? localTime : remaining) / duration));
  const intensity = 1 - progress;
  const base = { ...NO_PREVIEW_TRANSITION, kind, progress };
  switch (kind) {
    case 'fade': return { ...base, opacityFactor: progress };
    case 'dip': return { ...base, filter: `brightness(${progress})` };
    case 'flash': return { ...base, filter: `brightness(${1 + intensity * 2}) saturate(${progress})` };
    case 'zoom': return { ...base, scale: 1 + 0.18 * intensity };
    case 'wipe':
    case 'slide': return { ...base, clipPath: `inset(0 ${100 * intensity}% 0 0)` };
    case 'blur': return { ...base, filter: `blur(${8 / Math.max(1, projectWidth) * 100}cqw)` };
    case 'glitch': {
      const shift = 8 / Math.max(1, projectWidth) * 100;
      return { ...base, filter: `drop-shadow(${shift}cqw 0 0 cyan) drop-shadow(${-shift}cqw 0 0 red)` };
    }
    case 'spin': return { ...base, rotation: 0.35 * 180 / Math.PI * intensity };
    default: return NO_PREVIEW_TRANSITION;
  }
}

export function evaluatePreviewFilter(clip: TimelineClip, projectWidth: number) {
  const kinds: string[] = [];
  const filters: string[] = [];
  for (const effect of clip.effects) {
    if (!effect.enabled || !isSupportedEditorEffectKind(effect.kind)) continue;
    kinds.push(effect.kind);
    if (effect.kind === 'color_adjust') {
      const [brightnessSchema, contrastSchema, saturationSchema] = EDITOR_EFFECT_SCHEMAS.color_adjust;
      const brightness = editorEffectParameter(effect, brightnessSchema!);
      const contrast = editorEffectParameter(effect, contrastSchema!);
      const saturation = editorEffectParameter(effect, saturationSchema!);
      filters.push(`brightness(${Math.max(0, 1 + brightness)}) contrast(${contrast}) saturate(${saturation})`);
    } else if (effect.kind === 'grayscale') {
      filters.push('grayscale(1)');
    } else {
      const radius = editorEffectParameter(effect, EDITOR_EFFECT_SCHEMAS.blur[0]!);
      filters.push(`blur(${radius / Math.max(1, projectWidth) * 100}cqw)`);
    }
  }
  return { kinds, filter: filters.join(' ') || 'none' };
}


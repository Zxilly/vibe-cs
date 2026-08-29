import type { EditorEffect, JsonValue } from '../../shared/desktop/dto';

export type SupportedEditorEffectKind = 'color_adjust' | 'grayscale' | 'blur';

export interface EffectParameterSchema {
  readonly key: string;
  readonly minimum: number;
  readonly maximum: number;
  readonly step: number;
  readonly defaultValue: number;
}

export const EDITOR_EFFECT_SCHEMAS: Readonly<Record<SupportedEditorEffectKind, readonly EffectParameterSchema[]>> = {
  color_adjust: [
    { key: 'brightness', minimum: -1, maximum: 1, step: 0.01, defaultValue: 0 },
    { key: 'contrast', minimum: 0, maximum: 3, step: 0.01, defaultValue: 1 },
    { key: 'saturation', minimum: 0, maximum: 3, step: 0.01, defaultValue: 1 },
  ],
  grayscale: [],
  blur: [{ key: 'radius', minimum: 0, maximum: 20, step: 0.1, defaultValue: 0 }],
};

export function isSupportedEditorEffectKind(kind: string): kind is SupportedEditorEffectKind {
  return kind in EDITOR_EFFECT_SCHEMAS;
}

export function createEditorEffect(kind: SupportedEditorEffectKind, id: string): EditorEffect {
  return {
    id,
    kind,
    enabled: true,
    parameters: Object.fromEntries(EDITOR_EFFECT_SCHEMAS[kind].map((parameter) => [parameter.key, parameter.defaultValue])),
  };
}

export function editorEffectParameter(effect: EditorEffect, schema: EffectParameterSchema): number {
  const parameters = effectParameters(effect.parameters);
  const value = parameters[schema.key];
  return typeof value === 'number' && Number.isFinite(value) ? value : schema.defaultValue;
}

export function setEditorEffectParameter(
  effect: EditorEffect,
  schema: EffectParameterSchema,
  value: number,
): EditorEffect {
  const constrained = Math.min(schema.maximum, Math.max(schema.minimum, value));
  return {
    ...effect,
    parameters: { ...effectParameters(effect.parameters), [schema.key]: constrained },
  };
}

export function moveEditorEffect(effects: readonly EditorEffect[], effectId: string, direction: -1 | 1): EditorEffect[] {
  const index = effects.findIndex((effect) => effect.id === effectId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= effects.length) return [...effects];
  const next = [...effects];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

function effectParameters(value: JsonValue): Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

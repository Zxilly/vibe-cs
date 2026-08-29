import { describe, expect, it } from 'vitest';

import {
  createEditorEffect,
  EDITOR_EFFECT_SCHEMAS,
  editorEffectParameter,
  moveEditorEffect,
  setEditorEffectParameter,
} from './effectEditing';

describe('closed production effect vocabulary', () => {
  it('creates only renderer-backed defaults', () => {
    expect(createEditorEffect('color_adjust', 'color')).toEqual({
      id: 'color',
      kind: 'color_adjust',
      enabled: true,
      parameters: { brightness: 0, contrast: 1, saturation: 1 },
    });
    expect(createEditorEffect('grayscale', 'gray').parameters).toEqual({});
    expect(createEditorEffect('blur', 'blur').parameters).toEqual({ radius: 0 });
  });

  it('reads defaults and clamps parameters to renderer limits', () => {
    const blur = createEditorEffect('blur', 'blur');
    const schema = EDITOR_EFFECT_SCHEMAS.blur[0]!;
    expect(editorEffectParameter({ ...blur, parameters: null }, schema)).toBe(0);
    expect(setEditorEffectParameter(blur, schema, 30).parameters).toEqual({ radius: 20 });
  });

  it('reorders effects without changing their identities', () => {
    const color = createEditorEffect('color_adjust', 'color');
    const blur = createEditorEffect('blur', 'blur');
    expect(moveEditorEffect([color, blur], 'blur', -1).map((effect) => effect.id)).toEqual(['blur', 'color']);
    expect(moveEditorEffect([color, blur], 'color', -1).map((effect) => effect.id)).toEqual(['color', 'blur']);
  });
});

import { describe, expect, it } from 'vitest';

import {
  applyAppTheme,
  applyReduceMotion,
  normalizeAppTheme,
  type ThemeAttributeTarget,
} from './themeRuntime';

function createFakeRoot(): { root: ThemeAttributeTarget; attrs: Map<string, string> } {
  const attrs = new Map<string, string>();
  const root: ThemeAttributeTarget = {
    setAttribute(name, value) {
      attrs.set(name, value);
    },
    removeAttribute(name) {
      attrs.delete(name);
    },
  };
  return { root, attrs };
}

describe('themeRuntime', () => {
  it('normalises valid theme values and falls back to system', () => {
    expect(normalizeAppTheme('light')).toBe('light');
    expect(normalizeAppTheme('dark')).toBe('dark');
    expect(normalizeAppTheme('system')).toBe('system');
    expect(normalizeAppTheme('')).toBe('system');
    expect(normalizeAppTheme('sepia')).toBe('system');
    expect(normalizeAppTheme(undefined)).toBe('system');
    expect(normalizeAppTheme(null)).toBe('system');
  });

  it('writes data-theme for explicit light/dark and clears it for system', () => {
    const { root, attrs } = createFakeRoot();

    expect(applyAppTheme('dark', root)).toBe('dark');
    expect(attrs.get('data-theme')).toBe('dark');

    expect(applyAppTheme('light', root)).toBe('light');
    expect(attrs.get('data-theme')).toBe('light');

    expect(applyAppTheme('system', root)).toBe('system');
    expect(attrs.has('data-theme')).toBe(false);
  });

  it('toggles data-reduce-motion cleanly on the root element', () => {
    const { root, attrs } = createFakeRoot();

    applyReduceMotion(true, root);
    expect(attrs.get('data-reduce-motion')).toBe('true');

    applyReduceMotion(false, root);
    expect(attrs.has('data-reduce-motion')).toBe(false);
  });
});

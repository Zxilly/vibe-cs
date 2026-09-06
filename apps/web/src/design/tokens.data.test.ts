import { describe, expect, it } from 'vitest';
import { COLOR_TOKENS, FIGMA_BINDINGS, TYPE_ROLES } from './tokens.data';

function luminance(hex: string): number {
  const channels = [1, 3, 5].map(offset => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return (channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722;
}

function contrast(a: string, b: string): number {
  const values = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return ((values[1] ?? 0) + 0.05) / ((values[0] ?? 0) + 0.05);
}

describe('unified visual roles', () => {
  it('maps a shared CSS name to the same value in every Figma role', () => {
    const seen = new Map<string, readonly [string | number, string | number]>();
    for (const binding of FIGMA_BINDINGS) {
      const value = [binding.light, binding.dark] as const;
      const previous = seen.get(binding.css);
      if (previous !== undefined) expect(value, binding.css).toEqual(previous);
      seen.set(binding.css, value);
    }
  });

  it('keeps body, metadata and selected labels above 4.5:1 in either mode', () => {
    for (const mode of ['light', 'dark'] as const) {
      for (const background of ['--color-bg', '--color-surface', '--color-surface-chrome', '--color-accent-100']) {
        for (const foreground of ['--color-text', '--color-neutral-500', '--color-neutral-600', '--color-neutral-700']) {
          expect(contrast(COLOR_TOKENS[foreground]![mode], COLOR_TOKENS[background]![mode]), `${mode}: ${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it('keeps primary actions and fixed media labels above 4.5:1', () => {
    for (const mode of ['light', 'dark'] as const) {
      for (const background of ['--color-accent', '--color-accent-600', '--color-accent-700', '--color-fail', '--color-danger-hover', '--color-danger-pressed']) {
        expect(contrast(COLOR_TOKENS['--color-on-accent']![mode], COLOR_TOKENS[background]![mode]), `${mode}: ${background}`).toBeGreaterThanOrEqual(4.5);
      }
      for (const foreground of ['--color-on-media', '--color-on-media-muted']) {
        expect(contrast(COLOR_TOKENS[foreground]![mode], COLOR_TOKENS['--color-media']![mode])).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('uses a strictly increasing type ramp without an unreadable metadata tier', () => {
    const sizes = Object.values(TYPE_ROLES).map(([size]) => size);
    expect(sizes[0]).toBe(12);
    expect(sizes).toEqual([...new Set(sizes)].sort((a, b) => a - b));
  });
});

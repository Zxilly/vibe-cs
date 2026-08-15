/**
 * The §3.3 contract, asserted rather than trusted: four sizes, every one of
 * them a dereference of an `--h-ctl-*` token, and no 28 or 30 anywhere. This
 * is the unit half of spec §6.4 — "把架构约束本身变成测试".
 */

import { describe, expect, it } from 'vitest';

import {
  CONTROL_HEIGHT_CLASS,
  CONTROL_PADDING_CLASS,
  CONTROL_SIZES,
  CONTROL_SQUARE_CLASS,
  CONTROL_TEXT_CLASS,
} from './controlSize';

const TYPE_TOKENS = new Set(['text-2xs', 'text-xs', 'text-sm', 'text-base', 'text-md']);

describe('control sizes', () => {
  it('has exactly the four steps of §3.3', () => {
    expect(CONTROL_SIZES).toEqual(['sm', 'md', 'lg', 'hero']);
  });

  it('reads every height and width from an --h-ctl-* token', () => {
    for (const size of CONTROL_SIZES) {
      expect(CONTROL_HEIGHT_CLASS[size]).toBe(`h-[var(--h-ctl-${size})]`);
      expect(CONTROL_SQUARE_CLASS[size]).toBe(`w-[var(--h-ctl-${size})]`);
    }
  });

  it('carries no literal length in any map', () => {
    const everyClass = [
      ...Object.values(CONTROL_HEIGHT_CLASS),
      ...Object.values(CONTROL_SQUARE_CLASS),
      ...Object.values(CONTROL_PADDING_CLASS),
    ].join(' ');

    // A bare px would mean a control height or padding written down instead of
    // derived; `calc(var(--spacing)*n)` is a scale multiple, not a literal.
    expect(everyClass).not.toMatch(/\d+px/u);
  });

  it('names a --text-* step for every size', () => {
    for (const size of CONTROL_SIZES) {
      expect(TYPE_TOKENS.has(CONTROL_TEXT_CLASS[size])).toBe(true);
    }
  });

  it('keeps the hero step the only enlarged label and the only wider padding', () => {
    expect(CONTROL_TEXT_CLASS.hero).toBe('text-md');
    expect(CONTROL_TEXT_CLASS.md).toBe(CONTROL_TEXT_CLASS.lg);
    expect(CONTROL_PADDING_CLASS.sm).toBe(CONTROL_PADDING_CLASS.md);
    expect(CONTROL_PADDING_CLASS.hero).not.toBe(CONTROL_PADDING_CLASS.md);
  });
});

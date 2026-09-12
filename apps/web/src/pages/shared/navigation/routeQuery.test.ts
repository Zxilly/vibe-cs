/*
 * `unit` project — `?view=` / `?section=` / `?mode=` resolution.
 */

import { describe, expect, it } from 'vitest';

import { pickQueryValue } from './routeQuery';

const VIEWS = ['table', 'card'] as const;

describe('pickQueryValue', () => {
  it('returns an allowed value unchanged', () => {
    expect(pickQueryValue('card', VIEWS, 'table')).toBe('card');
    expect(pickQueryValue('table', VIEWS, 'table')).toBe('table');
  });

  it('falls back when the parameter is absent, so the bare path is a legal address', () => {
    expect(pickQueryValue(null, VIEWS, 'table')).toBe('table');
  });

  it('falls back on an unknown value instead of rendering nothing', () => {
    expect(pickQueryValue('grid', VIEWS, 'table')).toBe('table');
    expect(pickQueryValue('', VIEWS, 'table')).toBe('table');
  });

  it('is case sensitive — §7 fixes the spellings, and a near miss is still a miss', () => {
    expect(pickQueryValue('Card', VIEWS, 'table')).toBe('table');
  });
});

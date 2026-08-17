import { describe, expect, it } from 'vitest';

import { cn } from './cn';

describe('cn', () => {
  it('joins the truthy fragments with a single space', () => {
    expect(cn('a', 'b', 'c')).toBe('a b c');
  });

  it('drops every falsy fragment, including the empty string', () => {
    expect(cn('a', false, null, undefined, '', 'b')).toBe('a b');
  });

  it('returns an empty string when nothing survives', () => {
    expect(cn(false, undefined)).toBe('');
  });

  /* The reason this is `cn` and not the old `cx`: a caller's class has to be
     able to *replace* one the component already set, not merely follow it. */
  it('lets a later class win over the one it conflicts with', () => {
    expect(cn('bg-surface', 'bg-accent')).toBe('bg-accent');
    expect(cn('p-3 text-neutral-600', 'text-fail-text')).toBe('p-3 text-fail-text');
  });

  it('leaves classes of different properties alone', () => {
    expect(cn('bg-accent', 'text-bg')).toBe('bg-accent text-bg');
  });

  /* The `extendTailwindMerge` config earns its place here. Unconfigured,
     `twMerge` cannot find `2xs` or `md` in its font-size list, falls through to
     colour, and drops the size the moment a colour follows it. */
  it('treats the two non-stock type steps as sizes, not colours', () => {
    expect(cn('text-2xs', 'text-neutral-600')).toBe('text-2xs text-neutral-600');
    expect(cn('text-md', 'text-fail-text')).toBe('text-md text-fail-text');
  });

  it('still merges two steps of the type scale against each other', () => {
    expect(cn('text-2xs', 'text-lg')).toBe('text-lg');
    expect(cn('text-base', 'text-md')).toBe('text-md');
  });

  it('knows 「tracking-caps」 is letter spacing', () => {
    expect(cn('tracking-caps', 'tracking-wide')).toBe('tracking-wide');
  });
});

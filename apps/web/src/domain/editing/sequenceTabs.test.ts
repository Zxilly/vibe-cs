import { describe, expect, it } from 'vitest';

import { closeSequenceTab, openSequenceTab, readSequenceTabs, writeSequenceTabs } from './sequenceTabs';

describe('sequence tabs', () => {
  it('opens once, closes to the adjacent tab and caps restored state', () => {
    expect(openSequenceTab(['a'], 'b')).toEqual(['a', 'b']);
    expect(openSequenceTab(['a', 'b'], 'a')).toEqual(['a', 'b']);
    expect(closeSequenceTab(['a', 'b', 'c'], 'b')).toEqual({ tabs: ['a', 'c'], nextActiveId: 'c' });
    expect(closeSequenceTab(['a', 'b'], 'b')).toEqual({ tabs: ['a'], nextActiveId: 'a' });
  });

  it('persists only the current exact array shape', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    writeSequenceTabs(storage, ['a', 'b']);
    expect(readSequenceTabs(storage)).toEqual(['a', 'b']);
    values.set('vibe-cs:sequence-tabs:v1', JSON.stringify({ tabs: ['legacy'] }));
    expect(readSequenceTabs(storage)).toEqual([]);
  });
});

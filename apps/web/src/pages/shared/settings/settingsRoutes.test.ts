import { describe, expect, it } from 'vitest';

import { SETTINGS_ITEM_SECTION, settingsPath } from './settingsRoutes';

describe('settings deep links', () => {
  it('names a section for every directly addressable setting block', () => {
    expect(Object.keys(SETTINGS_ITEM_SECTION)).toEqual([
      'appearance', 'updates', 'storage', 'watch-folders', 'steam', 'game', 'map-geometry',
      'recording-defaults', 'video-output', 'model', 'conversations',
      'behavior', 'runtime', 'dependencies', 'capture', 'diagnostics', 'recovery',
    ]);
  });

  it('builds a canonical section + item address', () => {
    expect(settingsPath('dependencies')).toBe('/settings?section=advanced&item=dependencies');
    expect(settingsPath('recording-defaults')).toBe('/settings?section=game&item=recording-defaults');
    expect(settingsPath('steam')).toBe('/settings?section=files&item=steam');
    expect(settingsPath('map-geometry')).toBe('/settings?section=game&item=map-geometry');
  });
});

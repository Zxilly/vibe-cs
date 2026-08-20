import { describe, expect, it } from 'vitest';

import { SETTINGS_ITEM_SECTION, settingsPath } from './settingsRoutes';

describe('settings deep links', () => {
  it('names a section for every directly addressable setting block', () => {
    expect(Object.keys(SETTINGS_ITEM_SECTION)).toEqual([
      'appearance', 'updates', 'storage', 'watch-folders', 'game',
      'recording-defaults', 'video-output', 'model', 'conversations',
      'behavior', 'runtime', 'dependencies', 'capture', 'diagnostics',
    ]);
  });

  it('builds a canonical section + item address', () => {
    expect(settingsPath('dependencies')).toBe('/settings?section=advanced&item=dependencies');
    expect(settingsPath('recording-defaults')).toBe('/settings?section=game&item=recording-defaults');
  });
});

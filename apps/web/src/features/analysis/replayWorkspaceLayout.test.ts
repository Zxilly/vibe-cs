import { describe, expect, it } from 'vitest';

import { replayWorkspaceDensity } from './replayWorkspaceLayout';

describe('replay workspace density', () => {
  it('keeps the playback controls in the compact workspace at 1100 by 700', () => {
    expect(replayWorkspaceDensity({ width: 1_100, height: 700 })).toBe('compact');
  });

  it('keeps the native-maximized replay in the expanded workspace', () => {
    expect(replayWorkspaceDensity({ width: 2_560, height: 1_392 })).toBe('expanded');
  });
});

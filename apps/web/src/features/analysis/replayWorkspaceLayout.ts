export type ReplayViewport = {
  width: number;
  height: number;
};

export type ReplayWorkspaceDensity = 'compact' | 'expanded';

const COMPACT_REPLAY_MAX_WIDTH = 1_180;
const COMPACT_REPLAY_MAX_HEIGHT = 760;

export function replayWorkspaceDensity(viewport: ReplayViewport): ReplayWorkspaceDensity {
  return viewport.width <= COMPACT_REPLAY_MAX_WIDTH || viewport.height <= COMPACT_REPLAY_MAX_HEIGHT
    ? 'compact'
    : 'expanded';
}

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { AnalysisWorkspace } from '../../shared/desktop/dto';
import { TeamAnalysisWorkspace } from './TeamAnalysisWorkspace';

const workspace: AnalysisWorkspace = {
  demo_id: 'major-m1',
  map_name: 'de_mirage',
  tick_rate: 64,
  duration_seconds: 60,
  teams: [],
  players: [],
  rounds: [],
  highlights: [],
};

describe('TeamAnalysisWorkspace', () => {
  it('exposes an accessible local-only Round control / Economy control switch', () => {
    const markup = renderToStaticMarkup(
      <TeamAnalysisWorkspace
        workspace={workspace}
        serviceAvailable
        runtimeIdle
        watchPending={false}
        onNavigate={() => undefined}
        onWatchRound={() => undefined}
        onAddRound={() => undefined}
        onWatchEconomy={() => undefined}
        onAddEconomy={() => undefined}
      />,
    );

    expect(markup).toContain('data-testid="team-analysis-workspace"');
    expect(markup).toContain('data-state-scope="local"');
    expect(markup).toContain('role="tablist"');
    expect(markup).toMatch(/id="team-analysis-tab-rounds"[^>]*aria-selected="true"[^>]*data-testid="team-analysis-tab-rounds"/);
    expect(markup).toMatch(/id="team-analysis-tab-economy"[^>]*aria-selected="false"[^>]*data-testid="team-analysis-tab-economy"/);
    expect(markup).toMatch(/role="tabpanel"[^>]*aria-labelledby="team-analysis-tab-rounds"/);
    expect(markup).toContain('data-testid="team-round-workspace"');
    expect(markup).not.toContain('data-testid="team-economy-workspace"');
  });
});

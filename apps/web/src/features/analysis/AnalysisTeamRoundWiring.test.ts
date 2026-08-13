import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  fileURLToPath(new URL('./AnalysisPage.tsx', import.meta.url)),
  'utf8',
);

describe('analysis team round workspace wiring', () => {
  it('mounts the local Team Round / Economy switch with separate canonical actions', () => {
    expect(source).toContain("import { TeamAnalysisWorkspace } from './TeamAnalysisWorkspace';");
    expect(source).toContain("import type { TeamRoundEvidence } from './teamRoundWorkspace';");
    expect(source).toContain("import type { TeamEconomyEvidence } from './teamEconomyWorkspace';");
    expect(source).toContain("import { teamEconomyEvidenceActionContract } from './teamEconomyEvidenceActions';");
    expect(source).toContain("teams: t('analysis.tab.teams')");
    expect(source).toContain("{tab === 'teams' ? (");
    expect(source).toContain('<TeamAnalysisWorkspace');
    expect(source).toContain('onWatchRound={watchTeamRoundEvidence}');
    expect(source).toContain('onAddRound={addTeamRoundEvidence}');
    expect(source).toContain('onWatchEconomy={watchTeamEconomyEvidence}');
    expect(source).toContain('onAddEconomy={addTeamEconomyEvidence}');
  });
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  fileURLToPath(new URL('./AnalysisPage.tsx', import.meta.url)),
  'utf8',
);

describe('analysis team round workspace wiring', () => {
  it('mounts Team rounds from More with the four canonical evidence actions', () => {
    expect(source).toContain("import { TeamRoundAnalysisWorkspace } from './TeamRoundAnalysisWorkspace';");
    expect(source).toContain("import type { TeamRoundEvidence } from './teamRoundWorkspace';");
    expect(source).toContain("teams: t('analysis.tab.teams')");
    expect(source).toContain("{tab === 'teams' ? (");
    expect(source).toContain('<TeamRoundAnalysisWorkspace');
    expect(source).toContain('onWatch={watchTeamRoundEvidence}');
    expect(source).toContain('onAddProduction={addTeamRoundEvidence}');
  });
});

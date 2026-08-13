import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  fileURLToPath(new URL('./AnalysisPage.tsx', import.meta.url)),
  'utf8',
);

describe('analysis man advantage workspace wiring', () => {
  it('mounts the deep-linkable workspace with re-canonicalized Round, Replay, Watch, and Add actions', () => {
    expect(source).toContain("import { ManAdvantageAnalysisWorkspace } from './ManAdvantageAnalysisWorkspace';");
    expect(source).toContain("import type { ManAdvantageDeathEvidence } from './manAdvantageWorkspace';");
    expect(source).toContain("import { manAdvantageEvidenceActionContract } from './manAdvantageEvidenceActions';");
    expect(source).toContain("advantage: t('analysis.tab.advantage')");
    expect(source).toContain("{tab === 'advantage' ? (");
    expect(source).toContain('<ManAdvantageAnalysisWorkspace');
    expect(source).toContain('selectedRound={selectedRound}');
    expect(source).toContain('onWatch={watchManAdvantageEvidence}');
    expect(source).toContain('onAddProduction={addManAdvantageEvidence}');
    expect(source).toContain('const action = manAdvantageEvidenceActionContract(workspace, evidence,');
    expect(source).toContain('if (!action.watch.available) return;');
    expect(source).toContain('if (action.add.available && action.add.compilation) addCompilation(action.add.compilation);');
  });
});

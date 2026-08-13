import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  fileURLToPath(new URL('./AnalysisPage.tsx', import.meta.url)),
  'utf8',
);

describe('analysis objective review workspace wiring', () => {
  it('mounts the deep-linkable workspace with re-canonicalized Round, Replay, Watch, and Add actions', () => {
    expect(source).toContain("import { ObjectiveReviewAnalysisWorkspace } from './ObjectiveReviewAnalysisWorkspace';");
    expect(source).toContain("import type { ObjectiveReviewAtom } from './objectiveReviewWorkspace';");
    expect(source).toContain("import { objectiveReviewEvidenceActionContract } from './objectiveReviewEvidenceActions';");
    expect(source).toContain("objective: t('analysis.tab.objective')");
    expect(source).toContain("{tab === 'objective' ? (");
    expect(source).toContain('<ObjectiveReviewAnalysisWorkspace');
    expect(source).toContain('selectedRound={selectedRound}');
    expect(source).toContain('focusedEvidenceId={selectedEvidenceId}');
    expect(source).toContain('onWatch={watchObjectiveReviewEvidence}');
    expect(source).toContain('onAddProduction={addObjectiveReviewEvidence}');
    expect(source).toContain('const action = objectiveReviewEvidenceActionContract(workspace, evidence,');
    expect(source).toContain('if (!action.watch.available) return;');
    expect(source).toContain('if (action.add.available && action.add.compilation) addCompilation(action.add.compilation);');
  });
});

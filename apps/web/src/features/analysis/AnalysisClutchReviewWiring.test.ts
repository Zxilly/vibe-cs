import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  fileURLToPath(new URL('./AnalysisPage.tsx', import.meta.url)),
  'utf8',
);

describe('analysis clutch review workspace wiring', () => {
  it('mounts Clutch Review from More with canonical Round, Replay, Watch, and Add actions', () => {
    expect(source).toContain("import { ClutchReviewAnalysisWorkspace } from './ClutchReviewAnalysisWorkspace';");
    expect(source).toContain("import type { ClutchReviewEvidence } from './clutchReviewWorkspace';");
    expect(source).toContain("clutches: t('analysis.tab.clutches')");
    expect(source).toContain("{tab === 'clutches' ? (");
    expect(source).toContain('<ClutchReviewAnalysisWorkspace');
    expect(source).toContain('onWatch={watchClutchReviewEvidence}');
    expect(source).toContain('onAddProduction={addClutchReviewEvidence}');
    expect(source).toContain('markCompilationAdded(evidence.evidence_id)');
    expect(source).not.toContain('if (action.add.available) addHighlight(evidence.highlight)');
  });
});

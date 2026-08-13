import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  fileURLToPath(new URL('./AnalysisPage.tsx', import.meta.url)),
  'utf8',
);

describe('analysis economy workspace wiring', () => {
  it('mounts Economy from More with URL-owned filters and the four real evidence actions', () => {
    expect(source).toContain("import { EconomyAnalysisWorkspace } from './EconomyAnalysisWorkspace';");
    expect(source).toContain("import type { EconomyAtomicEvidence } from './economyEvidenceWorkspace';");
    expect(source).toContain("economy: t('analysis.tab.economy')");
    expect(source).toContain("{tab === 'economy' ? (");
    expect(source).toContain('<EconomyAnalysisWorkspace');
    expect(source).toContain('selectedPlayerId={params.has(\'player\') ? selectedPlayerId : null}');
    expect(source).toContain('selectedRound={params.has(\'round\') ? selectedRound : null}');
    expect(source).toContain('onWatch={watchEconomyEvidence}');
    expect(source).toContain('onAddProduction={addEconomyEvidence}');
  });
});

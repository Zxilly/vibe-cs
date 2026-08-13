import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(
  new URL('./OpeningDuelAnalysisWorkspace.css', import.meta.url),
  'utf8',
);

describe('opening duel workspace density contract', () => {
  it('fills the analysis viewport with independently scrolling evidence and inspector panes', () => {
    expect(styles).toMatch(/\.opening-analysis-workspace\s*\{[^}]*height:\s*100%/s);
    expect(styles).toMatch(/\.opening-analysis-canvas\s*\{[^}]*grid-template-columns:\s*minmax\(390px, \.95fr\)\s+minmax\(360px, 1\.05fr\)\s+minmax\(250px, 310px\)/s);
    expect(styles).toMatch(/\.opening-analysis-matrix__scroll\s*\{[^}]*overflow:\s*auto/s);
    expect(styles).toMatch(/\.opening-analysis-matrix table\s*\{[^}]*min-width:\s*560px/s);
    expect(styles).toMatch(/\.opening-analysis-table__rows\s*\{[^}]*overflow:\s*auto[^}]*scrollbar-gutter:\s*stable/s);
    expect(styles).toMatch(/\.opening-analysis-inspector\s*\{[^}]*overflow:\s*auto/s);
    expect(styles).toMatch(/\.opening-analysis-row\s*\{[^}]*content-visibility:\s*auto/s);
  });

  it('keeps filters, evidence rows, and inspector actions operational at 1100 by 700', () => {
    expect(styles).toMatch(/@media \(max-width:\s*1180px\) and \(max-height:\s*760px\)/);
    expect(styles).toMatch(/\.opening-analysis-filters\s*\{[^}]*grid-template-columns:\s*repeat\(4, minmax\(82px, 104px\)\)/s);
    expect(styles).toMatch(/\.opening-analysis-canvas\s*\{[^}]*grid-template-areas:\s*"matrix inspector"\s*"evidence inspector"/s);
    expect(styles).toMatch(/\.opening-analysis-inspector footer \.button\s*\{[^}]*min-width:\s*28px/s);
    expect(styles).toMatch(/\.page--analysis \.analysis-layout:has\(\.opening-analysis-workspace\)\s*\{[^}]*height:\s*calc\(100dvh - 118px\)/s);
  });
});

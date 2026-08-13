import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./DuelAnalysisWorkspace.css', import.meta.url), 'utf8');

describe('duel workspace density contract', () => {
  it('uses the full analysis viewport with independently scrolling matchup and evidence panes', () => {
    expect(styles).toMatch(/\.duel-analysis-workspace\s*\{[^}]*height:\s*100%/s);
    expect(styles).toMatch(/\.duel-analysis-canvas\s*\{[^}]*grid-template-columns:\s*minmax\(300px, 360px\)\s+minmax\(0, 1fr\)/s);
    expect(styles).toMatch(/\.duel-analysis-matchups\s*>\s*div\s*\{[^}]*overflow:\s*auto[^}]*scrollbar-gutter:\s*stable/s);
    expect(styles).toMatch(/\.duel-analysis-evidence__rows\s*\{[^}]*overflow:\s*auto[^}]*scrollbar-gutter:\s*stable/s);
    expect(styles).toMatch(/\.duel-analysis-evidence-row\s*\{[^}]*content-visibility:\s*auto/s);
  });

  it('keeps all filters and icon actions operational at 1100 by 700', () => {
    expect(styles).toMatch(/@media \(max-width:\s*1180px\) and \(max-height:\s*760px\)/);
    expect(styles).toMatch(/\.duel-analysis-filters\s*\{[^}]*grid-template-columns:\s*repeat\(3, minmax\(92px, 112px\)\)/s);
    expect(styles).toMatch(/\.duel-analysis-actions\s+\.button\s*\{[^}]*width:\s*29px/s);
  });
});

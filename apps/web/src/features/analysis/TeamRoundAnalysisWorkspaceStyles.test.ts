import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(
  new URL('./TeamRoundAnalysisWorkspace.css', import.meta.url),
  'utf8',
);

describe('team round workspace density contract', () => {
  it('fills the maximum analysis viewport with three independently bounded panes', () => {
    expect(styles).toMatch(/\.team-round-workspace\s*\{[^}]*height:\s*100%/s);
    expect(styles).toMatch(/\.team-round-canvas\s*\{[^}]*grid-template-columns:\s*minmax\(250px, 300px\) minmax\(360px, 1fr\) minmax\(250px, 300px\)/s);
    expect(styles).toMatch(/\.team-round-matrix__grid\s*\{[^}]*overflow:\s*auto/s);
    expect(styles).toMatch(/\.team-round-evidence__rows\s*\{[^}]*overflow:\s*auto[^}]*scrollbar-gutter:\s*stable/s);
    expect(styles).toMatch(/\.team-round-inspector__body\s*\{[^}]*overflow:\s*auto/s);
    expect(styles).toMatch(/\.team-round-evidence-row\s*\{[^}]*content-visibility:\s*auto/s);
  });

  it('keeps the matrix, evidence, inspector, and four actions operational at 1100 by 700', () => {
    expect(styles).toMatch(/@media \(max-width:\s*1180px\) and \(max-height:\s*760px\)/);
    expect(styles).toMatch(/\.team-round-canvas\s*\{[^}]*grid-template-columns:\s*minmax\(220px, 250px\) minmax\(330px, 1fr\) minmax\(225px, 250px\)/s);
    expect(styles).toMatch(/\.team-round-inspector footer\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/s);
    expect(styles).toMatch(/\.team-round-inspector footer \.button\s*\{[^}]*min-width:\s*28px/s);
    expect(styles).toMatch(/\.page--analysis \.analysis-layout:has\(\.team-round-workspace\)\s*\{[^}]*height:\s*calc\(100dvh - 118px\)/s);
  });
});

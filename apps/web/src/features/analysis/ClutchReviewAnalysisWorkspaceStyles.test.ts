import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(
  new URL('./ClutchReviewAnalysisWorkspace.css', import.meta.url),
  'utf8',
);

describe('clutch review workspace density contract', () => {
  it('fills the maximum analysis viewport with bounded evidence and inspector panes', () => {
    expect(styles).toMatch(/\.clutch-review-workspace\s*\{[^}]*height:\s*100%/s);
    expect(styles).toMatch(/\.clutch-review-canvas\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(280px, 320px\)/s);
    expect(styles).toMatch(/\.clutch-review-evidence__rows\s*\{[^}]*overflow:\s*auto[^}]*scrollbar-gutter:\s*stable/s);
    expect(styles).toMatch(/\.clutch-review-inspector__body\s*\{[^}]*overflow:\s*auto/s);
    expect(styles).toMatch(/\.clutch-review-evidence-row\s*\{[^}]*content-visibility:\s*auto/s);
  });

  it('keeps evidence, inspector, and all four actions operational at 1100 by 700', () => {
    expect(styles).toMatch(/@media \(max-width:\s*1180px\) and \(max-height:\s*760px\)/);
    expect(styles).toMatch(/\.clutch-review-canvas\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(225px, 250px\)/s);
    expect(styles).toMatch(/\.clutch-review-inspector footer\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/s);
    expect(styles).toMatch(/\.clutch-review-inspector footer \.button\s*\{[^}]*min-width:\s*28px/s);
    expect(styles).toMatch(/\.page--analysis \.analysis-layout:has\(\.clutch-review-workspace\)\s*\{[^}]*height:\s*calc\(100dvh - 118px\)/s);
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(
  new URL('./ManAdvantageAnalysisWorkspace.css', import.meta.url),
  'utf8',
);

describe('man advantage workspace density contract', () => {
  it('keeps the matrix, round strip, state stream, and inspector locally scrollable at 1100 by 700', () => {
    expect(styles).toMatch(/\.man-advantage-workspace\s*\{[^}]*height:\s*100%/s);
    expect(styles).toMatch(/@media \(max-width:\s*1180px\) and \(max-height:\s*760px\)/);
    expect(styles).toMatch(/\.man-advantage-matrix__grid\s*\{[^}]*overflow-x:\s*auto/s);
    expect(styles).toMatch(/\.man-advantage-rounds__list\s*\{[^}]*overflow-x:\s*auto[^}]*overflow-y:\s*hidden/s);
    expect(styles).toMatch(/\.man-advantage-stream__rows,[^{]*\.man-advantage-inspector__body\s*\{[^}]*overflow:\s*auto[^}]*scrollbar-gutter:\s*stable/s);
    expect(styles).toMatch(/\.man-advantage-canvas\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\)/s);
    expect(styles).toMatch(/\.man-advantage-inspector\s*\{[^}]*display:\s*none/s);
    expect(styles).toMatch(/\.man-advantage-inspector-trigger\s*\{[^}]*display:\s*inline-flex/s);
    expect(styles).not.toContain('.drawer__footer:has([data-action])');
    expect(styles).toMatch(/\.man-advantage-actions\s*\{[^}]*display:\s*grid/s);
  });
});

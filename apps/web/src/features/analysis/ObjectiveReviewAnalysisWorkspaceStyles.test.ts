import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(
  new URL('./ObjectiveReviewAnalysisWorkspace.css', import.meta.url),
  'utf8',
);

describe('objective review workspace density contract', () => {
  it('bounds a three-column maximum workspace and moves the inspector into a 1100 by 700 Drawer', () => {
    expect(styles).toMatch(/\.objective-review-workspace\s*\{[^}]*height:\s*100%/s);
    expect(styles).toMatch(/\.objective-review-canvas\s*\{[^}]*grid-template-columns:\s*minmax\(148px, 174px\) minmax\(0, 1fr\) minmax\(294px, 334px\)[^}]*overflow:\s*hidden/s);
    expect(styles).toMatch(/\.objective-review-rounds__list,[^{]*\.objective-review-stream__body,[^{]*\.objective-review-inspector__body\s*\{[^}]*overflow:\s*auto[^}]*scrollbar-gutter:\s*stable/s);
    expect(styles).toMatch(/@media \(max-width:\s*1180px\) and \(max-height:\s*760px\)/);
    expect(styles).toMatch(/\.objective-review-canvas\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\)/s);
    expect(styles).toMatch(/\.objective-review-rounds__list\s*\{[^}]*overflow-x:\s*auto[^}]*overflow-y:\s*hidden/s);
    expect(styles).toMatch(/\.objective-review-inspector\s*\{[^}]*display:\s*none/s);
    expect(styles).toMatch(/\.objective-review-inspector-trigger\s*\{[^}]*display:\s*inline-flex/s);
    expect(styles).not.toContain('.drawer__footer:has([data-action])');
  });
});

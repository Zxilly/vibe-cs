import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
  fileURLToPath(new URL('./HighlightAnnotationReviewControl.css', import.meta.url)),
  'utf8',
);

describe('highlight annotation review styles', () => {
  it('wraps the third card action and keeps it operable at narrow widths', () => {
    expect(css).toContain('flex-wrap: wrap');
    expect(css).toContain("[data-action='review-annotations']");
    expect(css).toContain('@media (max-width: 620px)');
    expect(css).toContain('width: 100%');
  });
});

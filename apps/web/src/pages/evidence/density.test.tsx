/*
 * `markup` project — 「05 证据检索」 at the volumes §10.3 measured against.
 *
 * The phase-2 review's exit rule for a page is three-part: the horizontal and
 * vertical scroll must happen inside a container (never on `body`), anything
 * too long must truncate rather than push its neighbours out, and anything
 * paged must print the total. 「静默截断是 bug」.
 *
 * The numbers come from `domain/densityFixtures.ts`, which is where the real
 * volumes were written down with their provenance.
 */

import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { EVIDENCE_SEARCH_HITS, NORMALIZED_EVIDENCE_TOTAL } from '../../domain/densityFixtures';
import { renderMarkup } from '../../test/render';
import { EvidenceResults } from './EvidenceResults';
import { EVIDENCE_PAGE_SIZE } from './evidenceSearchParams';
import { evidenceItems } from './test/fixtures';

function render(node: Parameters<typeof renderMarkup>[0]): string {
  return renderMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

const base = {
  perspective: {},
  page: 1,
  onPageChange: () => undefined,
  activeId: '',
  onSelect: () => undefined,
  onLocate: () => undefined,
  onAddToVideo: () => undefined,
};

describe('a full page of results', () => {
  const html = render(
    <EvidenceResults
      {...base}
      rows={evidenceItems(EVIDENCE_PAGE_SIZE)}
      total={NORMALIZED_EVIDENCE_TOTAL}
    />,
  );

  it('renders one page, not the corpus', () => {
    // 1 284 632 rows in the index; 20 in the DOM.
    expect(html.match(/data-evidence-row="/gu)).toHaveLength(EVIDENCE_PAGE_SIZE);
  });

  it('prints the corpus total in the footer, so the page is not a silent cut', () => {
    expect(html).toContain(`命中 ${String(NORMALIZED_EVIDENCE_TOTAL)} 条`);
  });

  it('stays a size a 1100 × 700 window can paint', () => {
    // The comparable bound `domain/map/density.test.tsx` set for `PathLayer` is
    // 1 MB–8 MB and it is the *problem* case; a results page should be an order
    // of magnitude under it.
    expect(html.length).toBeLessThan(400_000);
  });

  it('keeps both scroll axes inside the list', () => {
    // `base.css` sets `overflow: hidden` on body, so a scroll that escapes here
    // does not scroll — it clips.
    expect(html).toMatch(/<ul[^>]*overflow-y-auto/u);
    expect(html).toMatch(/<ul[^>]*overscroll-y-contain/u);
  });

  it('truncates the long free-text fields rather than pushing the row wide', () => {
    expect(html).toContain('truncate');
  });
});

describe('the artboard s own hit count', () => {
  it('pages 47 hits into three pages and says so', () => {
    const html = render(
      <EvidenceResults {...base} rows={evidenceItems(EVIDENCE_PAGE_SIZE)} total={EVIDENCE_SEARCH_HITS} />,
    );
    expect(html).toContain(`命中 ${String(EVIDENCE_SEARCH_HITS)} 条`);
    expect(html).toContain('第 1–20 条');
    expect(html).toContain('aria-label="第 3 页"');
  });
});

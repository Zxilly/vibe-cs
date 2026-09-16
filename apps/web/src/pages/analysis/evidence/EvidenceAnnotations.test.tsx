/*
 * `markup` project — the 注释 face's list and Inspector.
 *
 * The list spans every match, so the assertions are about identity: each row
 * says which match and map it belongs to, the current row is marked, and the
 * state action reads the state it would move the note *to*.
 */

import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../../test/render';
import { EvidenceAnnotationDetail } from './EvidenceAnnotationDetail';
import { EvidenceAnnotations } from './EvidenceAnnotations';
import { annotation } from './test/fixtures';

function render(node: Parameters<typeof renderMarkup>[0]): string {
  return renderMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

const base = {
  total: 2,
  page: 1,
  onPageChange: () => undefined,
  activeId: '',
  onSelect: () => undefined,
  onOpen: () => undefined,
  onToggleReviewState: () => undefined,
};

const rows = [
  annotation(),
  annotation({
    id: 'ann-2',
    demo_id: 'vitality-g2',
    demo_display_name: 'Vitality vs G2',
    map_name: 'de_inferno',
    body: '这波回防太慢。',
    tags: [],
    review_state: 'resolved',
  }),
];

describe('the list', () => {
  const html = render(<EvidenceAnnotations {...base} rows={rows} />);

  it('names the match and the map on every row — the index spans matches', () => {
    expect(html).toContain('Aurora vs Meridian');
    expect(html).toContain('de_mirage');
    expect(html).toContain('Vitality vs G2');
    expect(html).toContain('de_inferno');
  });

  it('makes each row selectable with a real button', () => {
    expect(html.match(/data-annotation-select=""/gu)).toHaveLength(2);
    expect(html).toContain('hover:bg-surface');
  });

  it('offers the action that changes the state, not the state the note is in', () => {
    // ann-1 is open → 标记已处理; ann-2 is resolved → 重新打开.
    expect(html).toContain('标记已处理');
    expect(html).toContain('重新打开');
  });

  it('marks the current row with aria-current and the accent plate', () => {
    const selected = render(<EvidenceAnnotations {...base} rows={rows} activeId="ann-2" />);
    expect(selected).toMatch(/data-annotation="ann-2"[^>]*aria-current="true"/u);
    expect(selected).toContain('bg-accent-100');
  });
});

describe('the Inspector', () => {
  it('describes the current note, not a search hit', () => {
    const html = render(
      <EvidenceAnnotationDetail
        annotation={rows[1] as NonNullable<(typeof rows)[1]>}
        onOpenWorkspace={() => undefined}
        onToggleReviewState={() => undefined}
      />,
    );
    expect(html).toContain('注释详情');
    expect(html).toContain('Vitality vs G2');
    expect(html).toContain('de_inferno');
    expect(html).toContain('这波回防太慢。');
    expect(html).toContain('已处理');
    expect(html).toContain('重新打开');
    expect(html).toContain('在比赛工作区打开');
  });

  it('keeps the panel when there is no note to describe', () => {
    const html = render(
      <EvidenceAnnotationDetail
        annotation={null}
        onOpenWorkspace={() => undefined}
        onToggleReviewState={() => undefined}
      />,
    );
    expect(html).toContain('data-inspector="docked"');
    expect(html).toContain('还没有选中注释');
  });
});

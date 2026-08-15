import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { Pagination } from './Pagination';

function textOf(html: string): string {
  return html.replaceAll(/<[^>]*>/gu, '');
}

describe('Pagination', () => {
  it('is a labelled landmark on the §3.4 bar height', () => {
    const html = renderMarkup(<Pagination page={1} pageSize={20} total={248} onPageChange={() => {}} />);
    expect(html).toContain('<nav');
    expect(html).toContain('aria-label="分页"');
    expect(html).toContain('h-[var(--h-bar)]');
  });

  it('states the total and the span of the page', () => {
    const html = renderMarkup(<Pagination page={3} pageSize={20} total={248} onPageChange={() => {}} />);
    const text = textOf(html);
    expect(text).toContain('共 248 条');
    expect(text).toContain('第 41–60 条');
  });

  it('takes a page-specific count in place of 共 N 条', () => {
    // 「05 证据检索」writes its own: "命中 47 条 · 排序：时间倒序".
    const html = renderMarkup(
      <Pagination page={1} pageSize={20} total={47} summary="命中 47 条" onPageChange={() => {}} />,
    );
    expect(textOf(html)).toContain('命中 47 条');
    expect(textOf(html)).not.toContain('共 47 条');
  });

  it('says nothing about a span when there are no rows', () => {
    const html = renderMarkup(<Pagination page={1} pageSize={20} total={0} onPageChange={() => {}} />);
    expect(textOf(html)).toContain('共 0 条');
    expect(textOf(html)).not.toContain('第 0');
  });

  it('marks the current page and labels every button', () => {
    const html = renderMarkup(<Pagination page={3} pageSize={20} total={248} onPageChange={() => {}} />);
    expect(html.match(/aria-current="page"/gu)).toHaveLength(1);
    expect(html).toContain('aria-label="第 3 页"');
    expect(html).toContain('aria-label="上一页"');
    expect(html).toContain('aria-label="下一页"');
  });

  it('disables the step buttons at the ends rather than removing them', () => {
    // Spec §8: a blocked action stays visible.
    const first = renderMarkup(<Pagination page={1} pageSize={20} total={248} onPageChange={() => {}} />);
    expect(first).toContain('aria-label="上一页"');
    expect(first.match(/disabled=""/gu)).toHaveLength(1);

    const last = renderMarkup(<Pagination page={13} pageSize={20} total={248} onPageChange={() => {}} />);
    expect(last.match(/disabled=""/gu)).toHaveLength(1);

    const middle = renderMarkup(<Pagination page={5} pageSize={20} total={248} onPageChange={() => {}} />);
    expect(middle.match(/disabled=""/gu)).toBeNull();
  });

  it('keeps the same number of slots on every page, so the bar never reflows', () => {
    const widths = [1, 2, 6, 12, 13].map((page) => {
      const html = renderMarkup(<Pagination page={page} pageSize={20} total={248} onPageChange={() => {}} />);
      return (html.match(/aria-label="第 /gu)?.length ?? 0) + (html.match(/…/gu)?.length ?? 0);
    });
    expect(new Set(widths).size).toBe(1);
  });

  it('hides the ellipsis from assistive tech', () => {
    const html = renderMarkup(<Pagination page={6} pageSize={20} total={248} onPageChange={() => {}} />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('…');
  });

  it('clamps an out-of-range page instead of rendering an empty bar', () => {
    const html = renderMarkup(<Pagination page={99} pageSize={20} total={41} onPageChange={() => {}} />);
    expect(textOf(html)).toContain('第 41–41 条');
    expect(html).toContain('aria-current="page"');
  });
});

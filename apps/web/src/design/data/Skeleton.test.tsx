import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { Skeleton, TableSkeleton } from './Skeleton';

function textOf(html: string): string {
  return html.replaceAll(/<[^>]*>/gu, '');
}

describe('Skeleton', () => {
  it('is decorative and carries no text', () => {
    const html = renderMarkup(<Skeleton width="40%" />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('width:40%');
    expect(textOf(html)).toBe('');
  });
});

describe('TableSkeleton', () => {
  it('announces itself as busy without naming a percentage', () => {
    const html = renderMarkup(<TableSkeleton />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="加载中"');
  });

  it('draws the artboard’s lead-in bar plus four rows', () => {
    const html = renderMarkup(<TableSkeleton />);
    // One 12px lead-in at 40%, then 10px rows at 100 / 92 / 96 / 88 percent.
    expect(html.match(/width:40%/gu)).toHaveLength(1);
    expect(html).toContain('width:100%');
    expect(html).toContain('width:92%');
    expect(html).toContain('width:96%');
    expect(html).toContain('width:88%');
  });

  it('cycles the row widths so any row count keeps the rhythm', () => {
    const html = renderMarkup(<TableSkeleton rows={6} />);
    expect(html.match(/width:100%/gu)).toHaveLength(2);
    expect(html.match(/width:92%/gu)).toHaveLength(2);
  });

  it('shows the stage name and nothing numeric — the artboard forbids a fabricated percentage', () => {
    const html = renderMarkup(<TableSkeleton stage="正在解析回合" />);
    const text = textOf(html);
    expect(text).toContain('正在解析回合');
    // "不显示虚构百分比" / "有真实分母时才用进度条，否则只给阶段名".
    expect(text).not.toMatch(/\d/u);
    expect(html).not.toContain('role="progressbar"');
    expect(html).not.toContain('aria-valuenow');
  });

  it('renders no rows when asked for none', () => {
    const html = renderMarkup(<TableSkeleton rows={0} />);
    expect(html.match(/width:100%/gu)).toBeNull();
  });
});

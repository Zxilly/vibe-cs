import { Trans } from '@lingui/react/macro';
import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { SelectionBar } from './SelectionBar';

describe('SelectionBar', () => {
  it('draws the accent-100 strip of 02 Demo 资料库', () => {
    const html = renderMarkup(
      <SelectionBar
        summary={<Trans>已选 3 场 · 上限 12 场</Trans>}
        primary={
          <button type="button">
            <Trans>分析选中的 3 场</Trans>
          </button>
        }
      >
        <button type="button">
          <Trans>添加标签</Trans>
        </button>
        <button type="button">
          <Trans>删除记录</Trans>
        </button>
      </SelectionBar>,
    );

    expect(html).toContain('data-selection-bar');
    expect(html).toContain('bg-accent-100');
    expect(html).toContain('h-[var(--h-bar)]');
    expect(html).toContain('已选 3 场 · 上限 12 场');
    expect(html).toContain('data-selection-actions');
    expect(html).toContain('data-selection-primary');
  });

  it('announces the count politely when it changes', () => {
    // <output> is role=status, i.e. aria-live=polite: the selection changes
    // from clicks elsewhere on the page, and the strip has to say so without
    // interrupting whatever the reader is on.
    const html = renderMarkup(<SelectionBar summary={<Trans>已选 2 条</Trans>} />);

    expect(html).toContain('<output data-selection-summary');
  });

  it('renders without actions', () => {
    const html = renderMarkup(<SelectionBar summary={<Trans>已选 1 场</Trans>} />);

    expect(html).not.toContain('data-selection-actions');
    expect(html).not.toContain('data-selection-primary');
  });
});

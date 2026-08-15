import { Trans } from '@lingui/react/macro';
import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { SplitPane } from './SplitPane';

describe('SplitPane', () => {
  it('draws the 520px 任务记录 column of 11 输出与任务记录', () => {
    const html = renderMarkup(
      <SplitPane
        asideLabel="任务记录"
        aside={
          <p>
            <Trans>分析 · 下载 · 录制 · 导出</Trans>
          </p>
        }
      >
        <p>
          <Trans>34 个输出</Trans>
        </p>
      </SplitPane>,
    );

    expect(html).toContain('data-split-pane');
    expect(html).toContain('data-split-aside="end"');
    expect(html).toContain('aria-label="任务记录"');
    expect(html).toContain('w-[var(--w-split)]');
    expect(html).toContain('border-l border-divider');
  });

  it('puts the companion first when it is the workspace rail', () => {
    const html = renderMarkup(
      <SplitPane asideLabel="视图导航" asideSide="start" asideWidth="subnav" aside={<nav />}>
        <p>x</p>
      </SplitPane>,
    );

    expect(html.indexOf('data-split-aside')).toBeLessThan(html.indexOf('data-split-content'));
    expect(html).toContain('w-[var(--w-subnav)]');
    expect(html).toContain('border-r border-divider');
  });

  it('offers only the §3.5 widths', () => {
    for (const [width, token] of [
      ['panel', '--w-panel'],
      ['inspector', '--w-inspector'],
      ['inspector-wide', '--w-inspector-wide'],
    ] as const) {
      const html = renderMarkup(
        <SplitPane asideLabel="面板" asideWidth={width} aside={<div />}>
          <p>x</p>
        </SplitPane>,
      );
      expect(html).toContain(`w-[var(${token})]`);
    }
  });

  it('keeps the content column from pushing the companion off-screen', () => {
    // Without min-w-0 a wide table or a long monospace path grows the flex
    // item past its basis and squeezes the fixed column out.
    const html = renderMarkup(
      <SplitPane asideLabel="任务记录" aside={<div />}>
        <p>x</p>
      </SplitPane>,
    );

    const content = html.slice(html.indexOf('data-split-content'));
    expect(content.slice(0, 120)).toContain('min-w-0');
  });
});

import { Trans } from '@lingui/react/macro';
import { describe, expect, it } from 'vitest';

import { PANEL_WIDTH_PX } from '../tokens.data';
import { renderMarkup } from '../../test/render';
import { SplitPane } from './SplitPane';

/** The width the companion panel actually opens at. */
function asideBasis(html: string): string | undefined {
  const panel = /<div[^>]*id="aside"[^>]*>/u.exec(html)?.[0] ?? '';
  return /flex-basis:([^;"]+)/u.exec(panel)?.[1];
}

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
    /* The §3.5 token is still where the pane opens — in real pixels, which is
       what makes 「520px」 mean 520px at every window size. */
    expect(asideBasis(html)).toBe(`${String(PANEL_WIDTH_PX['--w-split'])}px`);
    expect(html).toContain('border-l border-divider');
  });

  it('puts the companion first when it is the workspace rail', () => {
    const html = renderMarkup(
      <SplitPane asideLabel="视图导航" asideSide="start" asideWidth="subnav" aside={<nav />}>
        <p>x</p>
      </SplitPane>,
    );

    expect(html.indexOf('data-split-aside')).toBeLessThan(html.indexOf('data-split-content'));
    expect(asideBasis(html)).toBe(`${String(PANEL_WIDTH_PX['--w-subnav'])}px`);
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
      expect(asideBasis(html)).toBe(`${String(PANEL_WIDTH_PX[token])}px`);
    }
  });

  /* A default and a ceiling are different things — see the component header.
     The handle is a real separator, so it is reachable and operable without a
     pointer. */
  it('puts a keyboard-operable separator between the two columns', () => {
    const html = renderMarkup(
      <SplitPane asideLabel="任务记录" aside={<div />}>
        <p>x</p>
      </SplitPane>,
    );

    expect(html).toContain('data-split-handle');
    expect(html).toContain('role="separator"');
    expect(html).toContain('tabindex="0"');
    // Named for the column it sizes, so the control is not an unlabelled seam.
    expect(html).toMatch(/data-split-handle[^>]*|aria-label="任务记录"/u);
  });

  it('pins the column when the page says the width is not the user’s', () => {
    const html = renderMarkup(
      <SplitPane asideLabel="视图导航" asideWidth="subnav" fixed aside={<nav />}>
        <p>x</p>
      </SplitPane>,
    );

    expect(html).not.toContain('data-split-handle');
    expect(html).not.toContain('role="separator"');
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

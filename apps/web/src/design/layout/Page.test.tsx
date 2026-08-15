import { Trans } from '@lingui/react/macro';
import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { Page } from './Page';
import { SelectionBar } from './SelectionBar';
import { Toolbar } from './Toolbar';

describe('Page', () => {
  it('stacks the four slots of the 02 资料库 skeleton in order', () => {
    const html = renderMarkup(
      <Page
        toolbar={<Toolbar title={<Trans>Demo 资料库</Trans>} collapsed={false} />}
        bar={
          <div>
            <Trans>地图：Mirage</Trans>
          </div>
        }
        footer={<SelectionBar summary={<Trans>已选 3 场 · 上限 12 场</Trans>} />}
      >
        <table />
      </Page>,
    );

    const order = ['data-page-toolbar', 'data-page-bar', 'data-page-body', 'data-page-footer'];
    const positions = order.map((marker) => html.indexOf(marker));
    expect(positions.every((position) => position > -1)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('omits the slots a page does not use', () => {
    const html = renderMarkup(
      <Page>
        <p>
          <Trans>恢复中心</Trans>
        </p>
      </Page>,
    );

    expect(html).toContain('data-page-body');
    expect(html).not.toContain('data-page-toolbar');
    expect(html).not.toContain('data-page-bar');
    expect(html).not.toContain('data-page-footer');
  });

  it('owns the scroll boundary, and hands it over on request', () => {
    // base.css hides overflow on <body>: the window is the viewport and panes
    // scroll, so exactly one element per page may scroll — this one.
    expect(renderMarkup(<Page>x</Page>)).toContain('overflow-auto');
    expect(renderMarkup(<Page scroll={false}>x</Page>)).toContain('overflow-hidden');
  });
});

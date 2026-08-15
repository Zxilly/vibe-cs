/*
 * `markup` project — 「证据详情」.
 *
 * The panel's job is to be exact about what it knows *and* about what it does
 * not: the artboard draws 距离 and 交战轴, the index sends neither, and the
 * difference between "not rendered" and "rendered as 0.0m" is the whole point.
 */

import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { TICK_GROUP_SEPARATOR } from '../../domain/match';
import { renderMarkup } from '../../test/render';
import { EvidenceDetail } from './EvidenceDetail';
import { evidenceItem } from './test/fixtures';

function render(node: Parameters<typeof renderMarkup>[0]): string {
  return renderMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

const handlers = {
  onOpenWorkspace: () => undefined,
  onLocate: () => undefined,
  onAddToVideo: () => undefined,
};

describe('with nothing selected', () => {
  const html = render(<EvidenceDetail {...handlers} row={null} />);

  it('still renders the panel, so the column does not appear and disappear', () => {
    expect(html).toContain('data-inspector="docked"');
    expect(html).toContain('证据详情');
  });

  it('says what a click will do rather than showing an empty frame', () => {
    expect(html).toContain('还没有选中证据');
  });
});

describe('with a row selected', () => {
  const html = render(<EvidenceDetail {...handlers} row={evidenceItem()} />);

  it('names the moment down to the tick', () => {
    expect(html).toContain('Kael');
    expect(html).toContain('Corvin');
    expect(html).toContain('Aurora vs Meridian');
    expect(html).toContain('de_mirage');
    expect(html).toContain('第 21 回合');
    // `formatTickCount` groups with a thin space (U+2009) so the number cannot
    // break across lines; the panel prints the grouped form verbatim.
    expect(html).toContain(`tick 149${TICK_GROUP_SEPARATOR}380`);
  });

  it('reports the qualifiers the projector recorded', () => {
    expect(html).toContain('穿墙');
    expect(html).toContain('爆头');
  });

  it('reports whether there is spatial evidence, instead of dropping the field', () => {
    expect(html).toContain('空间证据');
    expect(html).toContain('可用');
  });

  it('carries 在比赛工作区打开 as the panel s main action', () => {
    expect(html).toContain('data-inspector-footer');
    expect(html).toContain('在比赛工作区打开');
    expect(html).toContain('2D 回放定位');
  });

  it('prints no distance and no engagement axis — the index sends neither', () => {
    expect(html).not.toContain('距离');
    expect(html).not.toContain('交战轴');
  });
});

describe('a row with no position', () => {
  it('says 不可用 rather than hiding the field', () => {
    const html = render(<EvidenceDetail {...handlers} row={evidenceItem({ attributes: {} })} />);
    expect(html).toContain('空间证据');
    expect(html).toContain('不可用');
  });
});

describe('the annotation block', () => {
  it('disables the editor and says why, rather than hiding it', () => {
    const html = render(
      <EvidenceDetail {...handlers} row={evidenceItem()} annotateDisabledReason="写入尚未接通" />,
    );
    expect(html).toContain('写注释');
    expect(html).toContain('写入尚未接通');
    expect(html).toContain('disabled=""');
  });
});

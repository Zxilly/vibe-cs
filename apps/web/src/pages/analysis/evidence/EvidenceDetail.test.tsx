/*
 * `markup` project — 「证据详情」.
 *
 * The panel's job is to be exact about what it knows *and* about what it does
 * not: the artboard draws 距离 and 交战轴, the index sends neither, and the
 * difference between "not rendered" and "rendered as 0.0m" is the whole point.
 */

import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { TICK_GROUP_SEPARATOR } from '../../../domain/match';
import { renderMarkup } from '../../../test/render';
import { EvidenceDetail } from './EvidenceDetail';
import { annotation, evidenceItem } from './test/fixtures';

function render(node: Parameters<typeof renderMarkup>[0]): string {
  return renderMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

const handlers = {
  onOpenWorkspace: () => undefined,
  onLocate: () => undefined,
  onAddToVideo: () => undefined,
  onCreateNote: () => Promise.resolve(),
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
    // `formatTickCount` groups with a narrow no-break space (U+202F) so the
    // number cannot break across lines; the panel prints the grouped form
    // verbatim and keeps 「tick」 glued to it.
    expect(TICK_GROUP_SEPARATOR).toBe('\u202f');
    expect(html).toMatch(/whitespace-nowrap[^>]*>tick 149\u202f380</u);
  });

  it('reports the qualifiers the projector recorded', () => {
    expect(html).toContain('穿墙');
    expect(html).toContain('爆头');
  });

  it('names the kind of event and the weapon by its product name', () => {
    expect(html).toContain('事件');
    expect(html).toContain('击杀');
    expect(html).toContain('AK-47');
    expect(html).not.toContain('ak47');
  });

  it('spells out a row the glyph alone would not explain', () => {
    const purchase = render(
      <EvidenceDetail {...handlers} row={evidenceItem({ event_type: 'purchase', weapon: 'Kevlar Vest' })} />,
    );
    expect(purchase).toContain('购买');
    const roundStart = render(
      <EvidenceDetail {...handlers} row={evidenceItem({ event_type: 'round_start', actor_name: null, actor_id: null, target_name: null, target_id: null })} />,
    );
    expect(roundStart).toContain('回合开始');
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
  it('says the row has no notes, and offers to write one', () => {
    const html = render(<EvidenceDetail {...handlers} row={evidenceItem()} />);
    expect(html).toContain('这条证据还没有注释');
    expect(html).toContain('data-evidence-note-composer');
    expect(html).toContain('写注释');
  });

  it('lists the notes the row already carries, with their state', () => {
    const html = render(
      <EvidenceDetail
        {...handlers}
        row={evidenceItem()}
        notes={[annotation(), annotation({ id: 'ann-2', body: '第二条', review_state: 'resolved' })]}
      />,
    );
    expect(html).not.toContain('这条证据还没有注释');
    expect(html).toContain('这堵墙的穿点可以单独做一条教学。');
    expect(html).toContain('第二条');
    expect(html).toContain('待处理');
    expect(html).toContain('已处理');
  });

  it('shows a failed write in place with a way to dismiss it', () => {
    const html = render(
      <EvidenceDetail
        {...handlers}
        row={evidenceItem()}
        noteError="服务未启动"
        onDismissNoteError={() => undefined}
      />,
    );
    expect(html).toContain('注释没有写成功：服务未启动');
    expect(html).toContain('知道了');
  });
});

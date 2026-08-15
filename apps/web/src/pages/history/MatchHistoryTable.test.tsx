/*
 * `markup` project — the Steam match table.
 *
 * The table is where the derived 已过期 state has to become visible, and where
 * the artboard's rule about *which* rows can be queued turns into disabled
 * checkboxes rather than missing ones.
 */

import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { MatchHistoryTable } from './MatchHistoryTable';
import { NOW, matchHistoryItem, matchHistoryRows } from './test/fixtures';

function render(node: Parameters<typeof renderMarkup>[0]): string {
  return renderMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

const base = {
  stateOptions: { now: NOW },
  selected: new Set<string>(),
  onSelectedChange: () => undefined,
  onDownload: () => undefined,
  onCancel: () => undefined,
};

describe('the artboard s five rows', () => {
  const html = render(<MatchHistoryTable {...base} rows={matchHistoryRows()} />);

  it('renders the columns the artboard draws', () => {
    expect(html).toContain('比赛');
    expect(html).toContain('地图');
    expect(html).toContain('时间');
    expect(html).toContain('比分');
    expect(html).toContain('13 : 11');
  });

  it('labels each state the way the artboard labels it', () => {
    expect(html).toContain('已入库');
    expect(html).toContain('未下载');
    expect(html).toContain('下载中');
    expect(html).toContain('已过期 · Valve 不再保留');
  });

  it('offers the action that fits each state', () => {
    expect(html).toContain('打开工作区');
    expect(html).toContain('下载');
    expect(html).toContain('取消');
  });

  it('gives a downloaded demo a link into its workspace', () => {
    expect(html).toContain('href="/match/aurora"');
  });

  it('reports a download with no denominator as a stage, not a bar', () => {
    // 「有真实分母时才用进度条，否则只给阶段名」 — `MatchHistoryItem` has no
    // progress field; the job record that does is a different read.
    expect(html).not.toContain('role="progressbar"');
    expect(html).not.toMatch(/>\s*\d+\s*%/u);
  });
});

describe('a failed download', () => {
  it('is its own state, with the service s reason on the row', () => {
    const html = render(
      <MatchHistoryTable
        {...base}
        rows={[matchHistoryItem({ demo_status: 'failed', demo_id: null, last_error: '磁盘已满' })]}
      />,
    );
    expect(html).toContain('下载失败');
    expect(html).toContain('磁盘已满');
    // A retry is still worth offering.
    expect(html).toContain('下载');
  });
});

describe('the selection', () => {
  it('draws a select-all box, because this table has no cap', () => {
    // Unlike 资料库's 「上限 12 场」 and 玩家目录's 「比较上限 2 名」, the artboard
    // states no bound here — so there is nothing for a select-all to contradict.
    const html = render(<MatchHistoryTable {...base} rows={matchHistoryRows()} />);
    expect(html).toContain('全选本页');
  });
});

describe('an unavailable action', () => {
  it('disables the row action and says why, rather than removing it', () => {
    const html = render(
      <MatchHistoryTable
        {...base}
        rows={matchHistoryRows()}
        actionDisabledReason="尚未接通"
      />,
    );
    expect(html).toContain('下载');
    expect(html).toContain('尚未接通');
    expect(html).toContain('disabled=""');
  });
});

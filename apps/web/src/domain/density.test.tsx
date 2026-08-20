/*
 * 1100 × 700 density review — the compositions, not the components
 * (spec §9 risk 6, and §10.1 gap 6).
 *
 * The four domain directories were each reviewed against their own volumes; the
 * failures that are left are the ones that only appear when two layer-1 pieces
 * share a 996px column. Three of those are worth holding down with a test:
 *
 *   1. 248 rows of 「02 Demo 资料库」 in a `DataTable`, with the Inspector on the
 *      right — the widest thing the product draws;
 *   2. the same page at the fold, where §8 rule 2 turns the Inspector into a
 *      46px strip and a drawer;
 *   3. `Toolbar`'s `inlineActionsWhenCollapsed`, whose default of 0 phase 0
 *      explicitly deferred to this review.
 *
 * `design/**` is not modified by this review, so where a measurement says the
 * design layer should change, it is written down as an assertion of what is
 * true today plus a comment saying what the page layer must pass.
 */

import { describe, expect, it } from 'vitest';

import { DataTable, Pagination, type DataTableColumn } from '../design/data';
import { Inspector, Toolbar, type ToolbarAction } from '../design/layout';
import { Button } from '../design/primitives';
import { renderMarkup } from '../test/render';
import {
  FOLD_CONTENT_WIDTH_PX,
  FOLD_CONTENT_WIDTH_WITH_DOCKED_INSPECTOR_PX,
  LIBRARY_MATCH_COUNT,
  PLAYER_DIRECTORY_COUNT,
  WATCHED_FOLDER_COUNT,
  makeLibraryRows,
  makePlayerRows,
  type DensityTableRow,
} from './densityFixtures';

/** §3.4 `--h-row`, written on every `td` of 「02 Demo 资料库」. */
const ROW_HEIGHT_PX = 42;

/** What one page of the library table holds. Not a token — a page decision. */
const PAGE_SIZE = 20;

function occurrences(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

/* The nine columns 「02 Demo 资料库」 draws, in its order. */
const COLUMNS: readonly DataTableColumn<DensityTableRow>[] = [
  { id: 'title', header: '比赛', cell: (row) => row.title, truncate: true },
  { id: 'map', header: '地图', cell: (row) => row.map },
  { id: 'playedAt', header: '日期', cell: (row) => row.playedAt, variant: 'numeric' },
  { id: 'duration', header: '时长', cell: (row) => row.durationLabel, variant: 'numeric' },
  { id: 'rounds', header: '回合', cell: (row) => row.rounds, variant: 'numeric' },
  { id: 'source', header: '来源', cell: (row) => row.source, truncate: true },
  { id: 'tags', header: '标签', cell: (row) => row.tags, truncate: true },
  { id: 'status', header: '状态', cell: (row) => row.status },
  { id: 'actions', headerLabel: '操作', cell: () => <Button size="sm" variant="ghost">工作区</Button>, width: '90px' },
];

const rows = makeLibraryRows(LIBRARY_MATCH_COUNT);

describe('density · 248 matches in the library table', () => {
  it('pages instead of drawing 10 416px of rows, and says how many there are', () => {
    // The whole library at `--h-row` is twenty-five screens of a 700px window.
    expect(LIBRARY_MATCH_COUNT * ROW_HEIGHT_PX).toBe(10_416);

    const page = rows.slice(0, PAGE_SIZE);
    const html = renderMarkup(
      <DataTable
        caption="Demo 资料库"
        columns={COLUMNS}
        rows={page}
        rowId={(row) => row.id}
        activeRowId="demo-0"
        onRowActivate={() => {}}
        footer={
          <Pagination page={1} pageSize={PAGE_SIZE} total={LIBRARY_MATCH_COUNT} onPageChange={() => {}} />
        }
      />,
    );

    expect(occurrences(html, 'data-row-id=')).toBe(PAGE_SIZE);
    // Not silent: the count of everything and the slice being shown are both
    // printed, which is the rule phase 1's command palette established.
    expect(html).toContain(`共 ${String(LIBRARY_MATCH_COUNT)} 条`);
    expect(html).toContain('第 1–20 条');
  });

  it('keeps the scroll inside the table and the header on top of it', () => {
    const html = renderMarkup(
      <DataTable caption="Demo 资料库" columns={COLUMNS} rows={rows.slice(0, PAGE_SIZE)} rowId={(row) => row.id} />,
    );

    // Nine columns do not fit in 616px beside a docked Inspector; the table's
    // own box takes the overflow so the window never scrolls sideways.
    expect(html).toContain('min-h-0 flex-1 overflow-auto');
    expect(html).toContain('sticky top-0');
    expect(occurrences(html, 'truncate')).toBeGreaterThanOrEqual(3 * PAGE_SIZE);
  });

  it('is 616px wide beside a docked Inspector — which is why §8 folds it', () => {
    expect(FOLD_CONTENT_WIDTH_PX - 380).toBe(FOLD_CONTENT_WIDTH_WITH_DOCKED_INSPECTOR_PX);
    // Nine columns in 616px is 68px a column before padding. That is under the
    // width of 「2026-08-14 21:35」, so at the fold the Inspector has to fold too
    // rather than the table being asked to hold nine columns in 616px.
    expect(Math.floor(FOLD_CONTENT_WIDTH_WITH_DOCKED_INSPECTOR_PX / COLUMNS.length)).toBeLessThan(70);
  });
});

describe('density · the Inspector beside that table, at both widths', () => {
  const inspector = (collapsed: boolean) => (
    <Inspector
      title="选中：Aurora vs Meridian"
      label="比赛详情"
      summary="选中 R21 · 1v3 残局"
      collapsed={collapsed}
      summaryActions={<Button size="sm">加入视频</Button>}
      footer={<Button size="lg">用 Agent 制作视频</Button>}
    >
      <p>Mirage · 2026-08-14 · 24 回合 · 64 tick</p>
    </Inspector>
  );

  it('docks at 380px above the fold and scrolls its own body', () => {
    const html = renderMarkup(inspector(false));
    expect(html).toContain('data-inspector="docked"');
    expect(html).toContain('w-[var(--w-inspector)]');
    expect(html).toContain('overflow-x-hidden');
    expect(html).toContain('overflow-y-auto');
  });

  it('folds to the 46px summary strip and keeps the main action on it', () => {
    const html = renderMarkup(inspector(true));

    expect(html).toContain('data-inspector="summary"');
    expect(html).toContain('h-[var(--h-bar)]');
    // §8: 主动作 never folds. The drawer trigger is the way back to the rest.
    expect(html).toContain('加入视频');
    expect(html).toContain('data-inspector-trigger');
    // The summary line is one line and clips; the drawer holds the whole thing.
    expect(html).toContain('data-inspector-summary="true" class="min-w-0 truncate');
    expect(html).not.toContain('data-inspector="docked"');
  });
});

describe('density · Toolbar.inlineActionsWhenCollapsed (§10.1 gap 6)', () => {
  const actions: readonly ToolbarAction[] = [
    { id: 'columns', control: <Button size="sm" variant="ghost">列配置</Button>, label: '列配置' },
    { id: 'filter', control: <Button size="sm" variant="ghost">筛选</Button>, label: '筛选' },
    { id: 'rescan', control: <Button size="sm" variant="ghost">重新扫描</Button>, label: '重新扫描' },
  ];

  const toolbar = (inline?: number) => (
    <Toolbar
      title="Demo 资料库"
      meta={`${String(LIBRARY_MATCH_COUNT)} 场 · ${String(WATCHED_FOLDER_COUNT)} 个监听目录`}
      actions={actions}
      primary={<Button>导入 Demo</Button>}
      collapsed
      {...(inline === undefined ? {} : { inlineActionsWhenCollapsed: inline })}
    />
  );

  it('folds every secondary action by default and never the primary one', () => {
    const html = renderMarkup(toolbar());

    expect(html).not.toContain('data-toolbar-actions');
    expect(html).toContain('data-toolbar-primary');
    expect(html).toContain('导入 Demo');
    // One 「更多」 trigger, holding all three.
    expect(occurrences(html, '更多操作')).toBeGreaterThanOrEqual(1);
  });

  it('has room for two of them at the fold — the default is too cautious here', () => {
    /*
     * The measurement behind the recommendation. `topbar` is `px-7`, so the bar
     * has 996 − 56 = 940px of content. What it must hold on 「02 Demo 资料库」:
     *
     *   title  「Demo 资料库」 at --text-2xl          ~132
     *   meta   「248 场 · 3 个监听目录」 at --text-sm  ~170
     *   更多                                          ~62
     *   primary 「导入 Demo」 at --h-ctl-md            ~104
     *   four gap-4 / gap-2.5 gaps                      ~58
     *                                                 ────
     *                                                  526
     *
     * leaving ~414px, and a `--h-ctl-sm` ghost button with a three-character
     * label is ~76px. Two of them fit with 260px to spare. So `pages/library`
     * should pass `inlineActionsWhenCollapsed={2}`; the component default of 0
     * stays right, because a component cannot measure its own title.
     */
    const usedPx = 132 + 170 + 62 + 104 + 58;
    const inlineActionPx = 76;
    expect(FOLD_CONTENT_WIDTH_PX - 56 - usedPx).toBeGreaterThan(inlineActionPx * 2);

    const html = renderMarkup(toolbar(2));
    expect(occurrences(html, 'data-toolbar-action=')).toBe(2);
    expect(html).toContain('data-toolbar-action="columns"');
    expect(html).toContain('data-toolbar-action="filter"');
    // The third is in the menu, not gone.
    expect(html).not.toContain('data-toolbar-action="rescan"');
    expect(html).toContain('data-toolbar-primary');
  });

  it('drops the 更多 trigger entirely when nothing was folded', () => {
    const html = renderMarkup(toolbar(actions.length));
    expect(occurrences(html, 'data-toolbar-action=')).toBe(actions.length);
    expect(html).not.toContain('更多操作');
  });
});

describe('density · 312 players in the directory', () => {
  it('pages the directory the same way, and states the total', () => {
    const players = makePlayerRows(PLAYER_DIRECTORY_COUNT);
    expect(players).toHaveLength(PLAYER_DIRECTORY_COUNT);

    const html = renderMarkup(
      <DataTable
        caption="玩家目录"
        columns={COLUMNS.slice(0, 4)}
        rows={players.slice(0, PAGE_SIZE)}
        rowId={(row) => row.id}
        selectable
        selectionLimit={2}
        selected={new Set(['player-0', 'player-1'])}
        onSelectedChange={() => {}}
        rowLabel={(row) => row.title}
        footer={
          <Pagination
            page={1}
            pageSize={PAGE_SIZE}
            total={PLAYER_DIRECTORY_COUNT}
            onPageChange={() => {}}
            summary={`${String(PLAYER_DIRECTORY_COUNT)} 名选手`}
          />
        }
      />,
    );

    expect(occurrences(html, 'data-row-id=')).toBe(PAGE_SIZE);
    expect(html).toContain('312 名选手');
    // 「比较上限 2 名」: past the cap the boxes are disabled, not hidden, and no
    // select-all appears to contradict the cap.
    // Scoped to the table: the pager's 上一页 is disabled on page 1 as well.
    // Counted on `data-disabled`, which Radix puts on the control alone — the
    // plain `disabled` attribute also lands on the hidden form input beside it.
    const table = html.slice(0, html.indexOf('<nav'));
    expect(occurrences(table, 'data-disabled=""')).toBe(PAGE_SIZE - 2);
    expect(html).not.toContain('全选本页');
  });
});

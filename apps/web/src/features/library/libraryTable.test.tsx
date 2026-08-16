import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { DemoSummary } from '../../shared/desktop/viewModels';
import {
  LibraryColumnVisibility,
  LibraryDemoInspector,
  LibraryPagination,
  LibraryPowerTable,
  LibraryResultScope,
  sortLibraryDemos,
} from './libraryTable';

function demo(overrides: Partial<DemoSummary> = {}): DemoSummary {
  return {
    id: 'demo-1',
    filename: 'major.dem',
    display_name: 'Major final',
    map_name: 'de_mirage',
    match_date: '2026-08-12T00:00:00Z',
    cataloged_at: '2026-08-12T00:30:00Z',
    duration_seconds: 2_940,
    total_rounds: 21,
    score_team_a: 13,
    score_team_b: 8,
    team_a_name: 'FURIA',
    team_b_name: 'Falcons',
    status: 'ready',
    lifecycle_status: 'ready',
    players: [],
    source: 'local',
    path: 'D:\\Demos\\major.dem',
    remark: '',
    updated_at: '2026-08-12T01:02:03Z',
    ...overrides,
  };
}

describe('library power-table ordering', () => {
  it('sorts the loaded real records while keeping unknown numeric values last', () => {
    const records = [
      demo({ id: 'unknown', duration_seconds: 0, total_rounds: 0, updated_at: '' }),
      demo({ id: 'long', duration_seconds: 900, total_rounds: 18 }),
      demo({ id: 'short', duration_seconds: 300, total_rounds: 12 }),
    ];

    expect(sortLibraryDemos(records, { key: 'duration', direction: 'asc' }).map((item) => item.id))
      .toEqual(['short', 'long', 'unknown']);
    expect(sortLibraryDemos(records, { key: 'rounds', direction: 'desc' }).map((item) => item.id))
      .toEqual(['long', 'short', 'unknown']);
  });
});

describe('library power-table', () => {
  it('shows an unavailable match date without relabeling the catalog timestamp', () => {
    const markup = renderToStaticMarkup(
      <LibraryPowerTable
        demos={[demo({ match_date: null, cataloged_at: '2026-08-12T00:30:00Z' })]}
        visibleColumns={new Set(['played'])}
        selectedIds={new Set()}
        activeDemoId={null}
        sort={{ key: 'updated', direction: 'desc' }}
        playingDemoId={null}
        playbackDisabled={false}
        onSort={vi.fn()}
        onToggleSelected={vi.fn()}
        onPlay={vi.fn()}
        onLifecycleAction={vi.fn()}
        onOpenDetails={vi.fn()}
      />,
    );

    expect(markup).toContain('data-column="played"');
    expect(markup).toContain('比赛日期不可用');
    expect(markup).toContain('title="目录化时间：');
  });

  it('offers only real optional columns and keeps status, name, and actions locked visible', () => {
    const markup = renderToStaticMarkup(
      <LibraryColumnVisibility
        visibleColumns={new Set(['map', 'score'])}
        onChange={vi.fn()}
      />,
    );

    expect(markup).toContain('data-testid="library-column-visibility"');
    for (const column of ['status', 'file', 'actions']) {
      const input = markup.match(new RegExp(`<input[^>]*data-column-option="${column}"[^>]*>`))?.[0] ?? '';
      expect(input).toContain('checked=""');
      expect(input).toContain('disabled=""');
    }
    for (const column of ['map', 'score']) {
      expect(markup).toMatch(new RegExp(`data-column-option="${column}"[^>]*checked=""`));
    }
    for (const column of ['played', 'duration', 'rounds', 'updated']) {
      expect(markup).toContain(`data-column-option="${column}"`);
    }
    expect(markup).not.toContain('data-column-option="size"');
    expect(markup).toContain('当前列表未提供文件大小');
  });

  it('keeps core columns visible while showing only the selected factual columns', () => {
    const markup = renderToStaticMarkup(
      <LibraryPowerTable
        demos={[demo()]}
        visibleColumns={new Set(['map', 'played'])}
        selectedIds={new Set()}
        activeDemoId={null}
        sort={{ key: 'updated', direction: 'desc' }}
        playingDemoId={null}
        playbackDisabled={false}
        onSort={vi.fn()}
        onToggleSelected={vi.fn()}
        onOpenDetails={vi.fn()}
        onPlay={vi.fn()}
        onLifecycleAction={vi.fn()}
      />,
    );

    for (const column of ['status', 'file', 'map', 'played', 'actions']) {
      expect(markup).toContain(`data-column="${column}"`);
    }
    for (const column of ['score', 'duration', 'rounds', 'updated']) {
      expect(markup).not.toContain(`data-column="${column}"`);
    }
    expect(markup).toContain('data-optional-column-count="2"');
    expect(markup).toContain('比赛日期');
    expect(markup).toContain('2026');
  });

  it('renders dense factual columns, a truthful missing reason, and row actions', () => {
    const markup = renderToStaticMarkup(
      <LibraryPowerTable
        demos={[
          demo(),
          demo({
            id: 'missing',
            filename: 'gone.dem',
            display_name: 'Gone',
            map_name: 'unknown',
            duration_seconds: 0,
            total_rounds: 0,
            score_team_a: null,
            score_team_b: null,
            team_a_name: null,
            team_b_name: null,
            lifecycle_status: 'missing',
            status: 'error',
            updated_at: '',
          }),
        ]}
        selectedIds={new Set()}
        activeDemoId={null}
        sort={{ key: 'updated', direction: 'desc' }}
        playingDemoId={null}
        playbackDisabled={false}
        onSort={vi.fn()}
        onToggleSelected={vi.fn()}
        onOpenDetails={vi.fn()}
        onPlay={vi.fn()}
        onLifecycleAction={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="Demo 表格"');
    expect(markup).toContain('aria-sort="descending"');
    expect(markup).toContain('major.dem');
    expect(markup).toContain('13 : 8');
    expect(markup).toContain('原始 Demo 路径当前不可访问。');
    expect(markup).toContain('—');
    expect(markup).toContain('查看详情');
    expect(markup).toContain('观看');
    expect(markup).toContain('打开比赛');
    expect(markup).toContain('data-testid="library-table-scroll-hint"');
    expect(markup).toContain('横向滚动查看更多列，操作固定在右侧');
  });

  it('discloses the current server page without claiming the table contains the whole library', () => {
    const markup = renderToStaticMarkup(<LibraryResultScope page={2} pageSize={50} total={137} visible={50} />);

    expect(markup).toContain('第 2 / 3 页');
    expect(markup).toContain('本页 50 条，共 137 条');
    expect(markup).toContain('搜索、筛选与排序由本地服务作用于完整结果集');
  });

  it('renders bounded server pagination and a per-page selector', () => {
    const markup = renderToStaticMarkup(
      <LibraryPagination
        page={2}
        pageSize={50}
        total={137}
        onPageChange={vi.fn()}
        onPageSizeChange={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="Demo 分页"');
    expect(markup).toContain('第 2 / 3 页');
    expect(markup).toContain('value="50" selected=""');
    expect(markup).toContain('上一页');
    expect(markup).toContain('下一页');
  });
});

describe('library demo inspector', () => {
  it('keeps real Watch, Open, and Reveal actions together with the selected demo facts', () => {
    const markup = renderToStaticMarkup(
      <LibraryDemoInspector
        demo={demo()}
        playing={false}
        playbackDisabled={false}
        revealDisabled={false}
        onPlay={vi.fn()}
        onLifecycleAction={vi.fn()}
        onReveal={vi.fn()}
      />,
    );

    expect(markup).toContain('Major final');
    expect(markup).toContain('major.dem');
    expect(markup).toContain('观看');
    expect(markup).toContain('打开比赛');
    expect(markup).toContain('在文件管理器中定位');
    expect(markup).toContain('13 : 8');
  });
});

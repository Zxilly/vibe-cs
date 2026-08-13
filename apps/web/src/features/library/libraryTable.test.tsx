import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { DemoSummary } from '../../shared/desktop/dto';
import {
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
    played_at: '2026-08-12T00:00:00Z',
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

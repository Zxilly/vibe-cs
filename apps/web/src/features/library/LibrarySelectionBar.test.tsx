import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { LibrarySelectionBar } from './LibrarySelectionBar';

const metadataProps = {
  tags: [{
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Major',
    color: '#dc2626',
    created_at: '2026-08-14T01:00:00Z',
    updated_at: '2026-08-14T01:00:00Z',
  }],
  matchSources: ['faceit', 'valve'] as const,
  metadataBusy: false,
  onSetMatchSource: vi.fn(),
  onAddTag: vi.fn(),
  onRemoveTag: vi.fn(),
};

describe('library cross-page selection bar', () => {
  it('states the explicit bounded cross-page contract and keeps validation visible', () => {
    const markup = renderToStaticMarkup(
      <LibrarySelectionBar
        {...metadataProps}
        selectedCount={3}
        state="validating"
        atLimit={false}
        onClear={vi.fn()}
        onAnalyze={vi.fn()}
      />,
    );

    expect(markup).toContain('data-testid="library-selection-bar"');
    expect(markup).toContain('已显式选择 3 场比赛');
    expect(markup).toContain('选择会在翻页、排序和列布局变化时保留');
    expect(markup).toContain('最多选择 12 场，不代表全部筛选结果');
    expect(markup).toContain('正在向本地服务核验所选比赛');
    expect(markup).toContain('分析所选比赛');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*<\/button>/);
  });

  it('announces the hard cap without claiming that every filtered result is selected', () => {
    const markup = renderToStaticMarkup(
      <LibrarySelectionBar
        {...metadataProps}
        selectedCount={12}
        state="idle"
        atLimit
        onClear={vi.fn()}
        onAnalyze={vi.fn()}
      />,
    );

    expect(markup).toContain('一次最多显式选择 12 场比赛');
    expect(markup).not.toContain('全选');
  });

  it('keeps actions disabled after validation succeeds while navigation is opening', () => {
    const markup = renderToStaticMarkup(
      <LibrarySelectionBar
        {...metadataProps}
        selectedCount={2}
        state="opening"
        atLimit={false}
        onClear={vi.fn()}
        onAnalyze={vi.fn()}
      />,
    );

    expect(markup.match(/disabled=""/g)).toHaveLength(5);
  });

  it('exposes exact source and tag batch controls without claiming filter-wide selection', () => {
    const markup = renderToStaticMarkup(
      <LibrarySelectionBar
        {...metadataProps}
        selectedCount={2}
        state="idle"
        atLimit={false}
        onClear={vi.fn()}
        onAnalyze={vi.fn()}
      />,
    );
    expect(markup).toContain('faceit');
    expect(markup).toContain('Major');
    expect(markup).toContain('应用来源');
    expect(markup).toContain('添加标签');
    expect(markup).toContain('移除标签');
  });
});

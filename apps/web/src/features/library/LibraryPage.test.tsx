import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type { DemoSummary } from '../../shared/desktop/dto';
import { LibraryPage, LibraryWorkspaceSummary } from './LibraryPage';

function demo(overrides: Partial<DemoSummary>): DemoSummary {
  return {
    id: 'demo-1',
    path: 'D:\\Demos\\major.dem',
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
    remark: '',
    updated_at: '2026-08-12T01:02:03Z',
    ...overrides,
  };
}

describe('library wide-workspace summary', () => {
  it('turns persisted demos into an actionable map and analysis index', () => {
    const onMapFilter = vi.fn();
    const markup = renderToStaticMarkup(
      <LibraryWorkspaceSummary
        demos={[
          demo({ id: 'mirage-ready' }),
          demo({ id: 'mirage-discovered', lifecycle_status: 'discovered', status: 'pending', total_rounds: 0 }),
          demo({ id: 'inferno-ready', map_name: 'de_inferno', total_rounds: 18 }),
        ]}
        activeMap="all"
        onMapFilter={onMapFilter}
      />,
    );

    expect(markup).toContain('aria-label="比赛概况"');
    expect(markup).toContain('MIRAGE');
    expect(markup).toContain('INFERNO');
    expect(markup).toContain('>39<');
    expect(markup).toContain('aria-pressed="false"');
    expect(onMapFilter).not.toHaveBeenCalled();
  });
});

describe('library server-query controls', () => {
  it('restores column visibility from the URL and keeps the selector beside table controls', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/library?columns=map,played']}>
        <LibraryPage />
      </MemoryRouter>,
    );

    expect(markup).toContain('data-testid="library-column-visibility"');
    expect(markup).toContain('data-column="map"');
    expect(markup).toContain('data-column="played"');
    expect(markup).not.toContain('data-column="score"');
    expect(markup).not.toContain('data-column="duration"');
    expect(markup).not.toContain('data-column="rounds"');
    expect(markup).not.toContain('data-column="updated"');
  });

  it('restores search, map, exact lifecycle status, and table sort from the URL', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/library?q=m0NESY&map=de_mirage&status=indexing&sort=map_desc&page=3&page_size=20']}>
        <LibraryPage />
      </MemoryRouter>,
    );

    expect(markup).toContain('value="m0NESY"');
    expect(markup).toContain('value="de_mirage"');
    expect(markup).toContain('value="indexing" selected=""');
    expect(markup).toContain('aria-sort="descending"><button type="button">地图');
  });
});

describe('library cross-page selection wiring', () => {
  const source = readFileSync(new URL('./LibraryPage.tsx', import.meta.url), 'utf8');

  it('keeps canonical ids through page and sort changes but clears them when membership changes', () => {
    expect(source).toMatch(/const selectionIdentity = librarySelectionIdentity\(libraryQuery\)/);
    expect(source).toMatch(/setSelectedIds\(new Set\(\)\)[\s\S]*?\}, \[cancelSelectionPreflight, selectionIdentity\]\)/);
    expect(source).not.toMatch(/retainLibraryPageSelection/);
    expect(source).not.toMatch(/\[libraryQuery\.map, libraryQuery\.page, libraryQuery\.pageSize, libraryQuery\.search, libraryQuery\.status\]/);
  });

  it('preflights each selected id with the exact service record before opening batch analysis', () => {
    expect(source).toMatch(/selectionPreflight\.run\([\s\S]*?commands\.getDemo\(id, signal\)/);
    expect(source).toMatch(/return \{ id: demo\.id, status: demo\.lifecycle_status \}/);
    expect(source).not.toMatch(/return \{ id: demo\.id, status: demo\.status \}/);
    expect(source).toMatch(/result\.validIds\[0\][\s\S]*?demos=\$\{encodeURIComponent\(result\.validIds\.join\(','\)\)\}/);
    expect(source).toMatch(/library\.selection\.validationFailed/);
    expect(source).not.toMatch(/selectedAnalysisIds/);
  });

  it('ignores a stale preflight after the membership query clears selection', () => {
    expect(source).toMatch(/cancelSelectionPreflight\(\)[\s\S]*?\}, \[cancelSelectionPreflight, selectionIdentity\]\)/);
    expect(source).toMatch(/const requestedSelectionIdentity = selectionIdentity[\s\S]*?const requestedSelectionIdsIdentity = selectionIdsIdentity[\s\S]*?selectionPreflight\.run/);
    expect(source).toMatch(/if \(selectionIdentityRef\.current !== requestedSelectionIdentity\) return/);
    expect(source).toMatch(/if \(selectionIdsIdentityRef\.current !== requestedSelectionIdsIdentity\)[\s\S]*?cancelSelectionPreflight\(\)[\s\S]*?return/);
    expect(source).toMatch(/setSelectedIds\(new Set\(result\.validIds\)\)/);
  });

  it('disposes the current preflight when the Library route leaves', () => {
    expect(source).toMatch(/const selectionPreflight = useMemo\(createLibrarySelectionPreflight, \[\]\)/);
    expect(source).toMatch(/return \(\) => selectionPreflight\.dispose\(\)/);
  });
});

describe('library Demo metadata wiring', () => {
  const source = readFileSync(new URL('./LibraryPage.tsx', import.meta.url), 'utf8');

  it('keeps import provenance read-only and edits the distinct match provider contract', () => {
    expect(source).toMatch(/commands\.getDemoMetadata\(selectedId, controller\.signal\)/);
    expect(source).toMatch(/commands\.listReviewTags\(controller\.signal\)/);
    expect(source).toMatch(/match_source: editMatchSource \|\| null/);
    expect(source).toMatch(/comment: editRemark/);
    expect(source).toMatch(/tag_ids: \[\.\.\.editTagIds\]/);
    expect(source).toMatch(/commands\.createReviewTag\(\{ name, color: newTagColor \}\)/);
    expect(source).toMatch(/commands\.updateDemoMetadataBatch\(\{ demo_ids: demoIds, \.\.\.change \}\)/);
    expect(source).toMatch(/if \(!updated \|\| activeDemoIdRef\.current !== requestedDemoId\) return/);
    expect(source).toMatch(/if \(!created \|\| activeDemoIdRef\.current !== requestedDemoId\) return/);
    expect(source).toContain("library.metadata.truth");
  });

  it('exports the complete URL-owned filter through the desktop save boundary', () => {
    expect(source).toMatch(/chooseLocalSavePath\(\{/);
    expect(source).toMatch(/commands\.exportDemos\(format, libraryQueryToDemoQuery\(libraryQuery\)\)/);
    expect(source).toMatch(/writeLocalBytes\(path, new Uint8Array\(bytes\)\)/);
    expect(source).toContain("handleExport('json')");
    expect(source).toContain("handleExport('xlsx')");
  });
});

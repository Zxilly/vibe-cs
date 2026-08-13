import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import type { MatchHistoryItem } from '../../shared/desktop/dto';
import { DesktopError } from '../../shared/desktop/client';
import {
  matchHistoryVisibleError,
  indexMatchDownloadJobs,
  loadAllMatchHistory,
  matchesCsv,
  MatchHistoryAnalysisLink,
  MatchHistoryDownloadControl,
  MatchHistoryEmptyWorkspace,
  MatchHistoryPage,
} from './MatchHistoryPage';

function match(overrides: Partial<MatchHistoryItem> = {}): MatchHistoryItem {
  return {
    id: 'record-id',
    steam_id: '76561198000000000',
    match_id: 'match-id',
    outcome_id: '2',
    token: 3,
    map_name: 'de_mirage',
    played_at: '2026-08-10T10:00:00Z',
    score: '13:9',
    result: 'win',
    demo_status: 'available',
    demo_id: null,
    last_error: null,
    synced_at: '2026-08-10T10:00:00Z',
    updated_at: '2026-08-10T10:00:00Z',
    ...overrides,
  };
}

describe('matchesCsv', () => {
  it('fails closed when the route does not use the current Match History query schema', () => {
    expect(() => renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: ['/match-history?search=nuke'] },
        createElement(MatchHistoryPage),
      ),
    )).toThrow('Invalid Match History query parameter: search');
  });

  it('quotes every cell and neutralizes spreadsheet formulas', () => {
    const value = match({
      match_id: '=unsafe',
    });

    const csv = matchesCsv([value]);

    expect(csv).toContain('"\'=unsafe"');
    expect(csv).toContain('"de_mirage"');
    expect(csv).toContain('\r\n');
  });

  it('opens an imported match through the existing analysis hash-route contract', () => {
    const markup = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(MatchHistoryAnalysisLink, {
          match: match({ demo_status: 'downloaded', demo_id: 'demo/with spaces' }),
          label: 'Open analysis',
        }),
      ),
    );

    expect(markup).toContain('href="/analysis?demo=demo%2Fwith+spaces"');
    expect(markup).toContain('Open analysis');
    expect(markup).not.toContain('disabled');
  });

  it('exports every matching server page instead of only the visible 20 rows', async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) => match({ id: `record-${index}`, match_id: `match-${index}` }));
    const lastPage = [match({ id: 'record-200', match_id: 'match-200' })];
    const requests: Array<{ page: number; pageSize: number; search: string }> = [];
    const result = await loadAllMatchHistory(async (page, pageSize, search) => {
      requests.push({ page, pageSize, search });
      return {
        items: page === 1 ? firstPage : lastPage,
        total: 201,
        page,
        page_size: pageSize,
      };
    }, 'nuke');

    expect(requests).toEqual([
      { page: 1, pageSize: 200, search: 'nuke' },
      { page: 2, pageSize: 200, search: 'nuke' },
    ]);
    expect(result).toHaveLength(201);
    expect(result.at(-1)?.match_id).toBe('match-200');
  });

  it('reconnects a persisted active job to its match and restores cancellation after refresh', () => {
    const pending = match({ demo_status: 'downloading' });
    const activeJob = {
      id: 'job-id',
      match_record_id: pending.id,
      status: 'downloading' as const,
      downloaded_bytes: 25,
      total_bytes: 100,
      progress: 0.25,
      demo_id: null,
      error: null,
      created_at: pending.synced_at,
      updated_at: pending.updated_at,
    };
    const indexed = indexMatchDownloadJobs([activeJob]);
    const markup = renderToStaticMarkup(createElement(MatchHistoryDownloadControl, {
      match: pending,
      job: indexed[pending.id],
      labels: {
        imported: 'Imported', redownload: 'Download again', retry: 'Retry',
        download: 'Download Demo', processing: 'Processing', cancel: 'Cancel', openAnalysis: 'Open analysis',
      },
      cancelDisabled: false,
      downloadDisabled: false,
      onCancel: () => undefined,
      onDownload: () => undefined,
    }));

    expect(markup).toContain('Cancel');
    expect(markup).not.toContain('Download Demo');
    expect(indexed[pending.id]?.id).toBe('job-id');
  });

  it('never presents a persisted downloading record as available while jobs hydrate', () => {
    const markup = renderToStaticMarkup(createElement(MatchHistoryDownloadControl, {
      match: match({ demo_status: 'downloading' }),
      labels: {
        imported: 'Imported', redownload: 'Download again', retry: 'Retry',
        download: 'Download Demo', processing: 'Processing', cancel: 'Cancel', openAnalysis: 'Open analysis',
      },
      cancelDisabled: false,
      downloadDisabled: false,
      onCancel: () => undefined,
      onDownload: () => undefined,
    }));

    expect(markup).toContain('Processing');
    expect(markup).toContain('disabled');
    expect(markup).not.toContain('Download Demo');
  });

  it('renders one compact empty state instead of duplicate disconnected errors and empty data chrome', () => {
    const markup = renderToStaticMarkup(createElement(
      MemoryRouter,
      null,
      createElement(MatchHistoryEmptyWorkspace, {
        configured: false,
        filtered: false,
        labels: {
          connectFirst: 'Connect match history first',
          credentialsDescription: 'Credentials stay local.',
          empty: 'No synced matches yet',
          emptyDescription: 'Sync to begin.',
          noSearchResults: 'No matching records',
          noSearchResultsDescription: 'Try another query.',
          openSettings: 'Open settings',
          startSync: 'Start sync',
          clearSearch: 'Clear search',
        },
        onSync: () => undefined,
        onClearSearch: () => undefined,
      }),
    ));

    expect(markup).toContain('history-empty-card--compact');
    expect(markup).toContain('Connect match history first');
    expect(markup).not.toContain('notice--danger');
    expect(markup).not.toContain('history-toolbar');
    expect(markup).not.toContain('history-list');
  });

  it('suppresses the expected unconfigured history rejection but keeps real connected failures', () => {
    const error = new DesktopError('local database read failed', 500, 'internal_error');

    expect(matchHistoryVisibleError(false, error)).toBeNull();
    expect(matchHistoryVisibleError(true, error)).toBe('local database read failed');
    expect(matchHistoryVisibleError(null, error)).toBe('local database read failed');
  });
});

/*
 * `interaction` project — /history, wired.
 *
 * The page's job is to turn the two reads into rows and the three writes into
 * buttons, so what is asserted is exactly that seam: which command a click
 * reaches, with which argument, and whether the list re-ran afterwards. No real
 * IPC — the client is a plain object handed to `DesktopClientProvider`.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { MatchDownloadJob, MatchHistoryItem, Paginated } from '../../shared/desktop/dto';
import { HistoryWorkspace } from '../HistoryPage';
import { HEALTHY, renderPage } from '../delivery/test/renderPage';
import { matchHistoryItem } from './test/fixtures';
import { reasonOf } from '../../test/reason';

function page(items: MatchHistoryItem[]): Paginated<MatchHistoryItem> {
  return { items, total: items.length, page: 1, page_size: 50 };
}

const DOWNLOADING_JOB: MatchDownloadJob = {
  id: 'dl-7',
  match_record_id: 'mh-3',
  status: 'downloading',
  downloaded_bytes: 1_024,
  total_bytes: null,
  progress: 0.2,
  demo_id: null,
  error: null,
  error_code: null,
  created_at: '2026-08-15T08:41:00.000Z',
  updated_at: '2026-08-15T08:41:00.000Z',
};

/** One available row and one already downloading, which is every button. */
function rows(): MatchHistoryItem[] {
  return [
    matchHistoryItem({
      id: 'mh-2',
      match_id: 'CSGO-available',
      map_name: 'de_ancient',
      played_at: new Date().toISOString(),
      demo_status: 'available',
      demo_id: null,
    }),
    matchHistoryItem({
      id: 'mh-3',
      match_id: 'CSGO-inflight',
      map_name: 'de_nuke',
      played_at: new Date().toISOString(),
      demo_status: 'downloading',
      demo_id: null,
    }),
  ];
}

function client(overrides: Record<string, unknown> = {}) {
  return {
    listMatchHistory: vi.fn(() => Promise.resolve(page(rows()))),
    listActiveMatchDownloadJobs: vi.fn(() => Promise.resolve([DOWNLOADING_JOB])),
    syncMatchHistory: vi.fn(() =>
      Promise.resolve({ synced: 3, created: 1, total: 42, cursor_advanced: true }),
    ),
    downloadMatchDemo: vi.fn(() => Promise.resolve(DOWNLOADING_JOB)),
    cancelMatchDownload: vi.fn(() =>
      Promise.resolve({ ...DOWNLOADING_JOB, status: 'cancelled' as const }),
    ),
    ...overrides,
  };
}

function render(stub: Record<string, unknown>, online = true) {
  return renderPage({
    element: <HistoryWorkspace />,
    client: stub,
    route: '/history',
    pattern: '/history',
    ...(online ? { health: HEALTHY } : {}),
  });
}

describe('the read', () => {
  it('shows the rows the service sent, with their derived state', async () => {
    render(client());

    expect(await screen.findByText('de_ancient')).toBeTruthy();
    expect(screen.getByText('未下载')).toBeTruthy();
    expect(screen.getByText('下载中')).toBeTruthy();
    // The corpus total, not the number of rows drawn.
    expect(screen.getByRole('navigation', { name: '分页' }).textContent).toContain('共 2 场对局');
  });

  it('prints 上次同步 from the rows rather than from a local clock', async () => {
    render(client());

    await screen.findByText('de_ancient');
    expect(screen.getByText(/上次同步/u)).toBeTruthy();
  });
});

describe('下载', () => {
  it('sends the match id and re-reads the list afterwards', async () => {
    const stub = client();
    render(stub);

    await screen.findByText('de_ancient');
    const before = stub.listMatchHistory.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: '下载' }));

    await waitFor(() => {
      expect(stub.downloadMatchDemo).toHaveBeenCalledWith('CSGO-available');
    });
    // The row moves to 下载中 only because the list was invalidated.
    await waitFor(() => {
      expect(stub.listMatchHistory.mock.calls.length).toBeGreaterThan(before);
    });
  });

  it('leaves a batch the user is still assembling alone', async () => {
    const stub = client();
    render(stub);

    await screen.findByText('de_ancient');
    fireEvent.click(screen.getByRole('checkbox', { name: /de_ancient/u }));
    expect(await screen.findByText('已选 1 场')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '下载' }));

    await waitFor(() => {
      expect(stub.downloadMatchDemo).toHaveBeenCalled();
    });
    // The selection bar is still there: one row's action is not the batch.
    expect(screen.getByText('已选 1 场')).toBeTruthy();
  });

  it('cancels with the job id belonging to the row, not with the row id', async () => {
    const stub = client();
    render(stub);

    await screen.findByText('de_nuke');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    await waitFor(() => {
      expect(stub.cancelMatchDownload).toHaveBeenCalledWith('dl-7');
    });
  });
});

describe('同步最近比赛', () => {
  it('calls the sync command and re-reads the list', async () => {
    const stub = client();
    render(stub);

    await screen.findByText('de_ancient');
    const before = stub.listMatchHistory.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: /同步最近比赛/u }));

    await waitFor(() => {
      expect(stub.syncMatchHistory).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(stub.listMatchHistory.mock.calls.length).toBeGreaterThan(before);
    });
  });

  it('reports a failure in place, with a way to check the credentials', async () => {
    const stub = client({
      syncMatchHistory: vi.fn(() => Promise.reject(new Error('Steam 凭据已过期'))),
    });
    render(stub);

    await screen.findByText('de_ancient');
    fireEvent.click(screen.getByRole('button', { name: /同步最近比赛/u }));

    const notice = await screen.findByRole('alert');
    expect(within(notice).getByText(/Steam 凭据已过期/u)).toBeTruthy();
    expect(within(notice).getByRole('button', { name: '去设置检查 Steam 连接' })).toBeTruthy();
  });
});

describe('服务离线', () => {
  it('disables the writes with the reason attached, and keeps the list readable', async () => {
    render(client(), false);

    expect(await screen.findByText('de_ancient')).toBeTruthy();

    const sync = screen.getByRole('button', { name: /同步最近比赛/u });
    expect(sync.hasAttribute('disabled')).toBe(true);
    expect(reasonOf(sync)).toContain('本地服务');
    expect(screen.getByRole('button', { name: '下载' }).hasAttribute('disabled')).toBe(true);
  });
});

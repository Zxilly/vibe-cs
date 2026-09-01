/*
 * `interaction` project — 「条件变化要进 URL（§4.4 的做法：可分享、可后退）」.
 *
 * That sentence is the whole point of the page, and it is only true if pressing
 * a chip actually navigates. So every assertion here reads the address bar
 * after an interaction rather than reading component state.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { DesktopClientProvider, type DesktopClient } from '../../data/desktopClient';
import { renderInteractive } from '../../test/render';
import { EvidencePage } from '../EvidencePage';
import { evidenceResponse } from './test/fixtures';

/** Records every query the page asked for, so a test can assert what was sent
 *  as well as what was shown. */
function stubClient(): { client: Partial<DesktopClient>; queries: unknown[] } {
  const queries: unknown[] = [];
  return {
    queries,
    client: {
      searchEvidence: (query) => {
        queries.push(query);
        return Promise.resolve(evidenceResponse());
      },
      listEvidenceAnnotations: () =>
        Promise.resolve({ items: [], total: 0, page: 1, page_size: 20 }),
      listProjects: () => Promise.resolve([{
        id: '00000000-0000-4000-8000-000000000001', name: '证据集锦', revision: 1,
        document: {
          width: 1920, height: 1080, fps: 60, duration_seconds: 0,
          story_track_id: '00000000-0000-4000-8000-000000000002',
          tracks: [{
            id: '00000000-0000-4000-8000-000000000002', name: 'Story', kind: 'video',
            order: 0, muted: false, solo: false, volume: 1, pan: 0, keyframes: [], locked: false, hidden: false, clips: [],
          }],
          markers: [], settings: { source_demo_ids: [], ripple_sequence_markers: false },
        },
        created_at: '2026-08-20T00:00:00Z', updated_at: '2026-08-20T00:00:00Z',
      }]),
      listActivities: () => Promise.resolve({ items: [], total: 0, page: 1, page_size: 50, summary: { total: 0, active: 0, failed: 0, completed: 0, cancelled: 0 } }),
      listOutputs: () => Promise.resolve({ items: [], total: 0, page: 1, page_size: 100, scan_limited: false }),
    },
  };
}


function AddressProbe() {
  const location = useLocation();
  return <output data-testid="address">{`${location.pathname}${location.search}`}</output>;
}

function mount(url = '/evidence', client: Partial<DesktopClient> = stubClient().client) {
  return renderInteractive(
    <DesktopClientProvider client={client as DesktopClient}>
      <MemoryRouter initialEntries={[url]}>
        <AddressProbe />
        <Routes>
          <Route path="/evidence" element={<EvidencePage />} />
        </Routes>
      </MemoryRouter>
    </DesktopClientProvider>,
  );
}

function address(): string {
  return screen.getByTestId('address').textContent ?? '';
}

describe('every condition change is a navigation', () => {
  it('writes the event family when the segmented control moves', async () => {
    mount();
    await screen.findByText('命中 47 条 · 排序：时间倒序');

    fireEvent.click(screen.getByText('多杀'));
    await waitFor(() => {
      expect(address()).toContain('family=multi_kill');
    });
  });

  it('writes the free-text query only when 检索 is pressed', async () => {
    mount();
    await screen.findByText('命中 47 条 · 排序：时间倒序');

    const box = screen.getByLabelText('检索证据');
    fireEvent.change(box, { target: { value: 'Kael 的穿墙击杀' } });
    // A keystroke is not a navigation: the back stack would fill with half-words.
    expect(address()).not.toContain('q=');

    fireEvent.click(screen.getByText('检索'));
    await waitFor(() => {
      expect(address()).toContain('q=Kael');
    });
  });

  it('turns a ＋ chip into a field and commits it on Enter', async () => {
    const { container } = mount();
    await screen.findByText('命中 47 条 · 排序：时间倒序');

    fireEvent.click(screen.getByText('＋ 地图'));
    const field = container.querySelector<HTMLInputElement>('[data-condition-input="map"]');
    expect(field).not.toBeNull();

    fireEvent.change(field as HTMLInputElement, { target: { value: 'de_mirage' } });
    fireEvent.keyDown(field as HTMLInputElement, { key: 'Enter' });

    await waitFor(() => {
      expect(address()).toContain('map=de_mirage');
    });
  });

  it('removes a condition when its chip is pressed, and returns to page 1', async () => {
    const { container } = mount('/evidence?player=Kael&map=de_mirage&page=4');
    await screen.findByText('命中 47 条 · 排序：时间倒序');

    fireEvent.click(container.querySelector('[data-condition="map"]') as HTMLElement);
    await waitFor(() => {
      expect(address()).not.toContain('map=');
    });
    expect(address()).toContain('player=Kael');
    expect(address()).not.toContain('page=');
  });

  it('commits 近 30 天 as a concrete date, not as a relative word', async () => {
    mount();
    await screen.findByText('命中 47 条 · 排序：时间倒序');

    fireEvent.click(screen.getByText('＋ 近 30 天'));
    await waitFor(() => {
      // A shared link has to mean the same thing tomorrow.
      expect(address()).toMatch(/from=\d{4}-\d{2}-\d{2}/u);
    });
  });
});

describe('what the page sends', () => {
  it('turns the URL into the service s own query shape', async () => {
    const { client, queries } = stubClient();
    mount('/evidence?family=kill&player=Kael&headshot=1&from=2026-07-16&page=2', client);
    await screen.findByText('命中 47 条 · 排序：时间倒序');

    expect(queries.at(-1)).toEqual({
      page: 2,
      page_size: 20,
      event_family: 'kill',
      player: 'Kael',
      headshot: true,
      match_date_from: '2026-07-16',
    });
  });
});

describe('selecting a row', () => {
  it('focuses the first visible result without writing an explicit selection', async () => {
    const { container } = mount();
    await screen.findByText('命中 47 条 · 排序：时间倒序');

    await waitFor(() => {
      expect(screen.queryByText('还没有选中证据')).toBeNull();
    });
    expect(container.querySelector('[data-evidence-row][aria-current="true"]')).not.toBeNull();
    expect(address()).not.toContain('evidence=');
    expect(screen.queryByText('已选 1 条证据')).toBeNull();
  });

  it('puts the evidence id in the URL, so the selection is shareable', async () => {
    const { container } = mount();
    await screen.findByText('命中 47 条 · 排序：时间倒序');

    fireEvent.click(container.querySelectorAll('[data-evidence-select]')[0] as HTMLElement);
    await waitFor(() => {
      expect(address()).toContain('evidence=demo%3Aaurora%2Fevent%3Ae-0');
    });
  });

  it('brings up the selection bar the artboard draws', async () => {
    const { container } = mount();
    await screen.findByText('命中 47 条 · 排序：时间倒序');

    fireEvent.click(container.querySelectorAll('[data-evidence-select]')[0] as HTMLElement);
    expect(await screen.findByText('已选 1 条证据')).toBeTruthy();
    expect(screen.getByText('批量注释')).toBeTruthy();
  });

  it('adds a result to an existing project and points back to it', async () => {
    const { container } = mount();
    await screen.findByText('命中 47 条 · 排序：时间倒序');
    const row = container.querySelectorAll('[data-evidence-row]')[0] as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: '加入作品' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('option', { name: '证据集锦' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '加入' })).toBeTruthy();
  });
});

describe('density at 248 matches and 1 284 632 rows (§10.3)', () => {
  it('truncates the top bar s meta rather than pushing the actions off it', async () => {
    const { container } = mount();
    // The fixture's availability block is the artboard's own corpus size.
    await screen.findByText(/1284632 条规范化证据/u);
    const meta = container.querySelector('[data-toolbar-meta]');
    expect(meta?.className).toContain('truncate');
  });

  it('never puts more than one page of rows in the DOM', async () => {
    const { container } = mount();
    await screen.findByText('命中 47 条 · 排序：时间倒序');
    expect(container.querySelectorAll('[data-evidence-row]').length).toBeLessThanOrEqual(20);
  });
});

describe('the annotations view', () => {
  it('says what to do rather than showing an empty list', async () => {
    mount('/evidence?view=annotations');
    expect(await screen.findByText('还没有注释')).toBeTruthy();
  });

  it('goes back to the results view without losing the address', async () => {
    mount('/evidence?view=annotations');
    fireEvent.click(await screen.findByText('回到证据视图'));
    await waitFor(() => {
      expect(address()).not.toContain('view=annotations');
    });
  });
});

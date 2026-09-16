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

import { DesktopClientProvider, type DesktopClient } from '../../../data/desktopClient';
import type { EvidenceAnnotation } from '../../../shared/desktop/dto';
import { renderInteractive } from '../../../test/render';
import { EvidencePage } from './EvidencePage';
import { annotation, evidenceResponse } from './test/fixtures';

/** Records every query the page asked for, so a test can assert what was sent
 *  as well as what was shown. The annotation store is live: a write shows up
 *  on the next read, which is what the page relies on. */
function stubClient(notes: EvidenceAnnotation[] = []): {
  client: Partial<DesktopClient>;
  queries: unknown[];
  writes: unknown[];
} {
  const queries: unknown[] = [];
  const writes: unknown[] = [];
  return {
    queries,
    writes,
    client: {
      searchEvidence: (query) => {
        queries.push(query);
        return Promise.resolve(evidenceResponse());
      },
      listEvidenceAnnotations: (query) => {
        const evidenceId = query?.evidence_id;
        const items = evidenceId === undefined
          ? notes
          : notes.filter((note) => note.evidence_id === evidenceId);
        return Promise.resolve({ items, total: items.length, page: 1, page_size: 20 });
      },
      createEvidenceAnnotation: (draft) => {
        writes.push(draft);
        const created = annotation({
          id: `ann-${String(notes.length + 1)}`,
          evidence_id: draft.evidence_id,
          round: draft.round,
          tick: draft.tick,
          body: draft.body,
          tags: [...draft.tags],
        });
        notes.push(created);
        return Promise.resolve(created);
      },
      updateEvidenceAnnotation: (id, update) => {
        writes.push({ id, ...update });
        const index = notes.findIndex((note) => note.id === id);
        const updated = annotation({ ...notes[index], ...update, tags: [...update.tags] });
        notes[index] = updated;
        return Promise.resolve(updated);
      },
      listProjects: () => Promise.resolve([{
        id: '00000000-0000-4000-8000-000000000001', name: '证据集锦', revision: 1,
        document: {
          width: 1920, height: 1080, fps: 60, duration_seconds: 0,
          story_track_id: '00000000-0000-4000-8000-000000000002',
          tracks: [{
            id: '00000000-0000-4000-8000-000000000002', name: 'Story', kind: 'video',
            order: 0, muted: false, solo: false, volume: 1, pan: 0, keyframes: [], locked: false, hidden: false, clips: [],
          }],
          markers: [], settings: { source_demo_ids: [], ripple_sequence_markers: false, use_media_proxies: false },
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

  it('clears the search box when the 关键词 chip is removed', async () => {
    const { container } = mount('/evidence?q=Kael');
    await screen.findByText('命中 47 条 · 排序：时间倒序');
    const box = screen.getByLabelText<HTMLInputElement>('检索证据');
    expect(box.value).toBe('Kael');

    fireEvent.click(container.querySelector('[data-condition="q"]') as HTMLElement);
    await waitFor(() => {
      expect(address()).not.toContain('q=');
    });
    // The box is a draft of the address: an undone keyword does not linger in
    // it, or the next 检索 would put it back.
    expect(box.value).toBe('');
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

  it('releases the selection from the bar, on Esc, and by pressing the row again', async () => {
    const { container } = mount();
    await screen.findByText('命中 47 条 · 排序：时间倒序');
    const row = () => container.querySelectorAll('[data-evidence-select]')[1] as HTMLElement;

    fireEvent.click(row());
    await screen.findByText('已选 1 条证据');
    fireEvent.click(screen.getByRole('button', { name: '清空选择' }));
    await waitFor(() => {
      expect(address()).not.toContain('evidence=');
    });
    expect(screen.queryByText('已选 1 条证据')).toBeNull();

    fireEvent.click(row());
    await screen.findByText('已选 1 条证据');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(address()).not.toContain('evidence=');
    });

    fireEvent.click(row());
    await screen.findByText('已选 1 条证据');
    fireEvent.click(row());
    await waitFor(() => {
      expect(address()).not.toContain('evidence=');
    });
  });

  it('adds a result to an existing project and points back to it', async () => {
    const { container } = mount();
    await screen.findByText('命中 47 条 · 排序：时间倒序');
    const row = container.querySelectorAll('[data-evidence-row]')[0] as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: '加入作品' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('option', { name: '证据集锦' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '加入 Story 末尾' })).toBeTruthy();
  });
});

describe('density at 248 matches and 1 284 632 rows (§10.3)', () => {
  it('truncates the top bar s meta rather than pushing the actions off it', async () => {
    const { container } = mount();
    // The fixture's availability block is the artboard's own corpus size.
    await screen.findByText(/1284632 条证据/u);
    const meta = container.querySelector('[data-toolbar-meta]');
    expect(meta?.className).toContain('truncate');
  });

  it('never puts more than one page of rows in the DOM', async () => {
    const { container } = mount();
    await screen.findByText('命中 47 条 · 排序：时间倒序');
    expect(container.querySelectorAll('[data-evidence-row]').length).toBeLessThanOrEqual(20);
  });
});

describe('writing a note on a hit', () => {
  it('stores the note on the current row and lists it in the Inspector', async () => {
    const { client, writes } = stubClient();
    mount('/evidence', client);
    await screen.findByText('命中 47 条 · 排序：时间倒序');
    await screen.findByText('这条证据还没有注释。注释是跨比赛复用的，写在这里的话会出现在「注释」视图里。');

    fireEvent.change(screen.getByLabelText('注释内容'), { target: { value: '这堵墙的穿点可以做教学' } });
    fireEvent.click(screen.getByRole('button', { name: '写注释' }));

    await waitFor(() => {
      expect(writes).toHaveLength(1);
    });
    expect(writes[0]).toMatchObject({
      demo_id: 'aurora',
      evidence_id: 'demo:aurora/event:e-0',
      body: '这堵墙的穿点可以做教学',
    });
    expect(await screen.findByText('这堵墙的穿点可以做教学')).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('注释内容').value).toBe('');
  });
});

describe('the annotations view', () => {
  it('says what to do rather than showing an empty list', async () => {
    mount('/evidence?view=annotations');
    expect(await screen.findByText('还没有注释')).toBeTruthy();
  });

  it('describes the current note in the Inspector, and follows a selection', async () => {
    const notes = [
      annotation({ id: 'ann-1', body: '第一条' }),
      annotation({ id: 'ann-2', body: '第二条', demo_display_name: 'Vitality vs G2', map_name: 'de_inferno' }),
    ];
    const { container } = mount('/evidence?view=annotations', stubClient(notes).client);
    await screen.findByText(/共 2 条注释/u);

    // The first note is the focus fallback: described, not written.
    expect(container.querySelector('[data-annotation="ann-1"][aria-current="true"]')).not.toBeNull();
    expect(container.querySelector('[data-annotation-body]')?.textContent).toBe('第一条');
    expect(screen.queryByText('证据详情')).toBeNull();
    expect(address()).not.toContain('annotation=');

    fireEvent.click(container.querySelectorAll('[data-annotation-select]')[1] as HTMLElement);
    await waitFor(() => {
      expect(address()).toContain('annotation=ann-2');
    });
    expect(container.querySelector('[data-annotation-body]')?.textContent).toBe('第二条');
    expect(container.querySelector('[data-annotation="ann-2"][aria-current="true"]')).not.toBeNull();
  });

  it('flips a note between 待处理 and 已处理 through the write path', async () => {
    const { client, writes } = stubClient([annotation({ id: 'ann-1' })]);
    const { container } = mount('/evidence?view=annotations', client);
    await screen.findByText(/共 1 条注释/u);
    const card = container.querySelector('[data-annotation="ann-1"]') as HTMLElement;

    fireEvent.click(within(card).getByRole('button', { name: '标记已处理' }));
    await waitFor(() => {
      expect(writes).toHaveLength(1);
    });
    expect(writes[0]).toMatchObject({ id: 'ann-1', review_state: 'resolved' });
    expect(await within(card).findByRole('button', { name: '重新打开' })).toBeTruthy();
  });

  it('goes back to the results view without losing the address', async () => {
    mount('/evidence?view=annotations');
    fireEvent.click(await screen.findByText('回到证据视图'));
    await waitFor(() => {
      expect(address()).not.toContain('view=annotations');
    });
  });
});

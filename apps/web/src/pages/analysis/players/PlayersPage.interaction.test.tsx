/*
 * `interaction` project — the contract §10.3 wrote down, at the volume it wrote
 * it at.
 *
 *   「312 人、选择上限 2 时 20 个复选框禁用 18 个且不出现全选」
 *
 * All three halves are asserted here against a directory of 312 players served
 * 20 at a time, because a comment saying the cap holds is not the same thing as
 * a rendered page in which it does.
 */

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DesktopClientProvider, type DesktopClient } from '../../../data/desktopClient';
import { PLAYER_DIRECTORY_COUNT } from '../../../domain/densityFixtures';
import { renderInteractive } from '../../../test/render';
import { PlayersPage, SEARCH_DEBOUNCE_MS } from './PlayersPage';
import { PLAYER_COMPARE_LIMIT, PLAYER_PAGE_SIZE } from './playerDirectoryParams';
import { directoryItems } from './test/fixtures';

/** The whole directory, served one page at a time — which is what the real
 *  route does, and what keeps 312 rows out of the DOM. */
function stubClient(total = PLAYER_DIRECTORY_COUNT): Partial<DesktopClient> {
  const everyone = directoryItems(total);
  const coverage = { projected_demos: 248, total_analyses: 248, projection_complete: true };
  return {
    listPlayers: (query) => {
      const page = query.page ?? 1;
      const size = query.page_size ?? PLAYER_PAGE_SIZE;
      const start = (page - 1) * size;
      const matches = everyone.filter((player) => query.search === undefined || player.name.includes(query.search));
      return Promise.resolve({
        items: matches.slice(start, start + size),
        total: matches.length,
        page,
        page_size: size,
        coverage,
      });
    },
    getPlayer: (steamId) => {
      const player = everyone.find((candidate) => candidate.steam_id === steamId);
      return player === undefined
        ? Promise.reject(new Error('Player not found'))
        : Promise.resolve({ player, coverage });
    },
  };
}

/** Publishes the current address so an assertion can read what the page wrote
 *  to it — §4.4 makes the URL the state, so this is the state under test. */
function AddressProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="address">{`${location.pathname}${location.search}`}</output>
      {/* The sidebar's 「选手目录」: the same route with its query dropped. */}
      <button type="button" data-testid="reset" onClick={() => navigate('/players')}>
        reset
      </button>
    </>
  );
}

function mount(url = '/players', client = stubClient()) {
  return renderInteractive(
    <DesktopClientProvider client={client as DesktopClient}>
      <MemoryRouter initialEntries={[url]}>
        <AddressProbe />
        <Routes>
          <Route path="/players" element={<PlayersPage />} />
        </Routes>
      </MemoryRouter>
    </DesktopClientProvider>,
  );
}

function address(): string {
  return screen.getByTestId('address').textContent ?? '';
}

/**
 * The body's checkboxes, once the first page has actually landed. `findByRole`
 * on the table alone would resolve against the loading state — `DataTable`
 * renders its head and its `<colgroup>` before any row exists — so this waits
 * for a row instead.
 */
/* Radix renders a checkbox as a `<button role="checkbox">`, so the state is
   read off `aria-checked` rather than off a native `.checked`. */
async function rowCheckboxes(): Promise<HTMLButtonElement[]> {
  const table = await screen.findByRole('table');
  await waitFor(() => {
    expect(table.querySelectorAll('tbody tr').length).toBeGreaterThan(0);
  });
  return within(table)
    .getAllByRole('checkbox')
    .filter((box): box is HTMLButtonElement => box instanceof HTMLButtonElement);
}

function isTicked(box: Element): boolean {
  return box.getAttribute('aria-checked') === 'true';
}

describe('the §10.3 selection contract at 312 players', () => {
  it('puts 20 rows and 20 checkboxes on screen, not 312', async () => {
    mount();
    const boxes = await rowCheckboxes();
    expect(boxes).toHaveLength(PLAYER_PAGE_SIZE);
  });

  it('prints the corpus total in the footer, so the page is not a silent truncation', async () => {
    mount();
    // The pager's span also carries 「· 第 1–20 条」, so match on a substring.
    expect(
      await screen.findByText(new RegExp(`共 ${String(PLAYER_DIRECTORY_COUNT)} 名选手`, 'u')),
    ).toBeTruthy();
  });

  it('draws no select-all box — a select-all contradicts a cap', async () => {
    mount();
    await rowCheckboxes();
    expect(screen.queryByLabelText('全选本页')).toBeNull();
  });

  it('disables the other 18 once two are ticked, and hides none of them', async () => {
    mount();
    const boxes = await rowCheckboxes();

    fireEvent.click(boxes[0] as HTMLButtonElement);
    fireEvent.click(boxes[1] as HTMLButtonElement);

    await waitFor(async () => {
      const after = await rowCheckboxes();
      expect(after).toHaveLength(PLAYER_PAGE_SIZE);
      expect(after.filter(isTicked)).toHaveLength(PLAYER_COMPARE_LIMIT);
      expect(after.filter((box) => box.disabled)).toHaveLength(
        PLAYER_PAGE_SIZE - PLAYER_COMPARE_LIMIT,
      );
    });
  });

  it('lets a ticked box be untangled — a cap must never trap the user', async () => {
    mount();
    const boxes = await rowCheckboxes();
    fireEvent.click(boxes[0] as HTMLButtonElement);
    fireEvent.click(boxes[1] as HTMLButtonElement);
    await waitFor(() => {
      expect(address()).toContain('compare=');
    });

    const [first] = await rowCheckboxes();
    fireEvent.click(first as HTMLButtonElement);
    await waitFor(async () => {
      const after = await rowCheckboxes();
      expect(after.filter(isTicked)).toHaveLength(1);
      expect(after.filter((box) => box.disabled)).toHaveLength(0);
    });
  });
});

describe('the selection is in the address bar (§4.4)', () => {
  it('writes the ticked players, in the order they were ticked', async () => {
    mount();
    const boxes = await rowCheckboxes();
    fireEvent.click(boxes[1] as HTMLButtonElement);
    fireEvent.click(boxes[0] as HTMLButtonElement);

    await waitFor(() => {
      expect(address()).toContain('compare=STEAM_1%2CSTEAM_0');
    });
  });

  it('restores a comparison from a pasted link', async () => {
    const { container } = mount('/players?compare=STEAM_0,STEAM_1');
    await rowCheckboxes();
    // The docked Inspector shows the two cards; 「比较 X 与 Y」 is the folded
    // strip's summary, which `useCollapsed` does not produce at test width.
    await waitFor(() => {
      expect(container.querySelector('[data-compare-card="STEAM_0"]')).not.toBeNull();
      expect(container.querySelector('[data-compare-card="STEAM_1"]')).not.toBeNull();
    });
  });

  it('refuses a third player smuggled in through the URL', async () => {
    mount('/players?compare=STEAM_0,STEAM_1,STEAM_2');
    await screen.findByRole('table');
    const boxes = await rowCheckboxes();
    expect(boxes.filter(isTicked)).toHaveLength(PLAYER_COMPARE_LIMIT);
  });
});

describe('paging', () => {
  it('compares players across pages and keeps their identities through a new search', async () => {
    const { container } = mount();
    fireEvent.click((await rowCheckboxes())[0] as HTMLButtonElement);
    fireEvent.click(screen.getByLabelText('下一页'));
    const table = screen.getByRole('table');
    await within(table).findByText('Kael-20');
    fireEvent.click(within(table).getByRole('checkbox', { name: 'Kael-20' }));
    await waitFor(() => {
      expect(container.querySelector('[data-compare-card="STEAM_0"]')).not.toBeNull();
      expect(container.querySelector('[data-compare-card="STEAM_20"]')).not.toBeNull();
    });

    const box = screen.getByLabelText('搜索选手或别名');
    fireEvent.change(box, { target: { value: 'Kael-25' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await within(table).findByText('Kael-25');
    expect(within(table).queryByText('Kael-0')).toBeNull();
    expect(within(table).queryByText('Kael-20')).toBeNull();
    expect(container.querySelector('[data-compare-card="STEAM_0"]')).not.toBeNull();
    expect(container.querySelector('[data-compare-card="STEAM_20"]')).not.toBeNull();
    expect(container.querySelector('[data-compare-metric="kd"]')).not.toBeNull();
  });

  it('asks the service for the next page rather than slicing on the client', async () => {
    mount();
    await rowCheckboxes();

    fireEvent.click(screen.getByLabelText('下一页'));
    await waitFor(() => {
      expect(address()).toContain('page=2');
    });
    // Row 21 of 312 — proof the second page came from the service.
    expect(await screen.findAllByText('Kael-20')).not.toHaveLength(0);
  });
});

describe('comparison profile reads', () => {
  it('keeps a resolved player visible and retries a failed selected profile', async () => {
    const client = stubClient();
    let failed = false;
    const getPlayer = vi.fn((steamId: string) => {
      if (steamId === 'STEAM_20' && !failed) {
        failed = true;
        return Promise.reject(new Error('selected profile unavailable'));
      }
      return client.getPlayer!(steamId);
    });
    const { container } = mount('/players?compare=STEAM_0,STEAM_20', { ...client, getPlayer });
    const error = await screen.findByRole('alert');
    expect(error.textContent).toContain('selected profile unavailable');
    expect(container.querySelector('[data-compare-card="STEAM_0"]')).not.toBeNull();
    expect(screen.queryByText(/还差一名/u)).toBeNull();
    expect(screen.getByRole('button', { name: '清空选择' })).toBeTruthy();
    fireEvent.click(within(error).getByRole('button', { name: '重试' }));
    await waitFor(() => expect(container.querySelector('[data-compare-card="STEAM_20"]')).not.toBeNull());
    expect(getPlayer.mock.calls.filter(([id]) => id === 'STEAM_20')).toHaveLength(2);
    expect(container.querySelector('[data-compare-metric="kd"]')).not.toBeNull();
  });

  it('lets a narrow window clear an unresolved selection directly from its summary', async () => {
    const previous = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        matches: true, media: query, addEventListener: () => undefined, removeEventListener: () => undefined,
      }),
    });
    try {
      const client = stubClient();
      mount('/players?compare=STEAM_0,STEAM_20', {
        ...client,
        getPlayer: (id) => id === 'STEAM_20' ? new Promise(() => undefined) : client.getPlayer!(id),
      });
      await screen.findByText('已选 2 名 · 正在读取档案');
      expect(screen.queryByRole('dialog')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: '清空选择' }));
      await waitFor(() => expect(address()).not.toContain('compare='));
      expect((await rowCheckboxes()).every((box) => !box.disabled)).toBe(true);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(window, 'matchMedia');
      else Object.defineProperty(window, 'matchMedia', previous);
    }
  });
});

describe('the docked comparison and the selection bar', () => {
  it('draws each action once — the bar clears, the cards link', async () => {
    mount('/players?compare=STEAM_0,STEAM_1');
    await rowCheckboxes();
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: '清空选择' })).toHaveLength(1);
    });
    // One profile entry per compared player, both worded the same way, and
    // none of them repeated on the selection bar.
    expect(screen.getByRole('link', { name: '打开 Kael-0 的档案' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '打开 Kael-1 的档案' })).toBeTruthy();
    expect(screen.queryByText(/查看 .* 的档案/u)).toBeNull();
    expect(screen.getByText('已选 2 名 · 比较上限 2 名')).toBeTruthy();
  });
});

describe('search', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for Chinese composition to finish before debouncing or accepting Enter', async () => {
    mount();
    await rowCheckboxes();
    const box = screen.getByLabelText('搜索选手或别名');
    fireEvent.compositionStart(box);
    fireEvent.change(box, { target: { value: 'zhong' } });
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 10));
    expect(address()).toBe('/players');
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    expect(address()).toBe('/players');
    fireEvent.compositionEnd(box, { data: '中文', target: { value: '中文' } });
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 10));
    expect(address()).toBe(`/players?q=${encodeURIComponent('中文')}`);
  });

  it('leaves a composition confirmation with keyCode 229 to the input method', async () => {
    mount();
    await rowCheckboxes();
    const box = screen.getByLabelText('搜索选手或别名');
    fireEvent.change(box, { target: { value: '中文' } });
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 229 });
    expect(address()).toBe('/players');
  });

  it('filters as you type, a debounce after the last keystroke', async () => {
    mount();
    await rowCheckboxes();
    const box = screen.getByLabelText('搜索选手或别名') as HTMLInputElement;

    fireEvent.change(box, { target: { value: 'z' } });
    fireEvent.change(box, { target: { value: 'zy' } });
    expect(address()).toBe('/players');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 10);
    });
    expect(address()).toBe('/players?q=zy');
    expect(box.value).toBe('zy');
  });

  it('commits on Enter at once', async () => {
    mount();
    await rowCheckboxes();
    const box = screen.getByLabelText('搜索选手或别名') as HTMLInputElement;

    fireEvent.change(box, { target: { value: 'kael' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(address()).toBe('/players?q=kael');
  });

  it('follows the address when the query is reset under it, so the box never shows a stale filter', async () => {
    mount('/players?q=abc');
    await screen.findByText('没有匹配的选手');
    const box = screen.getByLabelText('搜索选手或别名') as HTMLInputElement;
    expect(box.value).toBe('abc');

    fireEvent.click(screen.getByTestId('reset'));
    await waitFor(() => {
      expect(address()).toBe('/players');
    });
    expect(box.value).toBe('');

    // And the empty draft does not write `q=` back a debounce later.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 10);
    });
    expect(address()).toBe('/players');
  });
});

describe('an empty search', () => {
  it('offers another search and keeps the clear action available', async () => {
    mount('/players?q=zzz', {
      listPlayers: () =>
        Promise.resolve({
          items: [],
          total: 0,
          page: 1,
          page_size: PLAYER_PAGE_SIZE,
          coverage: { projected_demos: 248, total_analyses: 248, projection_complete: true },
        }),
    });
    expect(await screen.findByText(/请尝试其他名字或别名/u)).toBeTruthy();
    expect(screen.getByText('清空搜索')).toBeTruthy();
  });
});

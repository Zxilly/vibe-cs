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

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { DesktopClientProvider, type DesktopClient } from '../../data/desktopClient';
import { PLAYER_DIRECTORY_COUNT } from '../../domain/densityFixtures';
import { renderInteractive } from '../../test/render';
import { PlayersPage } from '../PlayersPage';
import { PLAYER_COMPARE_LIMIT, PLAYER_PAGE_SIZE } from './playerDirectoryParams';
import { directoryItems } from './test/fixtures';

/** The whole directory, served one page at a time — which is what the real
 *  route does, and what keeps 312 rows out of the DOM. */
function stubClient(total = PLAYER_DIRECTORY_COUNT): Partial<DesktopClient> {
  const everyone = directoryItems(total);
  return {
    listPlayers: (query) => {
      const page = query.page ?? 1;
      const size = query.page_size ?? PLAYER_PAGE_SIZE;
      const start = (page - 1) * size;
      return Promise.resolve({
        items: everyone.slice(start, start + size),
        total,
        page,
        page_size: size,
        coverage: { projected_demos: 248, total_analyses: 248, projection_complete: true },
      });
    },
  };
}

/** Publishes the current address so an assertion can read what the page wrote
 *  to it — §4.4 makes the URL the state, so this is the state under test. */
function AddressProbe() {
  const location = useLocation();
  return <output data-testid="address">{`${location.pathname}${location.search}`}</output>;
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
  it('asks the service for the next page rather than slicing on the client', async () => {
    mount();
    await rowCheckboxes();

    fireEvent.click(screen.getByLabelText('下一页'));
    await waitFor(() => {
      expect(address()).toContain('page=2');
    });
    // Row 21 of 312 — proof the second page came from the service.
    expect(await screen.findByText('Kael-20')).toBeTruthy();
  });
});

describe('an empty search', () => {
  it('states the matching contract instead of apologising', async () => {
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
    expect(await screen.findByText(/不做拼音和模糊匹配/u)).toBeTruthy();
    expect(screen.getByText('清空搜索')).toBeTruthy();
  });
});

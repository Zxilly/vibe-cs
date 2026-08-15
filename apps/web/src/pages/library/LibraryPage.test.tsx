/*
 * `markup` project — 「02 Demo 资料库」 as it renders.
 *
 * Four things are asserted here and nowhere else:
 *
 *   1. the frame the artboard draws — Page + Toolbar + filter strip + table +
 *      Inspector — is really assembled from `design/**`, not re-implemented
 *   2. the three states are all reachable and none of them invents data (no
 *      percentage, no progress bar, no fabricated count)
 *   3. every service-backed action renders **disabled with its reason** while
 *      the gate has not said 「在线」 — 「不隐藏、不静默失败」
 *   4. the two §7 views, table and card, both come off the same address
 *
 * Nothing here touches IPC: the bridge is an empty stub and the rows arrive by
 * seeding the cache, which is the only way a `renderToStaticMarkup` tree can
 * hold data at all (no effect runs, so no query fetches).
 */

import { describe, expect, it } from 'vitest';

import {
  FOLD_CONTENT_WIDTH_WITH_DOCKED_INSPECTOR_PX,
  LIBRARY_MATCH_COUNT,
} from '../../domain/densityFixtures';
import {
  CONFIG_FIXTURE,
  DEMO_FIXTURE,
  METADATA_FIXTURE,
  TAG_FIXTURE,
  WATCH_FIXTURE,
  demoPage,
  makeDemo,
  renderLibraryMarkup,
} from './test/renderLibrary';

/**
 * A percentage in rendered *text*. Class names carry `color-mix(… 18%)` and a
 * skeleton bar carries `width:88%`, so a bare `toContain('%')` would fail on
 * styling rather than on invented progress.
 */
const TEXT_PERCENTAGE = />[^<]*\d+\s*%/u;

const ONLINE = {
  demos: demoPage([DEMO_FIXTURE]),
  watch: WATCH_FIXTURE,
  tags: [TAG_FIXTURE],
  config: CONFIG_FIXTURE,
  serviceOnline: true,
} as const;

describe('the frame', () => {
  const html = renderLibraryMarkup({ seed: ONLINE });

  it('is the design system’s Page, with all four slots in use', () => {
    expect(html).toContain('data-page=');
    expect(html).toContain('data-page-toolbar');
    expect(html).toContain('data-page-bar');
    expect(html).toContain('data-page-body');
  });

  it('carries the artboard’s title and its 「248 场 · 3 个监听目录」 meta line', () => {
    expect(html).toContain('data-toolbar-title="true"');
    expect(html).toContain('Demo 资料库');
    expect(html).toContain('1 场');
    expect(html).toContain('3 个监听目录');
  });

  it('keeps 导入 Demo in the Toolbar’s primary slot, which never folds (§8)', () => {
    const primary = html.slice(html.indexOf('data-toolbar-primary'));
    expect(primary).toContain('导入 Demo');
  });

  it('draws the filter strip with all four dropdowns and the two right-hand links', () => {
    expect(html).toContain('data-library-filters');
    expect(html).toContain('地图');
    expect(html).toContain('状态');
    expect(html).toContain('来源');
    expect(html).toContain('标签');
    expect(html).toContain('列配置');
    expect(html).toContain('导出元数据');
  });

  it('docks the Inspector rather than re-implementing one', () => {
    expect(html).toContain('data-inspector="docked"');
    expect(html).toContain('比赛详情');
  });
});

describe('the table', () => {
  const html = renderLibraryMarkup({ seed: ONLINE });

  it('renders the row with the artboard’s own cell formats', () => {
    expect(html).toContain('Aurora vs Meridian');
    expect(html).toContain('Mirage');
    expect(html).toContain('08-14 20:11');
    expect(html).toContain('41:02');
  });

  it('offers a checkbox column but no select-all, because the selection is capped', () => {
    // `DataTable` drops the header box when `selectionLimit` is set — a
    // select-all contradicts 「上限 12 场」.
    expect(html).toContain('选择 Aurora vs Meridian');
    expect(html).not.toContain('全选本页');
  });

  it('prints the server’s total in the pager, not the length of this page', () => {
    const html248 = renderLibraryMarkup({
      seed: {
        ...ONLINE,
        demos: demoPage(Array.from({ length: 20 }, (_, index) => makeDemo(index)), 248),
      },
    });
    expect(html248).toContain('共 248 条');
    // The failure this guards against is printing 「共 20 条」 — the length of
    // what arrived — which is §10.3's silent truncation with a number on it.
    expect(html248).not.toContain('共 20 条');
  });

  it('takes an analysed row to its workspace', () => {
    expect(html).toContain('href="/match/demo-a"');
    expect(html).toContain('工作区');
  });
});

describe('the states', () => {
  it('loads with a skeleton and no invented percentage', () => {
    const html = renderLibraryMarkup({ seed: { serviceOnline: true } });
    expect(html).toContain('正在读取资料库');
    // A percentage in *text*, not in a class or a skeleton bar's width — the
    // rule is 「有真实分母时才用进度条，否则只给阶段名」.
    expect(html).not.toMatch(TEXT_PERCENTAGE);
    expect(html).not.toContain('role="progressbar"');
  });

  it('offers a way to fill an empty library', () => {
    const html = renderLibraryMarkup({ seed: { ...ONLINE, demos: demoPage([]) } });
    expect(html).toContain('还没有比赛');
    expect(html).toContain('导入 Demo');
    expect(html).toContain('添加目录');
  });

  it('says 「没有命中」 — not 「还没有比赛」 — when a filter is what emptied it', () => {
    const html = renderLibraryMarkup({
      at: '/library?q=nothing',
      seed: { ...ONLINE, demos: demoPage([]) },
    });
    expect(html).toContain('没有命中的证据');
    expect(html).toContain('清空条件');
  });
});

describe('需要服务', () => {
  const offline = renderLibraryMarkup({ seed: { ...ONLINE, serviceOnline: false } });

  it('disables 导入 Demo and writes the reason on it, instead of hiding it', () => {
    expect(offline).toContain('导入 Demo');
    expect(offline).toContain('· 需要服务');
    expect(offline).toContain('正在连接本地服务，稍后即可使用');
    expect(offline).toContain('disabled=""');
  });

  it('leaves the read-only content alone', () => {
    // 「只读内容照常可用」 — the rows, the pager and the Inspector still render.
    expect(offline).toContain('Aurora vs Meridian');
    expect(offline).toContain('共 1 条');
  });

  it('enables the same action once the gate has an answer', () => {
    const online = renderLibraryMarkup({ seed: ONLINE });
    expect(online).not.toContain('· 需要服务');
  });
});

describe('the card view', () => {
  const html = renderLibraryMarkup({ at: '/library?view=card', seed: ONLINE });

  it('is what ?view=card selects', () => {
    expect(html).toContain('data-library-cards');
    expect(html).not.toContain('data-library-table');
  });

  it('keeps the artboard’s own caveat about large libraries', () => {
    expect(html).toContain('适合几十场以内的个人资料库；大库仍建议用表格');
  });

  it('shows what the wire has and does not fake a highlight count', () => {
    expect(html).toContain('13 : 11');
    expect(html).toContain('24 回合');
    expect(html).not.toContain('条高光');
    expect(html).not.toMatch(TEXT_PERCENTAGE);
  });
});

describe('the Inspector', () => {
  const html = renderLibraryMarkup({
    at: '/library',
    seed: { ...ONLINE, detail: DEMO_FIXTURE, metadata: METADATA_FIXTURE },
  });

  it('invites a selection rather than showing an empty shell', () => {
    expect(html).toContain('在左侧选一场比赛');
  });

  it('never claims a file size or a checksum the wire does not carry', () => {
    expect(html).not.toContain('大小');
    expect(html).not.toContain('校验');
  });
});

describe('density (§10.3)', () => {
  it('pages the real corpus into 20 rows and prints the whole count in the footer', () => {
    // `LIBRARY_MATCH_COUNT` is 「02 Demo 资料库」's own 「248 场」, recorded with
    // its provenance in `domain/densityFixtures.ts` — the count §10.3 measured
    // the unpaged table at 10 416px with.
    const html = renderLibraryMarkup({
      seed: {
        ...ONLINE,
        demos: demoPage(
          Array.from({ length: 20 }, (_, index) => makeDemo(index)),
          LIBRARY_MATCH_COUNT,
        ),
      },
    });

    expect(html.match(/data-row-id=/gu)).toHaveLength(20);
    expect(html).toContain(`共 ${String(LIBRARY_MATCH_COUNT)} 条`);
    expect(html).toContain('第 1–20 条');
  });

  it('leaves the docked Inspector out of the fold, where 9 columns share 616px', () => {
    // §8 rule 2 and §10.3's arithmetic: 996 − 380 = 616, ~68px a column. The
    // page never renders that arrangement — below the breakpoint the Inspector
    // is a strip and the table gets the whole 996 — and the interaction test
    // proves the switch. This pins the number the decision rests on.
    expect(FOLD_CONTENT_WIDTH_WITH_DOCKED_INSPECTOR_PX).toBe(616);
  });

  it('scrolls the table inside its own box, never on the body', () => {
    const html = renderLibraryMarkup({ seed: ONLINE });
    // `DataTable`'s own `overflow-auto` box; §10.3 rule 1 是横向滚动必须发生在
    // 容器内部.
    expect(html).toContain('overflow-auto');
    expect(html).toContain('data-library-filters');
    expect(html.slice(html.indexOf('data-library-filters'))).toContain('overflow-x-auto');
  });

  it('truncates the identity column instead of letting a long name push 状态 out', () => {
    const html = renderLibraryMarkup({
      seed: {
        ...ONLINE,
        demos: demoPage([
          makeDemo(0, { display_name: 'Aurora vs Meridian · 一个长到必须截断的比赛名'.repeat(4) }),
        ]),
      },
    });
    expect(html).toContain('truncate');
  });
});

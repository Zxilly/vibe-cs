import { describe, expect, it } from 'vitest';

import {
  BAR_HEIGHT_CLAIMS,
  BAR_HEIGHT_MERGE,
  BAR_HEIGHT_PX,
  COLOR_MERGE,
  CONTROL_HEIGHT_FLOOR_PX,
  CONTROL_HEIGHT_MERGE,
  CONTROL_HEIGHT_PX,
  CONTROL_LOOKALIKE_HEIGHTS,
  DARK_DERIVATION_EVIDENCE,
  DESIGN_ARTBOARDS,
  DESIGN_BORDER_RADIUS_DECLARATIONS,
  DESIGN_DISTINCT_VALUE_COUNTS,
  EXTRACTION_RULES,
  FONT_SIZE_MERGE,
  FONT_SIZE_PX,
  INDUSTRY_COLORS,
  PANEL_WIDTH_FROM_PROSE,
  PANEL_WIDTH_MAX_FOLD_PX,
  PANEL_WIDTH_MERGE,
  PANEL_WIDTH_PX,
  RADIUS_PX,
  SPACING_BASE_PX,
  SPACING_MAX_DELTA_PX,
  SPACING_MERGE,
  STATUS_COLORS,
  UNMAPPED_VALUES,
  isAllowlistedUnmapped,
  lookupBarHeightTokens,
  lookupColorToken,
  lookupControlHeightToken,
  lookupFontSizeToken,
  lookupPanelWidthToken,
} from './tokens.data';

/**
 * Architecture-constraint test required by spec §6.4: every size the design
 * reference uses must reach a token, and anything that cannot must be an
 * explicit, reasoned entry on the allowlist.
 *
 * The `OBSERVED_*` fixtures below are the raw extraction result — every
 * distinct bare value found across the 20 artboards, with its occurrence count.
 * Each was produced by the correspondingly named rule in `EXTRACTION_RULES`, so
 * anyone can re-run that rule over the design reference and get these numbers
 * back. They are deliberately independent of the merge tables in
 * `tokens.data.ts`: dropping or mistyping an entry there fails here rather than
 * silently shrinking the coverage claim.
 */

/** `EXTRACTION_RULES.fontSize` — 1602 declarations over 17 distinct values. */
const OBSERVED_FONT_SIZES: Readonly<Record<number, number>> = {
  10: 16,
  11: 216,
  12: 491,
  13: 515,
  14: 168,
  15: 23,
  16: 35,
  17: 36,
  18: 36,
  19: 20,
  20: 4,
  21: 1,
  22: 19,
  24: 1,
  26: 12,
  40: 8,
  56: 1,
};

/** `EXTRACTION_RULES.controlHeight` — 223 declarations over 9 distinct values. */
const OBSERVED_CONTROL_HEIGHTS: Readonly<Record<number, number>> = {
  26: 2,
  28: 25,
  30: 81,
  32: 58,
  34: 42,
  36: 5,
  38: 6,
  40: 1,
  42: 3,
};

/** `EXTRACTION_RULES.barHeight` — 340 declarations over 20 distinct values. */
const OBSERVED_BAR_HEIGHTS: Readonly<Record<number, number>> = {
  26: 3,
  28: 1,
  30: 6,
  32: 30,
  34: 28,
  36: 46,
  38: 50,
  40: 67,
  42: 43,
  44: 9,
  46: 9,
  48: 3,
  50: 2,
  52: 15,
  56: 18,
  64: 4,
  66: 1,
  80: 1,
  92: 2,
  96: 2,
};

/** `EXTRACTION_RULES.panelWidth` — 33 declarations over 20 distinct values. */
const OBSERVED_PANEL_WIDTHS: Readonly<Record<number, number>> = {
  56: 1,
  110: 1,
  132: 1,
  180: 1,
  190: 2,
  200: 3,
  220: 1,
  270: 1,
  310: 1,
  320: 1,
  330: 1,
  340: 2,
  360: 1,
  380: 3,
  400: 3,
  420: 2,
  440: 2,
  460: 3,
  470: 1,
  520: 2,
};

/** `EXTRACTION_RULES.hexColor` — 343 literals over 49 distinct values. */
const OBSERVED_HEX_COLORS: Readonly<Record<string, number>> = {
  '#4d7a5a': 43,
  '#33363a': 30,
  '#c9a55a': 29,
  '#a3453c': 25,
  '#ededee': 19,
  '#a8abae': 18,
  '#7d332c': 17,
  '#94bce3': 16,
  '#a8792f': 14,
  '#c9a8a3': 12,
  '#7a5a16': 11,
  '#d6d8da': 9,
  '#eceded': 8,
  '#7d8083': 8,
  '#26292c': 8,
  '#5980a6': 6,
  '#f7efdd': 5,
  '#22303d': 5,
  '#d8bb86': 4,
  '#1d1f21': 4,
  '#1d2d3d': 4,
  '#4a4e53': 4,
  '#16181a': 3,
  '#0f1113': 3,
  '#3f5f7d': 3,
  '#8a6f2c': 3,
  '#f2f2f3': 2,
  '#6ea87f': 2,
  '#cf7a72': 2,
  '#a8c6e0': 2,
  '#2a2d31': 2,
  '#3a3d41': 2,
  '#303438': 2,
  '#f7ecea': 2,
  '#e6e6e7': 2,
  '#1d1f20': 1,
  '#416180': 1,
  '#eef6ff': 1,
  '#d3a85f': 1,
  '#cfe2f4': 1,
  '#b9c6d2': 1,
  '#6b3b36': 1,
  '#241a19': 1,
  '#e5a49d': 1,
  '#1a2229': 1,
  '#4a7396': 1,
  '#2a3d4e': 1,
  '#a8c3a9': 1,
  '#eef4ee': 1,
};

/** `EXTRACTION_RULES.spacing` — 26 distinct values. */
const OBSERVED_SPACING: readonly number[] = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 18, 20, 22, 24, 26, 28, 32, 40, 64, 94,
];

const numericKeys = (record: Readonly<Record<number, number>>): number[] =>
  Object.keys(record).map((key) => Number(key));

describe('design token data — shape', () => {
  it('names all 20 artboards of the design reference exactly once', () => {
    expect(DESIGN_ARTBOARDS).toHaveLength(20);
    expect(new Set(DESIGN_ARTBOARDS).size).toBe(20);
  });

  it('writes down the rule behind every observed fixture', () => {
    for (const rule of ['fontSize', 'controlHeight', 'barHeight', 'panelWidth', 'hexColor', 'spacing'] as const) {
      expect(EXTRACTION_RULES[rule].length, `${rule} 的抽取判据没写清楚`).toBeGreaterThan(20);
    }
  });

  it('sources every merge entry from an artboard that exists', () => {
    const known = new Set<string>(DESIGN_ARTBOARDS);
    const entries = [
      ...FONT_SIZE_MERGE,
      ...CONTROL_HEIGHT_MERGE,
      ...CONTROL_LOOKALIKE_HEIGHTS,
      ...BAR_HEIGHT_MERGE,
      ...PANEL_WIDTH_MERGE,
    ];
    for (const entry of entries) {
      for (const artboard of entry.from) {
        expect(known.has(artboard), `${entry.raw} 引用了不存在的画板 ${artboard}`).toBe(true);
      }
    }
    for (const entry of [...COLOR_MERGE, ...UNMAPPED_VALUES]) {
      for (const artboard of entry.from) {
        expect(known.has(artboard)).toBe(true);
      }
    }
    for (const prose of PANEL_WIDTH_FROM_PROSE) {
      expect(known.has(prose.from)).toBe(true);
    }
  });

  it('keeps ordered scales unique and records the intentional 190px semantic alias', () => {
    for (const scale of [FONT_SIZE_PX, CONTROL_HEIGHT_PX, BAR_HEIGHT_PX]) {
      const values = Object.values(scale);
      expect(new Set(values).size).toBe(values.length);
    }
    expect(PANEL_WIDTH_PX['--w-track-head']).toBe(PANEL_WIDTH_PX['--w-subnav']);
    expect(Object.values(FONT_SIZE_PX)).toEqual([...Object.values(FONT_SIZE_PX)].sort((a, b) => a - b));
    expect(Object.values(CONTROL_HEIGHT_PX)).toEqual([...Object.values(CONTROL_HEIGHT_PX)].sort((a, b) => a - b));
  });
});

describe('§3.2 type scale', () => {
  it('holds the ten levels the spec fixes', () => {
    expect(FONT_SIZE_PX).toEqual({
      '--text-2xs': 11,
      '--text-xs': 12,
      '--text-sm': 13,
      '--text-base': 14,
      '--text-md': 15,
      '--text-lg': 17,
      '--text-xl': 19,
      '--text-2xl': 22,
      '--text-3xl': 26,
      '--text-4xl': 40,
    });
    expect(DESIGN_DISTINCT_VALUE_COUNTS.fontSize).toBe(numericKeys(OBSERVED_FONT_SIZES).length);
  });

  it('maps every font size in the design reference to a token or the allowlist', () => {
    for (const raw of numericKeys(OBSERVED_FONT_SIZES)) {
      const token = lookupFontSizeToken(raw);
      if (token === undefined) {
        expect(
          isAllowlistedUnmapped('font-size', `${raw}px`),
          `font-size:${raw}px 既没有 token 也不在 allowlist 里`,
        ).toBe(true);
        continue;
      }
      expect(FONT_SIZE_PX[token]).toBeGreaterThan(0);
    }
  });

  it('carries the occurrence count each raw value actually has', () => {
    for (const entry of FONT_SIZE_MERGE) {
      expect(entry.count, `font-size:${entry.raw}px 的出现次数与抽取结果不符`).toBe(OBSERVED_FONT_SIZES[entry.raw]);
    }
  });

  it('never moves a font size further than the nearest level', () => {
    const levels = Object.values(FONT_SIZE_PX);
    for (const entry of FONT_SIZE_MERGE) {
      const target = FONT_SIZE_PX[entry.token];
      // `reduce` keeps the first of a tie, i.e. the lower level — the spec's rule.
      const nearest = levels.reduce((best, level) =>
        Math.abs(level - entry.raw) < Math.abs(best - entry.raw) ? level : best,
      );
      expect(Math.abs(target - entry.raw), `font-size:${entry.raw}px → ${entry.token} 不是最近一级`).toBe(
        Math.abs(nearest - entry.raw),
      );
    }
  });
});

describe('§3.3 control heights', () => {
  it('holds the four levels the spec fixes and honours the 32px floor', () => {
    expect(CONTROL_HEIGHT_PX).toEqual({
      '--h-ctl-sm': 32,
      '--h-ctl-md': 34,
      '--h-ctl-lg': 38,
      '--h-ctl-hero': 42,
    });
    for (const px of Object.values(CONTROL_HEIGHT_PX)) {
      expect(px).toBeGreaterThanOrEqual(CONTROL_HEIGHT_FLOOR_PX);
    }
    expect(DESIGN_DISTINCT_VALUE_COUNTS.controlHeight).toBe(numericKeys(OBSERVED_CONTROL_HEIGHTS).length);
  });

  it('maps every control height in the design reference, with no exceptions', () => {
    for (const raw of numericKeys(OBSERVED_CONTROL_HEIGHTS)) {
      const token = lookupControlHeightToken(raw);
      expect(token, `height:${raw}px 的控件没有 token —— §3.3 明写「无例外」`).toBeDefined();
      if (token !== undefined) {
        expect(CONTROL_HEIGHT_PX[token]).toBeGreaterThanOrEqual(CONTROL_HEIGHT_FLOOR_PX);
      }
    }
    expect(UNMAPPED_VALUES.some((entry) => entry.property === 'control-height')).toBe(false);
  });

  it('raises sub-floor controls rather than rounding them down', () => {
    for (const entry of [...CONTROL_HEIGHT_MERGE, ...CONTROL_LOOKALIKE_HEIGHTS]) {
      if (entry.raw < CONTROL_HEIGHT_FLOOR_PX) {
        expect(CONTROL_HEIGHT_PX[entry.token], `height:${entry.raw}px 应被抬到 32px 底线`).toBe(
          CONTROL_HEIGHT_FLOOR_PX,
        );
      }
    }
  });

  it('carries the occurrence count each raw value actually has', () => {
    for (const entry of CONTROL_HEIGHT_MERGE) {
      expect(entry.count, `控件 height:${entry.raw}px 的出现次数与抽取结果不符`).toBe(
        OBSERVED_CONTROL_HEIGHTS[entry.raw],
      );
    }
    // Field / select lookalikes are counted with the bars, because that is the
    // rule that catches them; their counts must agree with that inventory.
    for (const entry of CONTROL_LOOKALIKE_HEIGHTS) {
      expect(entry.count, `控件外观的 ${entry.raw}px 与栏高抽取结果不符`).toBe(OBSERVED_BAR_HEIGHTS[entry.raw]);
    }
  });
});

describe('§3.4 bar and row heights', () => {
  it('holds the eleven role-named tokens the spec fixes', () => {
    expect(BAR_HEIGHT_PX).toEqual({
      '--h-titlebar': 48,
      '--h-topbar': 56,
      '--h-bar': 46,
      '--h-panel-head': 40,
      '--h-thead': 34,
      '--h-row': 42,
      '--h-row-compact': 38,
      '--h-row-evidence': 52,
      // The three §3.4 rows added after the first pass left them on the unmapped
      // allowlist; see the comment where they used to sit in UNMAPPED_VALUES.
      '--h-row-task': 64,
      '--h-composer': 80,
      '--h-actionbar': 92,
    });
    expect(DESIGN_DISTINCT_VALUE_COUNTS.barOrRowHeight).toBe(numericKeys(OBSERVED_BAR_HEIGHTS).length);
  });

  it('maps every bar or row height to a token, a control, or the allowlist', () => {
    for (const raw of numericKeys(OBSERVED_BAR_HEIGHTS)) {
      if (lookupBarHeightTokens(raw).length > 0) {
        continue;
      }
      // Fields and selects drawn as divs match the bar rule but are controls.
      if (lookupControlHeightToken(raw) !== undefined) {
        continue;
      }
      expect(isAllowlistedUnmapped('height', `${raw}px`), `height:${raw}px 既没有 token 也不在 allowlist 里`).toBe(
        true,
      );
    }
  });

  it('leaves nothing in the inventory unaccounted for', () => {
    const accounted = numericKeys(OBSERVED_BAR_HEIGHTS).filter(
      (raw) =>
        lookupBarHeightTokens(raw).length > 0 ||
        lookupControlHeightToken(raw) !== undefined ||
        isAllowlistedUnmapped('height', `${raw}px`),
    );
    expect(accounted).toHaveLength(numericKeys(OBSERVED_BAR_HEIGHTS).length);
  });

  it('keeps the inverse merge table consistent with the spec forward claims', () => {
    for (const [token, claims] of Object.entries(BAR_HEIGHT_CLAIMS)) {
      for (const raw of claims) {
        const tokens = lookupBarHeightTokens(raw);
        // 32 is claimed by --h-thead but the design only ever draws it as a control.
        if (tokens.length === 0) {
          expect(lookupControlHeightToken(raw), `§3.4 说 ${token} 吸收 ${raw}px，但设计稿里它是控件`).toBeDefined();
          continue;
        }
        expect(tokens, `§3.4 说 ${token} 吸收 ${raw}px，但归并表里没有`).toContain(token);
      }
    }
  });

  it('records both candidates wherever two role tokens claim the same pixel value', () => {
    const ambiguous = BAR_HEIGHT_MERGE.filter((entry) => 'tokens' in entry);
    expect(ambiguous.map((entry) => entry.raw).sort((a, b) => a - b)).toEqual([34, 38, 40, 48]);
    for (const entry of ambiguous) {
      expect(entry.note.length).toBeGreaterThan(0);
    }
  });

  it('carries the occurrence count each raw value actually has', () => {
    for (const entry of BAR_HEIGHT_MERGE) {
      expect(entry.count, `栏高 ${entry.raw}px 的出现次数与抽取结果不符`).toBe(OBSERVED_BAR_HEIGHTS[entry.raw]);
    }
  });
});

describe('§3.5 panel widths', () => {
  it('holds the width tokens the spec fixes', () => {
    expect(PANEL_WIDTH_PX).toEqual({
      '--w-nav': 216,
      '--w-nav-collapsed': 56,
      '--w-agent-rail': 46,
      '--w-subnav': 190,
      '--w-panel': 340,
      '--w-inspector': 380,
      '--w-inspector-wide': 440,
      '--w-split': 520,
      '--w-track-head': 190,
      '--w-overlay': 600,
    });
    expect(DESIGN_DISTINCT_VALUE_COUNTS.panelWidth).toBe(numericKeys(OBSERVED_PANEL_WIDTHS).length);
  });

  it('maps every panel width in the design reference to a token or the allowlist', () => {
    for (const raw of numericKeys(OBSERVED_PANEL_WIDTHS)) {
      const token = lookupPanelWidthToken(raw);
      if (token === undefined) {
        expect(isAllowlistedUnmapped('width', `${raw}px`), `width:${raw}px 既没有 token 也不在 allowlist 里`).toBe(
          true,
        );
        continue;
      }
      expect(PANEL_WIDTH_PX[token]).toBeGreaterThan(0);
    }
  });

  it('never folds a width further than the widest fold the spec itself asks for', () => {
    for (const entry of PANEL_WIDTH_MERGE) {
      const target = PANEL_WIDTH_PX[entry.token];
      expect(
        Math.abs(target - entry.raw),
        `width:${entry.raw}px → ${entry.token}(${target}) 跨得比 §3.5 自己最宽的一次归并还远`,
      ).toBeLessThanOrEqual(PANEL_WIDTH_MAX_FOLD_PX);
    }
    // The bound must be tight: some entry has to actually reach it, otherwise
    // it is a rubber stamp rather than a constraint.
    const widest = Math.max(
      ...PANEL_WIDTH_MERGE.map((entry) => Math.abs(PANEL_WIDTH_PX[entry.token] - entry.raw)),
    );
    expect(widest).toBe(PANEL_WIDTH_MAX_FOLD_PX);
  });

  it('documents the two tokens that only exist in the design reference prose', () => {
    expect(PANEL_WIDTH_FROM_PROSE).toHaveLength(2);
    for (const prose of PANEL_WIDTH_FROM_PROSE) {
      expect(PANEL_WIDTH_PX[prose.token]).toBe(prose.px);
      expect(
        numericKeys(OBSERVED_PANEL_WIDTHS),
        `${prose.px}px 其实画出来了，不该记成「只在说明文字里」`,
      ).not.toContain(prose.px);
      expect(prose.quote.length).toBeGreaterThan(0);
    }
  });

  it('carries the occurrence count each raw value actually has', () => {
    for (const entry of PANEL_WIDTH_MERGE) {
      expect(entry.count, `面板宽 ${entry.raw}px 的出现次数与抽取结果不符`).toBe(OBSERVED_PANEL_WIDTHS[entry.raw]);
    }
  });
});

describe('§3.1 colour', () => {
  it('holds the nine status tokens the spec fixes, with the design’s dark values', () => {
    expect(Object.keys(STATUS_COLORS)).toHaveLength(9);
    expect(STATUS_COLORS['--color-ok']).toEqual({ light: '#4d7a5a', dark: '#6ea87f' });
    expect(STATUS_COLORS['--color-warn']).toEqual({ light: '#a8792f', dark: '#d3a85f' });
    expect(STATUS_COLORS['--color-fail']).toEqual({ light: '#a3453c', dark: '#cf7a72' });
    for (const [token, pair] of Object.entries(STATUS_COLORS)) {
      expect(pair.light, `${token} 的浅色必须是具体值`).toMatch(/^#[0-9a-f]{6}$/);
      expect(OBSERVED_HEX_COLORS[pair.light], `${token} 的浅色不在设计稿里`).toBeDefined();
    }
  });

  it('maps every bare hex to a token, to a dark derivation, or to the allowlist', () => {
    const derived = new Set(DARK_DERIVATION_EVIDENCE.map((entry) => entry.hex));
    for (const hex of Object.keys(OBSERVED_HEX_COLORS)) {
      if (lookupColorToken(hex) !== undefined || derived.has(hex)) {
        continue;
      }
      expect(isAllowlistedUnmapped('color', hex), `${hex} 既没有 token 也不在 allowlist 里`).toBe(true);
    }
  });

  it('never invents a colour the design reference does not contain', () => {
    for (const entry of COLOR_MERGE) {
      expect(OBSERVED_HEX_COLORS[entry.hex], `${entry.hex} 不在抽取结果里`).toBeDefined();
      expect(entry.count, `${entry.hex} 的出现次数与抽取结果不符`).toBe(OBSERVED_HEX_COLORS[entry.hex]);
    }
    for (const entry of DARK_DERIVATION_EVIDENCE) {
      expect(entry.count, `${entry.hex} 的出现次数与抽取结果不符`).toBe(OBSERVED_HEX_COLORS[entry.hex]);
    }
  });

  it('keeps Industry hexes intact wherever the design writes one out by hand', () => {
    const byToken = new Map<string, string>(Object.entries(INDUSTRY_COLORS));
    for (const entry of COLOR_MERGE) {
      if (entry.mode !== 'light') {
        continue;
      }
      const industry = byToken.get(entry.token);
      if (industry === undefined || industry.startsWith('color-mix')) {
        continue;
      }
      expect(entry.hex, `${entry.token} 的裸值与 Industry 不一致`).toBe(industry);
    }
  });

  it('covers every distinct hex exactly once across the three buckets', () => {
    expect(Object.keys(OBSERVED_HEX_COLORS)).toHaveLength(DESIGN_DISTINCT_VALUE_COUNTS.hexColor);
    const merged = COLOR_MERGE.map((entry) => entry.hex);
    const derived = DARK_DERIVATION_EVIDENCE.map((entry) => entry.hex);
    const allowlisted = UNMAPPED_VALUES.filter((entry) => entry.property === 'color').flatMap((entry) =>
      entry.raw.split(' / '),
    );
    const all = [...merged, ...derived, ...allowlisted];
    expect(new Set(all).size, '同一个 hex 被归到了两个桶里').toBe(all.length);
    expect(new Set(all)).toEqual(new Set(Object.keys(OBSERVED_HEX_COLORS)));
  });
});

describe('§3.6 spacing and radius', () => {
  it('snaps every spacing value onto the 3.4px base within the stated tolerance', () => {
    for (const entry of SPACING_MERGE) {
      const exact = entry.step * SPACING_BASE_PX;
      expect(entry.px, `${entry.raw}px 的 step 与 px 不自洽`).toBeCloseTo(exact, 5);
      expect(Math.abs(entry.raw - exact), `${entry.raw}px 的取整误差记错了`).toBeCloseTo(entry.deltaPx, 5);
      expect(entry.deltaPx, `${entry.raw}px 的取整误差超过 ${SPACING_MAX_DELTA_PX}px`).toBeLessThanOrEqual(
        SPACING_MAX_DELTA_PX,
      );
    }
  });

  it('picks the closest half step of the base for every spacing value', () => {
    for (const entry of SPACING_MERGE) {
      const nearest = Math.round((entry.raw / SPACING_BASE_PX) * 2) / 2;
      expect(entry.step, `${entry.raw}px 不是最近的半步`).toBeCloseTo(nearest, 5);
    }
  });

  it('covers every spacing value the design reference uses', () => {
    const mapped = new Set(SPACING_MERGE.map((entry) => entry.raw));
    for (const raw of OBSERVED_SPACING) {
      expect(mapped.has(raw), `padding / gap 的 ${raw}px 没有对应的 step`).toBe(true);
    }
    expect(SPACING_MERGE).toHaveLength(DESIGN_DISTINCT_VALUE_COUNTS.spacing);
    expect(OBSERVED_SPACING).toHaveLength(DESIGN_DISTINCT_VALUE_COUNTS.spacing);
  });

  it('lands the whole-numbered Industry steps exactly', () => {
    // --space-1..8 must survive the snapping, or Tailwind's p-1/p-2/p-4 stop
    // meaning what Industry means by them (spec §3.6).
    for (const [raw, step] of [
      [3, 1],
      [7, 2],
      [10, 3],
      [14, 4],
      [20, 6],
    ] as const) {
      const entry = SPACING_MERGE.find((item) => item.raw === raw);
      expect(entry?.step, `${raw}px 应落在 --space-${step}`).toBe(step);
    }
  });

  it('keeps the radius scale closed to the selected review values', () => {
    expect(Object.values(RADIUS_PX)).toEqual([3, 4, 6, 999]);
    expect(DESIGN_BORDER_RADIUS_DECLARATIONS).toBe(4);
    expect(DESIGN_DISTINCT_VALUE_COUNTS.borderRadius).toBe(4);
  });
});

describe('unmapped allowlist', () => {
  it('gives every entry a reason and a provenance', () => {
    expect(UNMAPPED_VALUES.length).toBeGreaterThan(0);
    for (const entry of UNMAPPED_VALUES) {
      expect(entry.reason.length, `${entry.property}:${entry.raw} 没有写明为什么是例外`).toBeGreaterThan(40);
      if (entry.count > 0) {
        expect(entry.from.length, `${entry.property}:${entry.raw} 没有出处`).toBeGreaterThan(0);
      }
    }
  });

  it('holds nothing that a token would already cover', () => {
    for (const entry of UNMAPPED_VALUES) {
      for (const raw of entry.raw.split(' / ')) {
        const px = Number.parseInt(raw, 10);
        if (entry.property === 'font-size') {
          expect(lookupFontSizeToken(px), `${raw} 其实已经有 token 了`).toBeUndefined();
        }
        if (entry.property === 'height') {
          expect(lookupBarHeightTokens(px), `${raw} 其实已经有栏高 token 了`).toHaveLength(0);
          expect(lookupControlHeightToken(px), `${raw} 其实已经有控件 token 了`).toBeUndefined();
        }
        if (entry.property === 'width') {
          expect(lookupPanelWidthToken(px), `${raw} 其实已经有宽度 token 了`).toBeUndefined();
        }
        if (entry.property === 'color') {
          expect(lookupColorToken(raw), `${raw} 其实已经有颜色 token 了`).toBeUndefined();
        }
      }
    }
  });

  it('keeps the two families §3 defines no token for on the list', () => {
    const properties = UNMAPPED_VALUES.map((entry) => entry.property);
    expect(properties).toContain('letter-spacing');
    expect(properties).toContain('line-height');
  });

  it('accounts for every allowlisted size that the observed inventories contain', () => {
    const heights = UNMAPPED_VALUES.filter((entry) => entry.property === 'height').flatMap((entry) =>
      entry.raw.split(' / ').map((raw) => Number.parseInt(raw, 10)),
    );
    // Only 172px is left on the height allowlist, and it is a content box rather
    // than a bar, so it is deliberately absent from the bar inventory. The five
    // sizes that used to be here now have tokens.
    const inInventory = heights.filter((px) => px in OBSERVED_BAR_HEIGHTS);
    expect(inInventory).toEqual([]);

    const widths = UNMAPPED_VALUES.filter((entry) => entry.property === 'width').flatMap((entry) =>
      entry.raw.split(' / ').map((raw) => Number.parseInt(raw, 10)),
    );
    for (const px of widths) {
      expect(OBSERVED_PANEL_WIDTHS[px], `width:${px}px 被列为例外，但抽取结果里没有它`).toBeDefined();
    }
  });
});

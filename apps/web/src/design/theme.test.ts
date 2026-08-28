import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  BAR_HEIGHT_PX,
  CONTROL_HEIGHT_PX,
  DARK_REVERSAL_TABLE,
  DESIGN_ARTBOARDS,
  FONT_SIZE_PX,
  INDUSTRY_COLORS,
  PANEL_WIDTH_PX,
  RADIUS_PX,
  SPACING_BASE_PX,
  STATUS_COLORS,
  UNMAPPED_VALUES,
  type DesignArtboard,
} from './tokens.data';

/**
 * `theme.css` is hand written but it is not free: it must be exactly the CSS
 * projection of `tokens.data.ts`. This test is the join between the two.
 *
 * Three things are checked, in the order they can go wrong:
 *
 *   1. Coverage — every token `tokens.data.ts` declares exists in `@theme`
 *      with the value the data gives it. A merge table edited without touching
 *      the stylesheet fails here rather than shipping a stale token.
 *   2. Closure — `@theme` holds nothing else, unless it is on the extension
 *      list below, and every extension names the `UNMAPPED_VALUES` entry or
 *      the artboard that motivated it. This is the half that stops the
 *      stylesheet from quietly re-growing the bare values §3 spent its time
 *      merging away.
 *   3. Dark parity — the two dark guards redefine the same token set, with
 *      the same values, and that set is exactly the theme's colours and
 *      shadows. Nothing structural, and no size.
 *
 * Parsing is deliberately dumb (strip comments, match `--name: value;`)
 * because a real CSS parser would accept things this file must not contain.
 */

const THEME_PATH = fileURLToPath(new URL('./theme.css', import.meta.url));
const BASE_PATH = fileURLToPath(new URL('./base.css', import.meta.url));

const themeSource = readFileSync(THEME_PATH, 'utf8');
const baseSource = readFileSync(BASE_PATH, 'utf8');

/* ── parsing ─────────────────────────────────────────────────────────── */

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Body of the block whose header ends at `headerEnd`, brace-matched. */
const blockBodyAt = (css: string, headerEnd: number): string => {
  let depth = 0;
  for (let i = headerEnd; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(headerEnd + 1, i);
    }
  }
  throw new Error(`unbalanced braces after offset ${headerEnd}`);
};

/** Body of the first block whose header matches `header`. */
const blockBody = (css: string, header: RegExp): string => {
  const match = header.exec(css);
  if (!match) throw new Error(`no block matching ${header}`);
  const brace = css.indexOf('{', match.index + match[0].length - 1);
  return blockBodyAt(css, brace);
};

const normalise = (value: string): string => value.replace(/\s+/g, ' ').trim();

const declarations = (body: string): Map<string, string> => {
  const out = new Map<string, string>();
  const re = /(--[a-z0-9-]+)\s*:\s*([^;{}]+);/g;
  let match = re.exec(body);
  while (match !== null) {
    const [, token, value] = match;
    if (token !== undefined && value !== undefined) out.set(token, normalise(value));
    match = re.exec(body);
  }
  return out;
};

/**
 * Everything in a block that is not a custom-property declaration and not a
 * namespace reset. A dark guard with any of this in it is redefining
 * structure, which the spec forbids: a page must differ between themes only
 * in its colours.
 */
const residue = (body: string): string[] =>
  stripComments(body)
    .split(/;|(?=\{)/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .filter((chunk) => !/^--[a-z0-9-]+\s*:/.test(chunk))
    .filter((chunk) => !/^--[a-z0-9-]+-\*\s*:\s*initial$/.test(chunk));

const theme = stripComments(themeSource);

const themeBlock = blockBody(theme, /@theme\s+static\s*\{/);
const themeTokens = declarations(themeBlock);

const darkMediaGuard = blockBody(
  blockBody(theme, /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{/),
  /:root:not\(\[data-theme='light'\]\)\s*\{/,
);
const darkAttrGuard = blockBody(theme, /(?<!@media[\s\S]{0,400}?):root\[data-theme='dark'\]\s*\{/);

const darkMediaTokens = declarations(darkMediaGuard);
const darkAttrTokens = declarations(darkAttrGuard);

/* ── 1. coverage: what tokens.data.ts declares ───────────────────────── */

const px = (n: number): string => `${n}px`;

const DECLARED: ReadonlyMap<string, string> = new Map<string, string>([
  ...Object.entries(INDUSTRY_COLORS).map(([token, value]) => [token, normalise(value)] as const),
  ...Object.entries(STATUS_COLORS).map(([token, value]) => [token, value.light] as const),
  ...Object.entries(FONT_SIZE_PX).map(([token, value]) => [token, px(value)] as const),
  ...Object.entries(CONTROL_HEIGHT_PX).map(([token, value]) => [token, px(value)] as const),
  ...Object.entries(BAR_HEIGHT_PX).map(([token, value]) => [token, px(value)] as const),
  ...Object.entries(PANEL_WIDTH_PX).map(([token, value]) => [token, px(value)] as const),
  ...Object.entries(RADIUS_PX).map(([token, value]) => [token, px(value)] as const),
  ['--spacing', px(SPACING_BASE_PX)],
]);

/* ── 2. closure: what theme.css is additionally allowed to define ────── */

/**
 * Why a token exists that `tokens.data.ts` does not declare. `unmapped` points
 * at the `UNMAPPED_VALUES` entry that asked for it — those entries are the
 * spec's own decision queue, so an extension is only legitimate if one of them
 * names it. `artboard` points at a rule the design reference states in prose.
 * `industry` is a non-colour token carried over verbatim from the kit's
 * styles.css, which `tokens.data.ts` only transcribes the colours of.
 */
type Provenance =
  | { readonly kind: 'unmapped'; readonly property: string; readonly raw: string }
  | { readonly kind: 'artboard'; readonly artboard: DesignArtboard }
  | { readonly kind: 'industry' }
  | { readonly kind: 'keyword' };

const EXTENSIONS: Readonly<Record<string, Provenance>> = {
  '--color-transparent': { kind: 'keyword' },
  '--color-current': { kind: 'keyword' },

  '--color-surface-chrome': { kind: 'unmapped', property: 'color', raw: '#ededee / #1d1f21' },
  '--color-ok-border': { kind: 'unmapped', property: 'color', raw: '#a8c3a9' },
  '--color-ok-text': { kind: 'unmapped', property: 'color', raw: '#7d332c / #7a5a16 / #8a6f2c' },
  '--color-warn-text': { kind: 'unmapped', property: 'color', raw: '#7d332c / #7a5a16 / #8a6f2c' },
  '--color-fail-text': { kind: 'unmapped', property: 'color', raw: '#7d332c / #7a5a16 / #8a6f2c' },

  '--color-grid': { kind: 'artboard', artboard: '补齐 · 暗色与其余页面' },

  '--leading-tight': { kind: 'unmapped', property: 'line-height', raw: '1.5 / 1.6 / 1.65 / 1.7 / 1.75 / 1.8 / 1.9' },
  '--leading-normal': { kind: 'unmapped', property: 'line-height', raw: '1.5 / 1.6 / 1.65 / 1.7 / 1.75 / 1.8 / 1.9' },
  '--leading-relaxed': { kind: 'unmapped', property: 'line-height', raw: '1.5 / 1.6 / 1.65 / 1.7 / 1.75 / 1.8 / 1.9' },

  '--tracking-caps': {
    kind: 'unmapped',
    property: 'letter-spacing',
    raw: '.02em / .04em / .06em / .08em / .1em / .12em / .14em / .16em / .24em',
  },
  '--tracking-wide': {
    kind: 'unmapped',
    property: 'letter-spacing',
    raw: '.02em / .04em / .06em / .08em / .1em / .12em / .14em / .16em / .24em',
  },

  '--font-body': { kind: 'industry' },
  '--font-heading': { kind: 'industry' },
  '--font-heading-weight': { kind: 'industry' },
  '--font-mono': { kind: 'artboard', artboard: '10 多轨编辑器' },

  '--shadow-sm': { kind: 'industry' },
  '--shadow-md': { kind: 'industry' },
  '--shadow-lg': { kind: 'industry' },
};

/* ── tests ──────────────────────────────────────────────────────────── */

describe('theme.css against tokens.data.ts', () => {
  it('defines every token the merge tables declare, with the declared value', () => {
    const mismatched: string[] = [];
    for (const [token, expected] of DECLARED) {
      const actual = themeTokens.get(token);
      if (actual !== expected) mismatched.push(`${token}: expected ${expected}, got ${actual ?? '(missing)'}`);
    }
    expect(mismatched).toEqual([]);
  });

  it('defines nothing beyond the declared tokens and the listed extensions', () => {
    const unexplained = [...themeTokens.keys()].filter(
      (token) => !DECLARED.has(token) && !(token in EXTENSIONS),
    );
    expect(unexplained).toEqual([]);
  });

  it('lists no extension the stylesheet does not actually define', () => {
    const stale = Object.keys(EXTENSIONS).filter((token) => !themeTokens.has(token));
    expect(stale).toEqual([]);
  });

  it('traces every extension back to a decision recorded in tokens.data.ts', () => {
    const untraceable: string[] = [];
    for (const [token, provenance] of Object.entries(EXTENSIONS)) {
      if (provenance.kind === 'unmapped') {
        const found = UNMAPPED_VALUES.some(
          (entry) => entry.property === provenance.property && entry.raw === provenance.raw,
        );
        if (!found) untraceable.push(`${token}: no UNMAPPED_VALUES entry ${provenance.property} ${provenance.raw}`);
      } else if (provenance.kind === 'artboard') {
        if (!DESIGN_ARTBOARDS.includes(provenance.artboard)) {
          untraceable.push(`${token}: unknown artboard ${provenance.artboard}`);
        }
      }
    }
    expect(untraceable).toEqual([]);
  });

  it('keeps the type scale, control heights, bar heights and panel widths in px', () => {
    const sized = [
      ...Object.keys(FONT_SIZE_PX),
      ...Object.keys(CONTROL_HEIGHT_PX),
      ...Object.keys(BAR_HEIGHT_PX),
      ...Object.keys(PANEL_WIDTH_PX),
    ];
    const notPx = sized.filter((token) => !/^\d+px$/.test(themeTokens.get(token) ?? ''));
    expect(notPx).toEqual([]);
  });

  it('projects the closed review radius scale', () => {
    expect(Object.keys(RADIUS_PX).map((token) => themeTokens.get(token))).toEqual(['3px', '4px', '6px', '999px']);
  });

  it('sets the Tailwind spacing base to Industry 0.85 density, so p-2 is --space-2', () => {
    expect(themeTokens.get('--spacing')).toBe('3.4px');
    expect(SPACING_BASE_PX * 2).toBeCloseTo(6.8, 6);
  });

  it('resets the Tailwind scales it replaces, so no stock palette or step survives', () => {
    for (const namespace of ['color', 'font', 'text', 'leading', 'tracking', 'radius', 'shadow']) {
      expect(themeBlock).toContain(`--${namespace}-*: initial;`);
    }
  });
});

describe('dark theme guards', () => {
  /** The tokens that a theme flip is allowed to touch. */
  const themeDependent = [...themeTokens.keys()].filter(
    (token) => token.startsWith('--color-') || token.startsWith('--shadow-'),
  );

  it('redefines every colour and shadow token under prefers-color-scheme', () => {
    expect([...darkMediaTokens.keys()].sort()).toEqual([...themeDependent].sort());
  });

  it('redefines the same set under the explicit data-theme override', () => {
    expect([...darkAttrTokens.keys()].sort()).toEqual([...themeDependent].sort());
  });

  it('gives both guards identical values, so the OS and the toggle agree', () => {
    expect(Object.fromEntries(darkAttrTokens)).toEqual(Object.fromEntries(darkMediaTokens));
  });

  it('redefines tokens only — no selectors, no properties, no structure', () => {
    expect(residue(darkMediaGuard)).toEqual([]);
    expect(residue(darkAttrGuard)).toEqual([]);
  });

  it('leaves every size token alone: a 42px row is 42px in the dark', () => {
    const sizes = [
      ...Object.keys(FONT_SIZE_PX),
      ...Object.keys(CONTROL_HEIGHT_PX),
      ...Object.keys(BAR_HEIGHT_PX),
      ...Object.keys(PANEL_WIDTH_PX),
      ...Object.keys(RADIUS_PX),
      '--spacing',
    ];
    expect(sizes.filter((token) => darkMediaTokens.has(token) || darkAttrTokens.has(token))).toEqual([]);
  });

  it('applies the artboard reversal table verbatim where it names a value', () => {
    const row = (role: string): string => {
      const found = DARK_REVERSAL_TABLE.find((entry) => entry.role === role);
      if (!found) throw new Error(`DARK_REVERSAL_TABLE has no row ${role}`);
      return found.dark;
    };

    expect(row('画布')).toBe('#16181a');
    expect(darkMediaTokens.get('--color-bg')).toBe('#16181a');

    // "侧栏 / 次级面" — the light theme keeps two near-identical planes,
    // the artboard draws one, so both map onto it.
    expect(row('侧栏 / 次级面')).toBe('#1d1f21');
    expect(darkMediaTokens.get('--color-surface')).toBe('#1d1f21');
    expect(darkMediaTokens.get('--color-surface-chrome')).toBe('#1d1f21');

    expect(row('主文字 / 次文字')).toContain('#eceded');
    expect(darkMediaTokens.get('--color-text')).toBe('#eceded');

    expect(row('分隔线')).toContain('#33363a');
    expect(darkMediaTokens.get('--color-divider')).toBe('#33363a');

    // The accent ramp inverts, and the two steps the table pins are its ends:
    // the selected background and the clickable steel blue.
    expect(row('选中底')).toContain('#1d2d3d');
    expect(darkMediaTokens.get('--color-accent-100')).toBe('#1d2d3d');
    expect(row('可点击的钢蓝')).toContain('#94bce3');
    expect(darkMediaTokens.get('--color-accent-700')).toBe('#94bce3');

    // The primary button keeps its light fill; only the label goes dark.
    expect(row('主按钮')).toContain('#5980a6');
    expect(darkMediaTokens.get('--color-accent')).toBe('#5980a6');
  });

  it('takes the three semantic colours from the reversal table', () => {
    for (const token of ['--color-ok', '--color-warn', '--color-fail'] as const) {
      expect(darkMediaTokens.get(token)).toBe(STATUS_COLORS[token].dark);
    }
    expect(DARK_REVERSAL_TABLE.find((entry) => entry.role === '成功 / 警告 / 失败')?.dark).toBe(
      '#6ea87f #d3a85f #cf7a72',
    );
  });

  it('derives every "derive" status token by formula rather than by hand', () => {
    const derived = Object.entries(STATUS_COLORS)
      .filter(([, value]) => value.dark === 'derive')
      .map(([token]) => token)
      // --color-team-b has no semantic parent to mix from; it takes the
      // lightness shift the three semantics share and is a literal.
      .filter((token) => token !== '--color-team-b');

    for (const token of derived) {
      expect(darkMediaTokens.get(token)).toMatch(/^color-mix\(in oklab, var\(--color-(ok|warn|fail)\) \d+%, var\(--color-bg\)\)$/);
    }

    // One percentage per role, applied to all three semantics — §3.1 asks for
    // an algorithm, not three hand-picked triples.
    const percentages = (suffix: string): Set<string> =>
      new Set(
        ['ok', 'warn', 'fail'].map((role) => {
          const value = darkMediaTokens.get(`--color-${role}-${suffix}`) ?? '';
          return /(\d+)%/.exec(value)?.[1] ?? 'none';
        }),
      );
    expect(percentages('surface').size).toBe(1);
    expect(percentages('border').size).toBe(1);
  });

  it('grids the dark canvas at 6% over the background, per the artboard note', () => {
    expect(themeTokens.get('--color-grid')).toBe('color-mix(in oklab, var(--color-text) 4%, var(--color-bg))');
    expect(darkMediaTokens.get('--color-grid')).toBe('color-mix(in oklab, var(--color-text) 6%, var(--color-bg))');
  });
});

describe('design stylesheet ownership', () => {
  /**
   * The Tauri CSP is `default-src 'self' …; font-src 'self' vibe-cs-media: …
   * data:`. Anything off-origin is not a slow font, it is a blocked request
   * and a silent fallback to the system stack.
   */
  it('references no external origin from any design-layer stylesheet', () => {
    for (const source of [themeSource, baseSource]) {
      expect(stripComments(source)).not.toMatch(/https?:\/\//);
      expect(stripComments(source)).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    }
  });

  it('imports the whole design layer from theme.css, so one import is enough', () => {
    expect(stripComments(themeSource)).toMatch(/@import 'tailwindcss';/);
    expect(stripComments(themeSource)).toMatch(/@import '\.\/base\.css';/);
  });
});

describe('base.css', () => {
  it('paints the body explicitly — a transparent body shows the webview ground', () => {
    expect(baseSource).toMatch(/body\s*\{[^}]*background:\s*var\(--color-bg\)/);
  });

  it('keeps the keyboard focus ring and drops the mouse one', () => {
    expect(baseSource).toMatch(/:focus\s*\{\s*outline:\s*none;\s*\}/);
    expect(baseSource).toMatch(
      /:focus-visible\s*\{\s*outline:\s*2px solid var\(--color-accent\);\s*outline-offset:\s*2px;\s*\}/,
    );
  });

  it('styles the selection and honours both reduced-motion triggers', () => {
    expect(baseSource).toContain('::selection');
    expect(baseSource).toContain('@media (prefers-reduced-motion: reduce)');
    expect(baseSource).toContain("[data-reduce-motion='true']");
  });

  it('writes no literal colour — every value comes from a token', () => {
    expect(stripComments(baseSource)).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COLOR_TOKENS, FIGMA_BINDINGS, LIGHT_TOKENS, PANEL_WIDTH_PX, TYPE_ROLES } from './tokens.data';

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


describe('approved Figma theme contract', () => {
  it('projects the complete closed light token set', () => {
    expect(Object.fromEntries(themeTokens)).toEqual(LIGHT_TOKENS);
  });

  it('matches every direct Figma semantic binding in both themes', () => {
    for (const binding of FIGMA_BINDINGS) {
      const token = /^var\((--[^)]+)\)$/.exec(binding.css)?.[1];
      if (token === undefined || token === '--color-transparent') continue;
      const light = typeof binding.light === 'number' ? `${binding.light}px` : binding.light;
      expect(themeTokens.get(token), binding.name).toBe(light);
      if (binding.name.startsWith('color/')) {
        expect(darkAttrTokens.get(token), binding.name).toBe(binding.dark);
      }
    }
  });

  it('uses explicit, readable type roles with their Figma line heights', () => {
    for (const [role, [size, line]] of Object.entries(TYPE_ROLES)) {
      expect(themeTokens.get(`--text-${role}`)).toBe(`${size}px`);
      expect(themeTokens.get(`--text-${role}--line-height`)).toBe(`${line}px`);
      expect(size).toBeGreaterThanOrEqual(12);
      expect(line).toBeGreaterThan(size);
    }
    expect(themeTokens.has('--text-2xs')).toBe(false);
  });

  it('keeps control, panel and content axes on the approved grid', () => {
    for (const [token, value] of Object.entries(PANEL_WIDTH_PX)) {
      expect(themeTokens.get(token)).toBe(`${value}px`);
    }
    expect(themeTokens.get('--spacing')).toBe('4px');
    expect(['sm', 'md', 'lg', 'hero'].map(s => themeTokens.get(`--h-ctl-${s}`))).toEqual(['32px', '36px', '40px', '44px']);
    expect(themeTokens.get('--h-panel-head')).toBe('36px');
    expect(themeTokens.get('--panel-inset')).toBe('12px');
    expect(themeTokens.get('--scrollbar-size')).toBe('10px');
    expect(themeTokens.get('--w-track-head')).toBe('190px');
  });

  it('resets every stock visual scale it replaces', () => {
    for (const namespace of ['color', 'font', 'text', 'leading', 'tracking', 'radius', 'shadow']) {
      expect(themeBlock).toContain(`--${namespace}-*: initial;`);
    }
  });

  it('has no workbench-specific palette or external font dependency', () => {
    expect(theme).not.toMatch(/\.review-workbench\s*\{/);
    expect(theme).toContain("@import '@fontsource-variable/noto-sans-sc';");
    expect(theme).toContain("@import '@fontsource-variable/roboto-mono';");
  });
});

describe('dark theme guards', () => {
  const themed = [...themeTokens.keys()].filter(token =>
    (token.startsWith('--color-') && !['--color-current', '--color-transparent'].includes(token))
    || token.startsWith('--shadow-'));

  it('overrides the complete visual set, identically for OS and explicit theme selection', () => {
    expect([...darkAttrTokens.keys()].sort()).toEqual(themed.sort());
    expect(Object.fromEntries(darkAttrTokens)).toEqual(Object.fromEntries(darkMediaTokens));
    for (const [token, values] of Object.entries(COLOR_TOKENS)) {
      expect(darkAttrTokens.get(token), token).toBe(values.dark);
    }
  });

  it('changes no structure, geometry, or text metrics', () => {
    expect(residue(darkMediaGuard)).toEqual([]);
    expect(residue(darkAttrGuard)).toEqual([]);
    expect([...darkAttrTokens.keys()].filter(token => !themed.includes(token))).toEqual([]);
  });

  it('keeps media dark and its text readable when the UI theme changes', () => {
    for (const token of ['--color-media', '--color-on-media', '--color-on-media-muted', '--color-media-divider']) {
      expect(darkAttrTokens.get(token)).toBe(themeTokens.get(token));
    }
    expect(darkAttrTokens.get('--color-bg')).not.toBe(themeTokens.get('--color-bg'));
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

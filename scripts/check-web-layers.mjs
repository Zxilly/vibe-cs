/**
 * Layer and bare-value lint for `apps/web/src`.
 *
 * Enforces the six constraints of spec §2.1
 * (`docs/superpowers/specs/2026-08-15-frontend-redesign-design.md`):
 *
 *   1. design/**  must not import domain/** pages/** app/** data/** shared/desktop/**
 *   2. domain/**  must not import pages/** app/**
 *   3. pages/**   and app/** must not import each other
 *   4. pages/** app/** domain/** must contain no bare hex colour
 *   5. pages/** app/** must not carry a font size or a colour inside a Tailwind
 *      arbitrary value; a dimension arbitrary value (`w-[380px]`) is allowed only
 *      when the number is in the panel width table of `design/tokens.data.ts`
 *   6. pages/** domain/** must not import `shared/desktop/client` directly
 *
 * Follows the shape of `check-web-i18n.mjs`: walk, collect a `failures` array,
 * print every failure and exit non-zero. Directories that do not exist yet are
 * simply empty — the redesign builds the layers one at a time.
 *
 * The rule engine is exported so `check-web-layers.test.mjs` can run it against
 * a fixture tree; a lint nobody has seen fail is worse than no lint at all.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* ── what counts as a source file ────────────────────────────────────────── */

const SOURCE_EXTENSION = /\.(?:ts|tsx|css)$/u;
const TEST_FILE = /\.(?:test|spec)\.(?:ts|tsx)$/u;
const SKIPPED_DIRECTORY = new Set(['node_modules', 'dist', 'coverage', '.turbo']);

/* ── layers ──────────────────────────────────────────────────────────────── */

/** Layer id → the path prefix (posix, relative to `src`) that defines it. */
const LAYER_PREFIX = [
  ['shared/desktop', ['shared', 'desktop']],
  ['design', ['design']],
  ['domain', ['domain']],
  ['pages', ['pages']],
  ['app', ['app']],
  ['data', ['data']],
];

/** The desktop IPC client module, addressed without its extension. */
const DESKTOP_CLIENT = 'shared/desktop/client';

/**
 * Rules 1, 2, 3: which layers a given layer may not reach. Everything not
 * listed here (`shared/**` other than desktop, `features/**`, npm packages) is
 * outside the layering contract and is left alone.
 */
const FORBIDDEN_IMPORTS = {
  design: ['domain', 'pages', 'app', 'data', 'shared/desktop'],
  domain: ['pages', 'app'],
  pages: ['app'],
  app: ['pages'],
};

/** Rule 6: layers that must reach the desktop IPC client through `data/**`. */
const NO_DIRECT_DESKTOP_CLIENT = new Set(['pages', 'domain']);

/** Rule 4: layers whose source may not spell a colour out as a hex literal. */
const NO_BARE_HEX = new Set(['pages', 'app', 'domain']);

/** Rule 5: layers whose Tailwind arbitrary values are constrained. */
const ARBITRARY_VALUE_CHECKED = new Set(['pages', 'app']);

/* ── patterns ────────────────────────────────────────────────────────────── */

/**
 * Every module specifier form the codebase uses: `from '…'`, a side-effect
 * `import '…'`, a lazy `import('…')`, `require('…')` and the CSS `@import '…'`.
 * Matching on the whole file (rather than line by line) keeps multi-line import
 * statements working; the offset is turned back into a line number below.
 */
const SPECIFIER = /(?:\bfrom|\bimport|\brequire|@import)\s*\(?\s*(?:url\(\s*)?['"]([^'"\n]+)['"]/gu;

/** `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa`, not part of a longer word. */
const HEX_LITERAL = /(?<![\w#$])#([0-9a-fA-F]{3,8})(?![\w-])/gu;
const HEX_LENGTHS = new Set([3, 4, 6, 8]);

/**
 * A Tailwind arbitrary value: `text-[13px]`, `min-w-[190px]`, `bg-[#5980a6]`.
 * The utility prefix is captured without any variant (`md:`, `hover:`) because
 * `:` is excluded from the prefix character class.
 */
const ARBITRARY_VALUE = /(?<![\w#$.])(-?[a-z][a-z0-9]*(?:-[a-z0-9]+)*)-\[([^\]\s"'`]*)\]/gu;

/** Utilities whose arbitrary value paints something. */
const COLOR_UTILITY = new Set([
  'text',
  'bg',
  'border',
  'border-t',
  'border-r',
  'border-b',
  'border-l',
  'border-x',
  'border-y',
  'divide',
  'outline',
  'ring',
  'ring-offset',
  'fill',
  'stroke',
  'shadow',
  'accent',
  'caret',
  'decoration',
  'placeholder',
  'from',
  'via',
  'to',
]);

/** Utilities whose arbitrary value is a horizontal size (spec §3.5 territory). */
const WIDTH_UTILITY = new Set(['w', 'min-w', 'max-w', 'basis', 'size']);

const COLOR_VALUE = /^(?:#|(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color|color-mix)\()/iu;
const LENGTH_VALUE = /^-?\d*\.?\d+(?:px|rem|em|pt|ch|ex|vw|vh|vmin|vmax|%)$/u;
const PX_VALUE = /^(\d+(?:\.\d+)?)px$/u;
/** A value that only dereferences a token is not a bare value. */
const TOKEN_VALUE = /^var\(--[a-z0-9-]+\)$/u;

/* ── file collection ─────────────────────────────────────────────────────── */

/**
 * Every source file under `root`, as posix paths relative to it. A missing root
 * yields an empty list: during the redesign most layer directories do not exist
 * yet, and an absent layer breaks no constraint.
 */
export function collectSourceFiles(root) {
  const files = [];
  if (!fs.existsSync(root)) return files;

  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORY.has(entry.name)) walk(target);
        continue;
      }
      if (SOURCE_EXTENSION.test(entry.name)) files.push(toPosix(path.relative(root, target)));
    }
  };

  walk(root);
  files.sort();
  return files;
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

/** The layer a `src`-relative path belongs to, or null when it is outside them. */
function layerOf(relativePath) {
  const segments = relativePath.split('/');
  for (const [layer, prefix] of LAYER_PREFIX) {
    if (prefix.every((segment, index) => segments[index] === segment)) return layer;
  }
  return null;
}

function lineOf(source, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source[cursor] === '\n') line += 1;
  }
  return line;
}

/* ── the panel width table (rule 5) ──────────────────────────────────────── */

/**
 * The `PANEL_WIDTH_PX` record of `design/tokens.data.ts`, parsed with a regex
 * rather than imported so the lint stays a plain node script with no TypeScript
 * loader. Returns null when the table is not there yet, which turns rule 5's
 * dimension check into an explicit failure at the call site instead of silently
 * passing every width.
 */
export function readPanelWidths(root) {
  const tokensPath = path.join(root, 'design', 'tokens.data.ts');
  if (!fs.existsSync(tokensPath)) return null;

  const source = fs.readFileSync(tokensPath, 'utf8');
  const block = source.match(/export const PANEL_WIDTH_PX[^=]*=\s*\{([\s\S]*?)\n\};/u);
  if (!block) return null;

  const widths = new Map();
  for (const entry of block[1].matchAll(/'(--[a-z0-9-]+)'\s*:\s*(\d+(?:\.\d+)?)/gu)) {
    widths.set(Number(entry[2]), entry[1]);
  }
  return widths.size > 0 ? widths : null;
}

/* ── the rules ───────────────────────────────────────────────────────────── */

/**
 * Runs every §2.1 constraint over `root` (an `apps/web/src`-shaped tree).
 *
 * `panelWidths` overrides the table read from `design/tokens.data.ts`; the CLI
 * never passes it, the self-test does.
 *
 * Import rules apply to test files too — a test that reaches across layers is
 * still a layering breach. The bare-value rules skip test files, because a test
 * asserting on `#4d7a5a` has to be able to write it down.
 */
export function checkWebLayers({ root, panelWidths } = {}) {
  const files = collectSourceFiles(root);
  const widths = panelWidths === undefined ? readPanelWidths(root) : panelWidths;
  const failures = [];
  const checked = [];

  for (const file of files) {
    const layer = layerOf(file);
    if (!layer) continue;
    checked.push(file);

    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const isTest = TEST_FILE.test(path.basename(file));

    checkImports({ file, layer, source, failures });
    if (!isTest) {
      checkBareHex({ file, layer, source, failures });
      checkArbitraryValues({ file, layer, source, widths, failures });
    }
  }

  return { failures, files: checked, fileCount: checked.length, panelWidths: widths };
}

/** Rules 1, 2, 3 and 6. */
function checkImports({ file, layer, source, failures }) {
  const forbidden = FORBIDDEN_IMPORTS[layer] ?? [];
  const guardsDesktopClient = NO_DIRECT_DESKTOP_CLIENT.has(layer);
  if (forbidden.length === 0 && !guardsDesktopClient) return;

  for (const match of source.matchAll(SPECIFIER)) {
    const specifier = match[1];
    // Only relative specifiers can name another layer; the workspace defines no
    // path aliases, so anything else is an npm package.
    if (!specifier.startsWith('.')) continue;

    const resolved = toPosix(path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)));
    if (resolved.startsWith('..')) continue; // escapes `src`, outside the contract

    const target = layerOf(resolved);
    if (!target) continue;

    const at = `${file}:${lineOf(source, match.index)}`;
    if (forbidden.includes(target)) {
      failures.push(`${at}: ${layer}/** must not import ${target}/** (${specifier})`);
      continue;
    }
    if (guardsDesktopClient && isDesktopClient(resolved)) {
      failures.push(
        `${at}: ${layer}/** must not import ${DESKTOP_CLIENT} directly; go through data/** (${specifier})`,
      );
    }
  }
}

function isDesktopClient(resolved) {
  return resolved === DESKTOP_CLIENT || resolved.startsWith(`${DESKTOP_CLIENT}.`);
}

/** Rule 4. */
function checkBareHex({ file, layer, source, failures }) {
  if (!NO_BARE_HEX.has(layer)) return;

  for (const match of source.matchAll(HEX_LITERAL)) {
    if (!HEX_LENGTHS.has(match[1].length)) continue;
    failures.push(
      `${file}:${lineOf(source, match.index)}: bare hex colour #${match[1]} in ${layer}/**; use a design token`,
    );
  }
}

/** Rule 5. */
function checkArbitraryValues({ file, layer, source, widths, failures }) {
  if (!ARBITRARY_VALUE_CHECKED.has(layer)) return;

  for (const match of source.matchAll(ARBITRARY_VALUE)) {
    const [utility, rawValue] = [match[1], match[2]];
    const value = rawValue.replaceAll('_', ' ').trim();
    if (value === '' || TOKEN_VALUE.test(value)) continue;

    const at = `${file}:${lineOf(source, match.index)}`;
    const printed = `${utility}-[${rawValue}]`;

    if (COLOR_UTILITY.has(utility) && COLOR_VALUE.test(value)) {
      failures.push(`${at}: bare colour in arbitrary value ${printed} in ${layer}/**; use a design token`);
      continue;
    }
    if (utility === 'text' && LENGTH_VALUE.test(value)) {
      failures.push(`${at}: bare font size in arbitrary value ${printed} in ${layer}/**; use a --text-* token`);
      continue;
    }
    if (WIDTH_UTILITY.has(utility)) {
      const px = PX_VALUE.exec(value);
      if (!px) continue; // calc(), percentages and the like are not panel widths
      if (widths === null) {
        failures.push(
          `${at}: ${printed} cannot be checked — design/tokens.data.ts has no PANEL_WIDTH_PX table`,
        );
        continue;
      }
      if (!widths.has(Number(px[1]))) {
        failures.push(
          `${at}: ${printed} is not in the §3.5 panel width table (${[...widths.keys()].sort((a, b) => a - b).join(', ')})`,
        );
      }
    }
  }
}

/* ── CLI ─────────────────────────────────────────────────────────────────── */

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/web/src');
  const { failures, fileCount } = checkWebLayers({ root });

  if (failures.length > 0) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`layer check passed: ${fileCount} source files in design/ domain/ pages/ app/ data/ shared/desktop/`);
  }
}

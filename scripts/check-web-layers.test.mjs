/**
 * Self-test for `check-web-layers.mjs`. Every §2.1 constraint gets a fixture
 * tree that violates it, so the lint is known to fire rather than assumed to.
 *
 * Run: `node --test scripts/check-web-layers.test.mjs`
 * (vitest only picks up `apps/web/src/**`, so this stays a node:test file.)
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkWebLayers, collectSourceFiles, readPanelWidths } from './check-web-layers.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const roots = [];

/** Materialises `{ 'pages/home/HomePage.tsx': '…' }` as a throwaway src tree. */
function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-layers-'));
  roots.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents, 'utf8');
  }
  return root;
}

/** A minimal `design/tokens.data.ts` — same shape the real one has (§3.5). */
const TOKENS_DATA = `export type PanelWidthToken = '--w-nav' | '--w-inspector';

export const PANEL_WIDTH_PX: Record<PanelWidthToken, number> = {
  '--w-nav': 216,
  '--w-nav-collapsed': 56,
  '--w-agent-rail': 46,
  '--w-subnav': 190,
  '--w-panel': 340,
  '--w-inspector': 380,
  '--w-inspector-wide': 440,
  '--w-split': 520,
};
`;

function run(files) {
  return checkWebLayers({ root: fixture({ 'design/tokens.data.ts': TOKENS_DATA, ...files }) });
}

/** Asserts exactly one failure, and that it names the file, line and reason. */
function onlyFailure(result) {
  assert.equal(result.failures.length, 1, `expected exactly one failure, got:\n${result.failures.join('\n')}`);
  return result.failures[0];
}

after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

describe('rule 1 — design/** imports nothing above it', () => {
  for (const [layer, specifier] of [
    ['domain', '../../domain/match/EvidenceRow'],
    ['pages', '../../pages/home/HomePage'],
    ['app', '../../app/AppShell'],
    ['data', '../../data/demos'],
    ['shared/desktop', '../../shared/desktop/dto'],
  ]) {
    it(`rejects design/** → ${layer}/**`, () => {
      const failure = onlyFailure(
        run({ 'design/primitives/Button.tsx': `import { thing } from '${specifier}';\n` }),
      );
      assert.match(failure, /^design\/primitives\/Button\.tsx:1: design\/\*\* must not import /u);
      assert.ok(failure.includes(`${layer}/**`), failure);
    });
  }

  it('accepts design/** → design/** and npm packages', () => {
    const result = run({
      'design/primitives/Button.tsx':
        "import { useState } from 'react';\nimport { Field } from './Field';\nimport '../base.css';\n",
    });
    assert.deepEqual(result.failures, []);
  });
});

describe('rule 2 — domain/** does not reach the top layers', () => {
  it('rejects domain/** → pages/**', () => {
    const failure = onlyFailure(
      run({ 'domain/match/RoundTimeline.tsx': "import { x } from '../../pages/match/MatchPage';\n" }),
    );
    assert.match(failure, /domain\/\*\* must not import pages\/\*\*/u);
  });

  it('rejects domain/** → app/**', () => {
    const failure = onlyFailure(run({ 'domain/task/TaskCard.tsx': "import { x } from '../../app/AppShell';\n" }));
    assert.match(failure, /domain\/\*\* must not import app\/\*\*/u);
  });

  it('accepts domain/** → design/** and data/**', () => {
    const result = run({
      'domain/task/TaskCard.tsx': "import { Button } from '../../design/primitives/Button';\nimport { useTasks } from '../../data/tasks';\n",
    });
    assert.deepEqual(result.failures, []);
  });
});

describe('rule 3 — pages/** and app/** stay apart', () => {
  it('rejects pages/** → app/**', () => {
    const failure = onlyFailure(run({ 'pages/home/HomePage.tsx': "import { shell } from '../../app/AppShell';\n" }));
    assert.match(failure, /^pages\/home\/HomePage\.tsx:1: pages\/\*\* must not import app\/\*\*/u);
  });

  it('rejects app/** → pages/**, including a lazy import', () => {
    const failure = onlyFailure(
      run({ 'app/routes.tsx': "const Home = lazy(() => import('../pages/home/HomePage'));\n" }),
    );
    assert.match(failure, /^app\/routes\.tsx:1: app\/\*\* must not import pages\/\*\*/u);
  });
});

describe('rule 4 — no bare hex', () => {
  for (const layer of ['pages', 'app', 'domain']) {
    it(`rejects a bare hex in ${layer}/**`, () => {
      const failure = onlyFailure(run({ [`${layer}/Thing.tsx`]: 'const dot = { color: "#4d7a5a" };\n' }));
      assert.match(failure, new RegExp(`^${layer}/Thing\\.tsx:1: bare hex colour #4d7a5a`, 'u'));
    });
  }

  it('catches the 3-digit form and reports every line', () => {
    const result = run({ 'pages/home/HomePage.tsx': 'const a = "#fff";\nconst b = "#c9a55a";\n' });
    assert.equal(result.failures.length, 2);
    assert.match(result.failures[0], /HomePage\.tsx:1: bare hex colour #fff/u);
    assert.match(result.failures[1], /HomePage\.tsx:2: bare hex colour #c9a55a/u);
  });

  it('leaves design/** and data/** alone — tokens.data.ts is where hexes live', () => {
    const result = run({
      'design/theme.css': ':root { --color-ok: #4d7a5a; }\n',
      'data/keys.ts': 'export const seed = "#4d7a5a";\n',
    });
    assert.deepEqual(result.failures, []);
  });

  it('does not flag a URL fragment or an id selector', () => {
    const result = run({ 'pages/home/HomePage.tsx': 'const href = "#top";\nconst id = "#root";\n' });
    assert.deepEqual(result.failures, []);
  });

  it('exempts test files, which have to be able to write a hex down', () => {
    const result = run({ 'pages/home/HomePage.test.tsx': 'expect(dot).toBe("#4d7a5a");\n' });
    assert.deepEqual(result.failures, []);
  });

  it('still applies the import rules to test files', () => {
    const failure = onlyFailure(run({ 'pages/home/HomePage.test.tsx': "import { x } from '../../app/AppShell';\n" }));
    assert.match(failure, /pages\/\*\* must not import app\/\*\*/u);
  });
});

describe('rule 5 — arbitrary values carry no font size or colour', () => {
  it('rejects a font size', () => {
    const failure = onlyFailure(run({ 'pages/home/HomePage.tsx': 'const c = "text-[13px] flex";\n' }));
    assert.match(failure, /bare font size in arbitrary value text-\[13px\].*--text-\* token/u);
  });

  it('rejects a colour — once as a bare hex, once as an arbitrary value', () => {
    const { failures } = run({ 'app/AppShell.tsx': 'const c = "bg-[#5980a6]";\n' });
    assert.equal(failures.length, 2, failures.join('\n'));
    assert.match(failures[0], /^app\/AppShell\.tsx:1: bare hex colour #5980a6/u);
    assert.match(failures[1], /^app\/AppShell\.tsx:1: bare colour in arbitrary value bg-\[#5980a6\]/u);
  });

  it('rejects a colour behind a variant prefix', () => {
    const failure = onlyFailure(run({ 'app/AppShell.tsx': 'const c = "hover:border-[rgb(89_128_166)]";\n' }));
    assert.match(failure, /bare colour in arbitrary value border-\[rgb\(89_128_166\)\]/u);
  });

  it('accepts a dimension that is in the §3.5 panel width table', () => {
    const result = run({ 'app/AgentRail.tsx': 'const c = "w-[380px] min-w-[46px] max-w-[520px]";\n' });
    assert.deepEqual(result.failures, []);
  });

  it('rejects a dimension that is not', () => {
    const failure = onlyFailure(run({ 'pages/match/MatchPage.tsx': 'const c = "w-[381px]";\n' }));
    assert.match(failure, /w-\[381px\] is not in the §3\.5 panel width table \(46, 56, 190, 216, 340, 380, 440, 520\)/u);
  });

  it('accepts an arbitrary value that only dereferences a token', () => {
    const result = run({
      'pages/home/HomePage.tsx': 'const c = "text-[var(--text-sm)] bg-[var(--color-ok)] w-[var(--w-inspector)]";\n',
    });
    assert.deepEqual(result.failures, []);
  });

  it('leaves domain/** and design/** arbitrary values alone', () => {
    const result = run({
      'domain/media/Timeline.tsx': 'const c = "w-[132px] text-[10px]";\n',
      'design/layout/Inspector.tsx': 'const c = "w-[132px]";\n',
    });
    assert.deepEqual(result.failures, []);
  });

  it('reports that it cannot check widths when the token table is missing', () => {
    const result = checkWebLayers({ root: fixture({ 'pages/home/HomePage.tsx': 'const c = "w-[380px]";\n' }) });
    assert.match(onlyFailure(result), /cannot be checked — design\/tokens\.data\.ts has no PANEL_WIDTH_PX table/u);
  });
});

describe('rule 6 — the desktop client is reached through data/**', () => {
  for (const [layer, file, specifier] of [
    ['pages', 'pages/library/LibraryPage.tsx', '../../shared/desktop/client'],
    ['domain', 'domain/agent/ShotCard.tsx', '../../shared/desktop/client'],
  ]) {
    it(`rejects ${layer}/** → shared/desktop/client`, () => {
      const failure = onlyFailure(run({ [file]: `import { commands } from '${specifier}';\n` }));
      assert.match(failure, /must not import shared\/desktop\/client directly; go through data\/\*\*/u);
    });
  }

  it('still allows type-only siblings such as shared/desktop/dto', () => {
    const result = run({ 'pages/library/LibraryPage.tsx': "import type { DemoDto } from '../../shared/desktop/dto';\n" });
    assert.deepEqual(result.failures, []);
  });

  it('allows data/** and app/** to hold the client', () => {
    const result = run({
      'data/demos.ts': "import { commands } from '../shared/desktop/client';\n",
      'app/AppShell.tsx': "import { commands } from '../shared/desktop/client';\n",
    });
    assert.deepEqual(result.failures, []);
  });
});

describe('empty and missing trees', () => {
  it('passes on a root that does not exist', () => {
    const result = checkWebLayers({ root: path.join(os.tmpdir(), 'web-layers-absent-root') });
    assert.deepEqual(result.failures, []);
    assert.equal(result.fileCount, 0);
  });

  it('passes when every layer directory is still empty', () => {
    const root = fixture({ 'design/tokens.data.ts': TOKENS_DATA });
    for (const layer of ['domain', 'pages', 'app', 'data']) fs.mkdirSync(path.join(root, layer));
    assert.deepEqual(checkWebLayers({ root }).failures, []);
  });

  it('ignores files outside the layered directories', () => {
    const result = run({
      'features/legacy/LegacyPage.tsx': 'const c = "text-[13px]"; const hex = "#4d7a5a";\n',
      'shared/ui/index.ts': 'export const hex = "#4d7a5a";\n',
    });
    assert.deepEqual(result.failures, []);
  });

  it('skips node_modules', () => {
    const root = fixture({ 'pages/node_modules/pkg/index.ts': 'const hex = "#4d7a5a";\n' });
    assert.deepEqual(collectSourceFiles(root).filter((file) => file.includes('node_modules')), []);
  });
});

describe('the real apps/web/src tree', () => {
  const root = path.resolve(scriptDir, '../apps/web/src');

  it('has a parseable panel width table', () => {
    const widths = readPanelWidths(root);
    assert.ok(widths, 'design/tokens.data.ts must expose PANEL_WIDTH_PX');
    assert.equal(widths.get(380), '--w-inspector');
  });

  it('passes', () => {
    const { failures } = checkWebLayers({ root });
    assert.deepEqual(failures, []);
  });
});

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../styles/index.css', import.meta.url), 'utf8');
const columnCss = readFileSync(new URL('./LibraryPowerTable.css', import.meta.url), 'utf8');

describe('library power-table responsive contract', () => {
  it('keeps the table dense and contains horizontal overflow inside the data surface', () => {
    expect(css).toMatch(/\.library-power-table__scroll\s*\{[^}]*max-width:\s*100%[^}]*overflow-x:\s*auto/s);
    expect(css).toMatch(/\.library-power-table\s*\{[^}]*width:\s*100%[^}]*min-width:\s*900px[^}]*border-collapse:\s*collapse/s);
    expect(css).toMatch(/\.library-power-table\s+(?:th|td)[^{]*\{[^}]*height:\s*44px/s);
    expect(css).toMatch(/\.library-power-table__actions\s*\{[^}]*position:\s*sticky[^}]*right:\s*0/s);
  });

  it('uses a persistent inspector on wide screens and the existing drawer below 1700px', () => {
    expect(css).toMatch(/\.library-demo-inspector\s*\{[^}]*position:\s*sticky/s);
    expect(css).toMatch(/@media\s*\(max-width:\s*1699px\)[\s\S]*?\.page--library\s+\.library-workspace-side\s*\{[^}]*display:\s*none/s);
    expect(css).toMatch(/\.drawer\s+\.library-demo-inspector\s*\{[^}]*position:\s*static/s);
  });

  it('keeps pagination discoverable and wrapped inside the 1100 by 700 geometry', () => {
    expect(css).toMatch(/\.library-pagination\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap/s);
    expect(css).toMatch(/@media\s*\(max-width:\s*1180px\)\s*and\s*\(max-height:\s*760px\)[\s\S]*?\.page--library\s+\.library-pagination\s*\{[^}]*position:\s*sticky/s);
    expect(css).toMatch(/\.library-map-filter\s*\{[^}]*min-width:\s*0[^}]*border:\s*0/s);
  });

  it('anchors the column chooser and derives table width from real visible columns', () => {
    expect(columnCss).toMatch(/\.library-column-visibility\s*\{[^}]*position:\s*relative/s);
    expect(columnCss).toMatch(/\.library-column-visibility__panel\s*\{[^}]*position:\s*absolute[^}]*z-index:/s);
    expect(columnCss).toMatch(/\.library-power-table\[data-optional-column-count="6"\]\s*\{[^}]*min-width:\s*1100px/s);
    expect(columnCss).toMatch(/\.library-power-table th\[data-column="file"\]\s*\{[^}]*width:\s*auto/s);
    expect(columnCss).toMatch(/@media\s*\(max-width:\s*1180px\)[\s\S]*\.library-column-visibility__panel\s*\{[^}]*right:\s*0/s);
  });
});

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../styles/index.css', import.meta.url), 'utf8');
const pageSource = readFileSync(new URL('./PlayersPage.tsx', import.meta.url), 'utf8');

describe('players power-table responsive contract', () => {
  it('uses the full maximized workspace for a dense table and persistent inspector', () => {
    expect(css).toMatch(/\.page\.page--players\s*\{[^}]*width:\s*100%[^}]*max-width:\s*none/s);
    expect(css).toMatch(/\.page--players\s+\.players-workspace\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1\.65fr\)\s+minmax\(380px,\s*\.7fr\)/s);
    expect(css).toMatch(/\.player-inspector-shell\s*\{[^}]*position:\s*sticky/s);
  });

  it('contains table overflow and keeps primary row actions visible at 1100 pixels', () => {
    expect(css).toMatch(/\.player-power-table__scroll\s*\{[^}]*max-width:\s*100%[^}]*overflow-x:\s*auto/s);
    expect(css).toMatch(/\.player-power-table\s*\{[^}]*width:\s*100%[^}]*min-width:\s*1180px[^}]*border-collapse:\s*collapse/s);
    expect(css).toMatch(/\.player-power-table__actions\s*\{[^}]*position:\s*sticky[^}]*right:\s*0/s);
    expect(css).toMatch(/@media\s*\(max-width:\s*1399px\)[\s\S]*?\.page--players\s+\.players-workspace\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
    expect(pageSource).toContain("window.matchMedia('(min-width: 1400px)')");
    expect(pageSource).toContain('open={!wideInspector && compactInspectorOpen && comparedIds.length > 0}');
    expect(pageSource).toContain('!wideInspector && comparedIds.length > 0 && !compactInspectorOpen');
    expect(pageSource).toContain('<div className="player-inspector-drawer">{playerInspector}</div>');
  });

  it('keeps cross-match evidence links operable in the narrow inspector', () => {
    expect(css).toMatch(/\.player-cross-match-evidence nav a,[\s\S]*?min-height:\s*24px[^}]*padding:\s*4px 5px/s);
    expect(css).toMatch(/\.player-cross-match-evidence nav a:focus-visible,[\s\S]*?background:\s*var\(--accent-soft\)/s);
    expect(css).toMatch(/@media\s*\(max-width:\s*780px\)[\s\S]*?\.player-cross-match-evidence article\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('../../styles/index.css', import.meta.url), 'utf8');
const compactContract = styles.split('/* Analysis 1100×700 responsive contract. */')[1] ?? '';
const compactReplayContract = (styles.split('/* Replay is a bounded operating surface at the supported 1100×700 window. */')[1] ?? '')
  .split('/* Analysis 1100×700 responsive contract. */')[0] ?? '';

describe('analysis 1100×700 responsive styles', () => {
  it('gives every supported 1100px workspace a compact navigation rail', () => {
    expect(styles).toMatch(/@media \(max-width: 1279px\) and \(min-width: 651px\)\s*{[^}]*\.app-shell\s*{[^}]*--sidebar-width:\s*68px;/s);
    expect(styles).toMatch(/@media \(max-width: 1279px\) and \(min-width: 651px\)[\s\S]*?\.app-shell \.sidebar-link\s*{[^}]*justify-content:\s*center;/s);
  });

  it('uses the complete compact workspace height while keeping replay transport in the viewport', () => {
    expect(compactReplayContract).toMatch(/\.analysis-layout:has\(\.replay-layout\[data-replay-density="compact"\]\)\s*{[^}]*height:\s*calc\(100dvh - 118px\);[^}]*min-height:\s*0;/s);
    expect(compactReplayContract).toMatch(/\.replay-layout\[data-replay-density="compact"\]\s*{[^}]*height:\s*100%;/s);
  });

  it('uses the width recovered by the compact rail to keep match facts in one 52px row', () => {
    expect(compactContract).toMatch(/@media \(max-width: 1180px\) and \(max-height: 760px\)/);
    expect(compactContract).toMatch(/\.page--analysis \.analysis-match-header\s*{[^}]*height:\s*52px;[^}]*min-height:\s*52px;[^}]*grid-template-columns:\s*minmax\(300px, 1fr\) auto auto;/s);
    expect(compactContract).toMatch(/\.analysis-match-header__meta\s*{[^}]*grid-column:\s*2;[^}]*grid-row:\s*1;/s);
    expect(compactContract).toMatch(/\.analysis-match-header__actions\s*{[^}]*grid-column:\s*3;[^}]*grid-row:\s*1;/s);
  });

  it('bounds the context canvas to the remaining viewport instead of scrolling the whole page', () => {
    expect(compactContract).toMatch(/\.page--analysis \.analysis-layout:has\(\.round-context-canvas\)\s*{[^}]*height:\s*calc\(100dvh - 118px\);[^}]*min-height:\s*0;/s);
    expect(compactContract).toMatch(/\.page--analysis \.analysis-view:has\(> \.round-context-canvas\)\s*{[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s);
    expect(compactContract).toMatch(/\.page--analysis \.round-context-canvas\s*{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\);/s);
    expect(compactContract).toMatch(/\.page--analysis \.round-context-body\s*{[^}]*height:\s*100%;[^}]*min-height:\s*0;/s);
  });

  it('fits all verified scoreboard columns inside the compact overview workspace', () => {
    expect(compactContract).toMatch(/\.players-table-card--compact \.players-table\s*{[^}]*width:\s*100%;[^}]*min-width:\s*min\(600px, 100%\);/s);
    expect(compactContract).toMatch(/\.players-table-card--compact \.data-table\s*{[^}]*overflow-x:\s*auto;[^}]*scrollbar-gutter:\s*stable;/s);
  });

  it('keeps the complete round scope horizontally scrollable with a visible affordance', () => {
    expect(compactContract).toMatch(/\.round-context-ribbon\s*{[^}]*scrollbar-gutter:\s*stable;[^}]*scrollbar-color:\s*var\(--accent\) var\(--surface-3\);/s);
    expect(compactContract).toMatch(/\.round-context-ribbon::-webkit-scrollbar\s*{[^}]*height:\s*8px;/s);
    expect(compactContract).toMatch(/\.round-context-ribbon button\.is-active\s*{[^}]*scroll-margin-inline:\s*48px;/s);
  });

  it('keeps the complete round inspector reachable when comments and tags extend it', () => {
    expect(styles).toMatch(/\.page--analysis \.round-context-inspector\s*{[^}]*overflow-y:\s*auto;[^}]*scrollbar-width:\s*thin;/s);
  });
});

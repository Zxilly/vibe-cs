import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./UtilityAnalysisWorkspace.css', import.meta.url), 'utf8');
const viewportContract = styles.split('/* Utility evidence consumes the complete analysis viewport. */')[1] ?? '';

describe('utility analysis responsive workspace', () => {
  it('uses the remaining viewport and keeps the inspector discoverable at 1100×700 and maximized sizes', () => {
    expect(viewportContract).toMatch(/\.analysis-layout:has\(\.utility-analysis-workspace\)\s*{[^}]*height:\s*calc\(100dvh - 118px\);[^}]*min-height:\s*0;/s);
    expect(viewportContract).toMatch(/\.analysis-view:has\(> \.utility-analysis-workspace\)\s*{[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s);
    expect(styles).toMatch(/\.utility-analysis-workspace\s*{[^}]*height:\s*100%;[^}]*grid-template-rows:\s*auto auto minmax\(0, 1fr\);/s);
    expect(styles).toMatch(/\.utility-analysis-canvas\s*{[^}]*grid-template-rows:\s*minmax\(0, 1fr\) auto;/s);
    expect(styles).toMatch(/@media \(min-width: 1500px\)[\s\S]*?\.utility-analysis-canvas\s*{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(285px, 330px\);/s);
    expect(styles).toMatch(/@media \(max-width: 1180px\) and \(max-height: 760px\)[\s\S]*?\.utility-analysis-inspector\s*{[^}]*max-height:\s*128px;/s);
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./WeaponAnalysisWorkspace.css', import.meta.url), 'utf8');
const viewportContract = styles.split('/* Weapons consumes the complete analysis viewport. */')[1] ?? '';

describe('weapon analysis responsive workspace', () => {
  it('uses the remaining viewport at both supported compact and maximized sizes', () => {
    expect(viewportContract).toMatch(/\.analysis-layout:has\(\.weapon-analysis-workspace\)\s*{[^}]*height:\s*calc\(100dvh - 118px\);[^}]*min-height:\s*0;/s);
    expect(viewportContract).toMatch(/\.analysis-view:has\(> \.weapon-analysis-workspace\)\s*{[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s);
    expect(styles).toMatch(/\.weapon-analysis-workspace\s*{[^}]*height:\s*100%;[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\);/s);
    expect(styles).toMatch(/@media \(min-width: 1700px\)[\s\S]*?\.weapon-analysis-canvas\s*{[^}]*grid-template-columns:\s*minmax\(280px, 330px\) minmax\(0, 1fr\);/s);
  });
});

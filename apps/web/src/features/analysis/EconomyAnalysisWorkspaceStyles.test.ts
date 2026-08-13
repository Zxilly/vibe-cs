import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
  fileURLToPath(new URL('./EconomyAnalysisWorkspace.css', import.meta.url)),
  'utf8',
);

describe('economy workspace density styles', () => {
  it('fills the analysis viewport and keeps table and inspector independently usable', () => {
    expect(css).toMatch(/\.economy-analysis-workspace\s*\{[^}]*height:\s*100%/s);
    expect(css).toMatch(/\.economy-analysis-canvas\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s);
    expect(css).toMatch(/\.economy-analysis-table__rows\s*\{[^}]*overflow:\s*auto/s);
    expect(css).toMatch(/\.economy-analysis-purchases__rows\s*\{[^}]*overflow:\s*auto/s);
    expect(css).toMatch(/\.economy-analysis-round-row\s*\{[^}]*content-visibility:\s*auto/s);
  });

  it('uses a side inspector when maximized and compacts controls at 1100 by 700', () => {
    expect(css).toMatch(/@media\s*\(min-width:\s*1500px\)[\s\S]*\.economy-analysis-canvas\s*\{[^}]*grid-template-columns:/s);
    expect(css).toMatch(/@media\s*\(max-width:\s*1180px\)\s*and\s*\(max-height:\s*760px\)[\s\S]*\.economy-analysis-toolbar/s);
    expect(css).toMatch(/\.page--analysis\s+\.analysis-layout:has\(\.economy-analysis-workspace\)\s*\{[^}]*height:\s*calc\(100dvh\s*-\s*118px\)/s);
  });
});

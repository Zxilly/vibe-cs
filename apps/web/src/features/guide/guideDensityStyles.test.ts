import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('../../styles/index.css', import.meta.url), 'utf8');
const densityContract = styles.split('/* Guide task-first density contract. */')[1] ?? '';

describe('guide task-first density styles', () => {
  it('renders the only user prerequisite as one bounded inline preflight', () => {
    expect(densityContract).toMatch(/\.page--guide \.guide-preflight\s*{[^}]*display:\s*grid;[^}]*min-height:\s*64px;[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto;/s);
    expect(densityContract).toMatch(/\.guide-preflight__copy\s*{[^}]*min-width:\s*0;/s);
    expect(densityContract).toMatch(/\.guide-preflight--missing\s*{[^}]*border-color:[^}]*--red/s);
  });

  it('uses the desktop width for three primary workflow steps', () => {
    expect(densityContract).toMatch(/\.page--guide \.workflow-grid\s*{[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);/s);
    expect(densityContract).toMatch(/\.page--guide \.workflow-card\s*{[^}]*min-height:\s*178px;/s);
  });

  it('stacks only when the viewport can no longer support three usable cards', () => {
    expect(densityContract).toMatch(/@media \(max-width: 780px\)[\s\S]*?\.page--guide \.workflow-grid,[\s\S]*?\.page--guide \.quick-grid\s*{[^}]*grid-template-columns:\s*1fr;/s);
  });
});

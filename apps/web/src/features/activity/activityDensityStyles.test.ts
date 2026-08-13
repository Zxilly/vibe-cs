import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('../../styles/index.css', import.meta.url), 'utf8');
const contract = styles.split('/* Activity Center is a bounded cross-workflow task surface. */')[1] ?? '';

describe('activity workspace density styles', () => {
  it('uses the complete desktop viewport instead of the global centered content cap', () => {
    expect(contract).toMatch(/\.page\.page--activity\s*{[^}]*width:\s*100%;[^}]*max-width:\s*none;[^}]*height:\s*100%;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s);
  });

  it('keeps the task table and inspector visible side by side at 1100px', () => {
    expect(contract).toMatch(/\.activity-workspace\s*{[^}]*min-height:\s*0;[^}]*grid-template-columns:\s*minmax\(520px, 1fr\) minmax\(280px, 340px\);/s);
    expect(contract).toMatch(/\.activity-table-scroll\s*{[^}]*height:\s*100%;[^}]*overflow:\s*auto;/s);
    expect(contract).toMatch(/@media \(max-width:\s*900px\)[\s\S]*?\.activity-workspace\s*{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/s);
  });

  it('keeps filter labels inline so controls remain inside the compact toolbar', () => {
    expect(contract).toMatch(/\.activity-toolbar\s*>\s*label:not\(\.activity-search\)\s*{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\);[^}]*align-items:\s*center;/s);
  });
});

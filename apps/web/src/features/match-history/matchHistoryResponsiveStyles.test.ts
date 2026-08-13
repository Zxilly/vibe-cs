import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('../../styles/index.css', import.meta.url), 'utf8');
const contract = styles.split('/* Match History is a full-width data workspace. */')[1] ?? '';

describe('Match History data-workspace styles', () => {
  it('uses all available desktop width instead of inheriting the global 1540px cap', () => {
    expect(contract).toMatch(/\.page\.page--match-history\s*{[^}]*width:\s*100%;[^}]*max-width:\s*none;[^}]*min-width:\s*0;/s);
  });

  it('keeps the list and rows shrinkable without horizontal page overflow below 1700px', () => {
    expect(contract).toMatch(/\.page--match-history \.history-list,\s*\.page--match-history \.history-row,\s*\.page--match-history \.history-row__main\s*{[^}]*min-width:\s*0;/s);
    expect(contract).toMatch(/@media \(max-width:\s*1699px\) and \(min-width:\s*651px\)[\s\S]*?\.page--match-history \.history-row\s*{[^}]*grid-template-columns:\s*28px 46px minmax\(0, 1fr\) minmax\(64px, 70px\) minmax\(0, 150px\);/s);
  });

  it('uses a bounded compact empty state instead of reserving a 400px data list', () => {
    expect(contract).toMatch(/\.page--match-history \.history-empty-card--compact\s*{[^}]*min-height:\s*0;/s);
    expect(contract).toMatch(/\.page--match-history \.history-empty-card--compact > \.empty-state\s*{[^}]*min-height:\s*180px;[^}]*padding:\s*20px;/s);
  });
});

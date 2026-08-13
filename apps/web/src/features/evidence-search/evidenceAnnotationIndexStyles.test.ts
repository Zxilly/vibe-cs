import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./EvidenceSearchPage.css', import.meta.url), 'utf8');
const contract = styles.split('/* Global annotation index keeps persisted notes and evidence locators inspectable. */')[1] ?? '';

describe('evidence annotation index styles', () => {
  it('keeps the annotation list bounded inside the desktop workbench', () => {
    expect(contract).toMatch(/\.evidence-annotation-index-results\s*{[^}]*display:\s*flex;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s);
    expect(contract).toMatch(/\.evidence-annotation-index-list\s*{[^}]*flex:\s*1;[^}]*min-height:\s*0;[^}]*overflow:\s*auto;/s);
  });

  it('keeps canonical locators readable without forcing document overflow', () => {
    expect(contract).toMatch(/\.evidence-annotation-index-row__locator\s*{[^}]*min-width:\s*0;[^}]*grid-template-columns:/s);
    expect(contract).toMatch(/\.evidence-annotation-index-row__locator code\s*{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;/s);
  });

  it('stacks locator details and actions in narrow windows', () => {
    expect(contract).toMatch(/@media \(max-width:\s*900px\)[\s\S]*?\.evidence-annotation-index-row__locator\s*{[^}]*grid-template-columns:\s*1fr;/s);
  });
});

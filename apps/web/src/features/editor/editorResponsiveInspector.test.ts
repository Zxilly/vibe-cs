import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const editorSource = readFileSync(new URL('./EditorPage.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../../styles/index.css', import.meta.url), 'utf8');
const responsiveContract = styles.split('/* Editor responsive inspector contract. */')[1] ?? '';

describe('editor responsive property inspector', () => {
  it('keeps property editing reachable through an accessible modal drawer', () => {
    expect(editorSource).toContain('data-testid="editor-inspector-trigger"');
    expect(editorSource).toContain('data-testid="editor-inspector-drawer"');
    expect(editorSource).toContain("role={inspectorDrawerOpen ? 'dialog' : undefined}");
    expect(editorSource).toContain('aria-modal={inspectorDrawerOpen ? true : undefined}');
    expect(editorSource).toContain('useDialogFocus<HTMLElement>(inspectorDrawerOpen');
  });

  it('preserves the wide three-column editor and bounds the narrow drawer to the viewport', () => {
    expect(responsiveContract).toMatch(/@media \(min-width: 1401px\)[\s\S]*grid-template-columns:\s*minmax\(260px, \.72fr\) minmax\(520px, 1\.6fr\) minmax\(310px, \.82fr\)/);
    expect(responsiveContract).toMatch(/@media \(max-width: 1400px\)[\s\S]*\.editor-inspector-trigger\s*{[^}]*display:\s*inline-flex;/s);
    expect(responsiveContract).toMatch(/\.property-panel\.is-drawer-open\s*{[^}]*position:\s*fixed;[^}]*width:\s*min\(380px, calc\(100vw - 16px\)\);[^}]*overflow:\s*hidden;/s);
    expect(responsiveContract).toMatch(/\.editor-inspector-backdrop\s*{[^}]*position:\s*fixed;[^}]*inset:\s*0;/s);
    expect(responsiveContract).toMatch(/\.editor-shell\s*{[^}]*max-width:\s*100vw;[^}]*overflow:\s*hidden;/s);
    expect(styles).not.toMatch(/\.property-panel\s*{\s*display:\s*none/);
  });
});

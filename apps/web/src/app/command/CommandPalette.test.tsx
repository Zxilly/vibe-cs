/*
 * Markup project (node): the palette's structure, roles and artboard copy.
 *
 * The combobox wiring is the load-bearing part here — a palette whose input is
 * not linked to its list, or whose active row is not announced, is unusable
 * with a screen reader even though it looks right.
 */

import { describe, expect, it } from 'vitest';

import { renderMarkupDom } from '../../test/render';

/* `renderMarkupDom`, not `renderMarkup`: the palette is portalled, and
   `react-dom/server` throws on `createPortal`. */
const renderMarkup = renderMarkupDom;
import { CommandPalette } from './CommandPalette';
import type { CommandDefinition } from './commandRegistry';

const noop = () => {};

function render(
  overrides: {
    readonly commands?: readonly CommandDefinition[] | undefined;
    readonly limitPerGroup?: number | undefined;
  } = {},
) {
  return renderMarkup(
    <CommandPalette
      open
      onClose={noop}
      navigate={noop}
      commands={overrides.commands}
      limitPerGroup={overrides.limitPerGroup}
    />,
  );
}

describe('CommandPalette markup', () => {
  it('renders nothing while closed', () => {
    // The portal has nothing in it, so nothing reaches the document.
    const html = renderMarkup(<CommandPalette open={false} onClose={noop} navigate={noop} />);
    expect(html).not.toContain('data-overlay="command-palette"');
  });

  it('is a labelled modal dialog over a scrim that starts below the title bar', () => {
    const html = render();
    expect(html).toContain('role="dialog"');
    /* Radix states modality by hiding the rest of the document from assistive
       technology rather than by claiming `aria-modal`. */
    expect(html).toContain('data-aria-hidden="true"');
    expect(html).toContain('aria-label="命令面板"');
    expect(html).toContain('data-overlay="command-palette-backdrop"');
    expect(html).toContain('top-[var(--h-titlebar)]');
  });

  it('wires the input to the list as a combobox with an active option', () => {
    const html = render();
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-autocomplete="list"');
    expect(html).toContain('role="listbox"');
    // The input names both the list it controls and the row Enter would run.
    expect(html).toMatch(/aria-controls="[^"]+-list"/u);
    expect(html).toMatch(/aria-activedescendant="[^"]+-option-0"/u);
  });

  it('selects the first row, so 「回车执行首条」 is true before any keystroke', () => {
    const html = render();
    const first = html.indexOf('aria-selected="true"');
    const second = html.indexOf('aria-selected="true"', first + 1);
    expect(first).toBeGreaterThan(-1);
    expect(second).toBe(-1);
    expect(html.slice(first, first + 400)).toContain('data-command-id="page.home"');
  });

  it('groups the rows and heads each group with its label', () => {
    const html = render();
    expect(html).toContain('role="group"');
    expect(html).toContain('>页面</div>');
  });

  it('caps a group at four rows and says how many it is hiding', () => {
    const html = render();
    expect(html.match(/role="option"/gu) ?? []).toHaveLength(4);
    expect(html).toContain('data-command-id="page.home"');
    expect(html).toContain('data-command-id="page.players"');
    expect(html).not.toContain('data-command-id="page.settings"');
    // 14 page commands, four shown.
    expect(html).toContain('还有 10 条');
  });

  it('draws the header chip and the keyboard hint row from the artboard', () => {
    const html = render();
    // The key is a `Kbd` chip and the verb beside it is copy — see `Kbd`.
    expect(html).toMatch(/<kbd[^>]*>ESC<\/kbd>/u);
    expect(html).toContain('关闭');
    expect(html).toContain('↑↓ 选择');
    expect(html).toContain('↵ 打开');
    expect(html).toContain('TAB 切换分组');
    expect(html).toContain('搜索比赛、选手、证据、页面和动作');
  });

  it('shows a shortcut chip when a command advertises one', () => {
    const withShortcut: CommandDefinition[] = [
      {
        id: 'action.import-demo',
        group: 'action',
        title: { id: 'import', message: '导入 Demo' },
        keywords: [],
        shortcut: 'CTRL I',
        run: noop,
      },
    ];
    const html = render({ commands: withShortcut });
    expect(html).toContain('<kbd');
    expect(html).toContain('CTRL I');
    expect(html).toContain('>动作</div>');
  });

  it('states the matching contract instead of an empty box when nothing matches', () => {
    const html = render({ commands: [] });
    expect(html).toContain('role="status"');
    expect(html).toContain('没有匹配的结果');
    expect(html).toContain('不做拼音和模糊匹配');
    expect(html).not.toContain('role="listbox"');
  });

  it('takes every size from a token, never from a literal', () => {
    const html = render();
    for (const token of [
      'w-[var(--w-overlay)]',
      'h-[var(--h-topbar)]',
      'h-[var(--h-row-compact)]',
      'top-[calc(var(--h-titlebar)*2)]',
      'shadow-[var(--shadow-lg)]',
    ]) {
      expect(html).toContain(token);
    }
  });
});

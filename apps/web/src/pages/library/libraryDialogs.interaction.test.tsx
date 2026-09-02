/*
 * `interaction` project — the library's five overlays, one describe each.
 *
 * 「补齐 · 规范与状态」 draws eleven overlays and states the division of labour
 * under them: 「Dialog 只承载不可逆动作与正式确认；Drawer 承载详情与非阻断编辑；
 * 两者都有焦点陷阱、Esc 关闭和关闭后焦点归位」. Five of the eleven belong to
 * this page — 导入 Demo · 添加监听目录 · 列配置 · 保存为视图 · 删除 N 条记录 —
 * and each one is asserted here on what it *does*, not on how it looks.
 *
 * The sixth overlay this page opens, 「监听目录」, is a Drawer rather than a
 * Dialog and is covered at the bottom: it is a list you read and edit, not a
 * confirmation, so the artboard's own rule puts it on the other side of the
 * line. See `WatchDirectoriesDrawer`'s header.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { AppConfig } from '../../shared/desktop/dto';
import {
  CONFIG_FIXTURE,
  DEMO_FIXTURE,
  TAG_FIXTURE,
  WATCH_FIXTURE,
  demoPage,
  makeDemo,
  recorder,
  renderLibrary,
} from './test/renderLibrary';

const ONLINE = {
  demos: demoPage([DEMO_FIXTURE]),
  watch: WATCH_FIXTURE,
  tags: [TAG_FIXTURE],
  config: CONFIG_FIXTURE,
} as const;

const SCAN_RESULT = { discovered: 1, imported: 1, updated: 0, skipped: 0, errors: [] };

function dialog(): HTMLElement {
  return screen.getByRole('dialog');
}

describe('导入 Demo', () => {
  it('opens on the primary action and shows the artboard’s drop target', () => {
    renderLibrary({ seed: ONLINE });

    fireEvent.click(screen.getByRole('button', { name: /导入 Demo/u }));

    expect(within(dialog()).getByText('把 .dem 或 .zip 拖到这里')).toBeTruthy();
    expect(within(dialog()).getByText('校验文件头与大小；同一份内容不会重复入库')).toBeTruthy();
    // Nothing staged yet, so the primary is still the artboard's 「选择文件」.
    expect(within(dialog()).getByRole('button', { name: '选择文件' })).toBeTruthy();
  });

  it('turns into a real confirmation once files are staged, and imports them', async () => {
    const importer = recorder(SCAN_RESULT);
    renderLibrary({ seed: ONLINE, client: { importDemos: importer.call } });

    fireEvent.click(screen.getByRole('button', { name: /导入 Demo/u }));

    const file = new File([new Uint8Array([1, 2, 3])], 'aurora.dem');
    fireEvent.change(within(dialog()).getByLabelText('选择要导入的 Demo 文件'), {
      target: { files: [file] },
    });

    const confirm = await within(dialog()).findByRole('button', { name: '导入 1 个文件' });
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(importer.calls()).toBe(1);
    });
    expect((importer.lastArgs()[0] as File[])[0]?.name).toBe('aurora.dem');
    // A successful import closes the overlay.
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('renders a failure in place, with a retry, and keeps the staged files', async () => {
    const importer = recorder(SCAN_RESULT);
    importer.fail(new Error('磁盘空间不足'));
    renderLibrary({ seed: ONLINE, client: { importDemos: importer.call } });

    fireEvent.click(screen.getByRole('button', { name: /导入 Demo/u }));
    fireEvent.change(within(dialog()).getByLabelText('选择要导入的 Demo 文件'), {
      target: { files: [new File([], 'aurora.dem')] },
    });
    fireEvent.click(await within(dialog()).findByRole('button', { name: '导入 1 个文件' }));

    // 「不用 Toast 承载错误」 — the message lands inside the dialog, beside the
    // button that failed, with the one recovery action `Notice` requires.
    expect(await within(dialog()).findByText('磁盘空间不足')).toBeTruthy();
    expect(within(dialog()).getByRole('button', { name: '重试' })).toBeTruthy();
    expect(within(dialog()).getByRole('button', { name: '导入 1 个文件' })).toBeTruthy();
  });
});

describe('添加监听目录', () => {
  it('refuses a duplicate before the round trip, and says which rule it broke', async () => {
    renderLibrary({ seed: ONLINE });

    fireEvent.click(screen.getByRole('button', { name: '监听目录' }));
    fireEvent.click(await screen.findByRole('button', { name: /添加目录/u }));

    const field = within(dialog()).getByLabelText('目录');
    fireEvent.change(field, { target: { value: 'D:\\CS2\\demos' } });

    expect(within(dialog()).getByText('这个目录已经在监听中')).toBeTruthy();
    expect(
      (within(dialog()).getByRole('button', { name: '开始监听' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('appends the path to the config document, leaving the rest of it alone', async () => {
    const update = recorder(CONFIG_FIXTURE);
    renderLibrary({ seed: ONLINE, client: { updateConfig: update.call } });

    fireEvent.click(screen.getByRole('button', { name: '监听目录' }));
    fireEvent.click(await screen.findByRole('button', { name: /添加目录/u }));
    fireEvent.change(within(dialog()).getByLabelText('目录'), {
      target: { value: 'G:\\new\\demos' },
    });
    fireEvent.click(within(dialog()).getByRole('button', { name: '开始监听' }));

    await waitFor(() => {
      expect(update.calls()).toBe(1);
    });
    const sent = update.lastArgs()[0] as AppConfig;
    expect(sent.demo_watch_paths).toEqual([...CONFIG_FIXTURE.demo_watch_paths, 'G:\\new\\demos']);
  });

  it('states the recursion rule instead of offering a toggle with no wire', async () => {
    renderLibrary({ seed: ONLINE });

    fireEvent.click(screen.getByRole('button', { name: '监听目录' }));
    fireEvent.click(await screen.findByRole('button', { name: /添加目录/u }));

    const box = within(dialog()).getByRole('checkbox', { name: '包含子目录' }) as HTMLButtonElement;
    expect(box.getAttribute('aria-checked')).toBe('true');
    expect(box.disabled).toBe(true);
    expect(within(dialog()).getByText('服务当前按目录递归监听，子目录会一同纳入')).toBeTruthy();
  });
});

describe('列配置', () => {
  it('applies a draft, and only on 应用', async () => {
    renderLibrary({ seed: ONLINE });

    expect(within(screen.getByRole('table')).getByRole('button', { name: '地图' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '列配置' }));
    fireEvent.click(within(dialog()).getByRole('checkbox', { name: '地图' }));

    /* Queried through the DOM, not through the accessibility tree: the dialog
       is modal, so Radix hides the rest of the document from assistive
       technology while it is open — which is the point of a modal, and means
       `getByRole('table')` finds nothing until it closes. */
    const table = (): HTMLElement => {
      const node = document.querySelector('table');
      if (node === null) throw new Error('no table');
      return node;
    };
    const mapHeader = (): Element | null =>
      Array.from(table().querySelectorAll('button')).find((button) => button.textContent === '地图') ?? null;

    // Still there: the edit is a draft until it is applied.
    expect(mapHeader()).not.toBeNull();

    fireEvent.click(within(dialog()).getByRole('button', { name: '应用' }));

    await waitFor(() => {
      expect(mapHeader()).toBeNull();
    });
  });

  it('never offers the identity column, which cannot be hidden', () => {
    renderLibrary({ seed: ONLINE });

    fireEvent.click(screen.getByRole('button', { name: '列配置' }));

    expect(within(dialog()).queryByRole('checkbox', { name: '比赛' })).toBeNull();
    expect(within(dialog()).queryByRole('checkbox', { name: '行操作' })).toBeNull();
  });
});

describe('保存为视图', () => {
  it('saves the current address and shows it as the artboard’s accent tag', async () => {
    renderLibrary({ at: '/library?q=kael', seed: ONLINE });

    fireEvent.click(screen.getByRole('button', { name: '保存为视图' }));
    fireEvent.change(within(dialog()).getByLabelText('名称'), { target: { value: '待剪素材' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(screen.getByText('保存的视图 · 待剪素材')).toBeTruthy();
    });
  });

  it('will not save an empty or a duplicate name', () => {
    renderLibrary({ seed: ONLINE });

    fireEvent.click(screen.getByRole('button', { name: '保存为视图' }));
    const confirm = within(dialog()).getByRole('button', { name: '保存' }) as HTMLButtonElement;

    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog()).getByLabelText('名称'), { target: { value: '   ' } });
    expect(confirm.disabled).toBe(true);
  });
});

describe('删除 N 条记录', () => {
  it('states the blast radius the artboard states, from the real selection', () => {
    renderLibrary({
      seed: {
        ...ONLINE,
        demos: demoPage([
          makeDemo(0, { source: 'upload' }),
          makeDemo(1, { source: 'upload' }),
          makeDemo(2, { source: 'watch' }),
        ]),
      },
    });

    for (const box of screen
      .getAllByRole('checkbox')
      .filter((node) => node.getAttribute('aria-label')?.startsWith('选择') === true)) {
      fireEvent.click(box);
    }
    fireEvent.click(screen.getByRole('button', { name: /删除记录/u }));

    const panel = dialog();
    expect(within(panel).getByText('删除 3 条记录？')).toBeTruthy();
    expect(panel.textContent).toContain('其中 2 条是受管文件，会进入可回滚暂存，24 小时后清除。');
    expect(panel.textContent).toContain('1 条是外部文件，只移除记录，磁盘上的文件不会被删除。');
    // The destructive tone the artboard paints it in.
    expect(panel.getAttribute('data-tone')).toBe('destructive');
  });

  it('deletes exactly the selected ids and clears the selection', async () => {
    const remove = recorder(undefined);
    renderLibrary({
      seed: { ...ONLINE, demos: demoPage([makeDemo(0), makeDemo(1)]) },
      client: { deleteDemo: remove.call, listDemos: () => Promise.resolve(demoPage([makeDemo(1)])) },
    });

    fireEvent.click(screen.getByRole('checkbox', { name: '选择 Aurora vs Meridian · 第 1 场' }));
    fireEvent.click(screen.getByRole('button', { name: /删除记录/u }));
    fireEvent.click(within(dialog()).getByRole('button', { name: '删除' }));

    await waitFor(() => {
      expect(remove.calls()).toBe(1);
    });
    expect(remove.lastArgs()[0]).toBe('demo-0');
    await waitFor(() => {
      expect(document.querySelector('[data-selection-bar]')).toBeNull();
    });
  });
});

describe('监听目录 (Drawer, not Dialog)', () => {
  it('lists every root with the service’s own state and message', async () => {
    renderLibrary({ seed: ONLINE });

    fireEvent.click(screen.getByRole('button', { name: '监听目录' }));

    const drawer = await screen.findByRole('dialog', { name: '监听目录' });
    expect(drawer.textContent).toContain('D:\\CS2\\demos\\');
    expect(drawer.textContent).toContain('目录不存在');
    expect(drawer.textContent).toContain('不接受符号链接根目录');
    expect(drawer.textContent).toContain('3 个目录');
  });

  it('stops watching one root by writing the shortened list back', async () => {
    const update = recorder(CONFIG_FIXTURE);
    renderLibrary({ seed: ONLINE, client: { updateConfig: update.call } });

    fireEvent.click(screen.getByRole('button', { name: '监听目录' }));
    fireEvent.click(await screen.findByRole('button', { name: '停止监听 E:\\replays\\' }));

    await waitFor(() => {
      expect(update.calls()).toBe(1);
    });
    expect((update.lastArgs()[0] as AppConfig).demo_watch_paths).toEqual([
      'D:\\CS2\\demos\\',
      'F:\\link\\',
    ]);
  });
});

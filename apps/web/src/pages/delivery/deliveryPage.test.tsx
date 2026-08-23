/*
 * `markup` project — the frame of the three phase-3a pages, and their loading
 * state.
 *
 * `renderToStaticMarkup` runs no effects, so every query is still pending here.
 * That is exactly the state worth pinning: the artboard's rule for a page whose
 * data has not arrived is 「加载中 · 表格骨架（不显示虚构百分比）」, and the way
 * that goes wrong is a placeholder bar with a made-up number in it.
 */

import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { DeliveryPage } from '../DeliveryPage';
import { HomePage } from '../HomePage';
import { TaskDetailPage } from '../TaskDetailPage';
import { PANEL_WIDTH_PX } from '../../design/tokens.data';

function at(pattern: string, url: string, element: React.ReactElement): string {
  return renderMarkup(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path={pattern} element={element} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('/delivery', () => {
  const outputs = at('/delivery', '/delivery', <DeliveryPage />);
  const tasks = at('/delivery', '/delivery?view=tasks', <DeliveryPage />);

  it('is a Page with a Toolbar, not a bare div', () => {
    expect(outputs).toContain('data-page=');
    expect(outputs).toContain('data-page-toolbar');
    expect(outputs).toContain('data-page-body');
    expect(outputs).toContain('data-toolbar-title="true"');
    expect(outputs).toContain('成品');
  });

  it('removes the retired task-record switcher from the topbar', () => {
    expect(outputs).not.toContain('name="delivery-view"');
    expect(outputs).not.toContain('value="tasks"');
    expect(outputs).toContain('清理无效记录');
  });

  it('gives finished files the whole page at both the current and legacy query', () => {
    expect(outputs).not.toContain(`flex-basis:${String(PANEL_WIDTH_PX['--w-split'])}px`);
    expect(outputs).not.toContain('data-split-aside');
    expect(tasks).not.toContain('data-split-aside');
    expect(tasks).toContain('成品文件');
  });

  it('invents no data while the service has not answered', () => {
    for (const html of [outputs, tasks]) {
      expect(html).not.toContain('role="progressbar"');
      expect(html).not.toContain('%<');
      expect(html).not.toContain('Aurora');
    }
  });

  it('keeps every scroll inside the page body, never on the document', () => {
    // `Page scroll={false}`: the split columns own their own overflow, which is
    // §10.3's density rule (「横向滚动必须发生在容器内部」).
    expect(outputs).toContain('data-page-body="true" class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"');
  });
});

describe('/delivery/task/:taskId', () => {
  const html = at('/delivery/task/:taskId', '/delivery/task/recording%3Ajob-1', <TaskDetailPage />);

  it('shows the id it was given', () => {
    expect(html).toContain('recording:job-1');
  });

  it('does not duplicate shell breadcrumb navigation in the toolbar', () => {
    expect(html).not.toContain('‹ 后台任务');
  });

  it('answers an address that is not a locator without asking the service', () => {
    const bad = at('/delivery/task/:taskId', '/delivery/task/t-42', <TaskDetailPage />);
    expect(bad).toContain('找不到这条任务');
  });
});

describe('/', () => {
  const html = at('/', '/', <HomePage />);

  it('is a Page whose main action stays out of the overflow menu', () => {
    expect(html).toContain('data-page=');
    expect(html).toContain('工作台');
    expect(html).toContain('data-toolbar-primary');
  });

  it('draws every block, with no phase placeholder left', () => {
    /* All five landed by phase 3g. With no service these render their own
       empty or loading state, which is why the headings are what is asserted
       rather than any row. */
    for (const heading of ['需要我处理', '继续', '新建']) {
      expect(html).toContain(heading);
    }
    expect(html).not.toContain('这一块在阶段');
  });

  it('removes the recent-output rail in favour of the three-section flow', () => {
    expect(html).not.toContain(`flex-basis:${String(PANEL_WIDTH_PX['--w-inspector-wide'])}px`);
    expect(html).toContain('data-home-layout="three-sections"');
  });

  it('invents no data', () => {
    expect(html).not.toContain('role="progressbar"');
    expect(html).not.toContain('Aurora');
  });
});

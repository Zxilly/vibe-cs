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
    expect(outputs).toContain('交付');
  });

  it('switches views with a Seg, the control the artboard draws in the topbar', () => {
    expect(outputs).toContain('role="radiogroup"');
    expect(outputs).toContain('value="outputs"');
    expect(outputs).toContain('value="tasks"');
    // `--h-ctl-md` is the artboard's 34px topbar control.
    expect(outputs).toContain('h-[var(--h-ctl-md)]');
  });

  it('keeps 任务记录 beside 输出 at full width, in the one 520px column §3.5 has', () => {
    expect(outputs).toContain(`flex-basis:${String(PANEL_WIDTH_PX['--w-split'])}px`);
    // …and gives the records the whole page when the address asks for them.
    expect(tasks).not.toContain('data-split-aside');
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

  it('keeps the query on the way back, or it would land on 输出', () => {
    expect(html).toContain('href="/delivery?view=tasks"');
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
    expect(html).toContain('今日工作');
    expect(html).toContain('data-toolbar-primary');
  });

  it('draws every block, with no phase placeholder left', () => {
    /* All five landed by phase 3g. With no service these render their own
       empty or loading state, which is why the headings are what is asserted
       rather than any row. */
    for (const heading of ['待确认的方案', '最近比赛', '进行中的工程']) {
      expect(html).toContain(heading);
    }
    expect(html).not.toContain('这一块在阶段');
  });

  it('puts 最近输出 in the 440px column the artboard draws', () => {
    expect(html).toContain(`flex-basis:${String(PANEL_WIDTH_PX['--w-inspector-wide'])}px`);
  });

  it('invents no data', () => {
    expect(html).not.toContain('role="progressbar"');
    expect(html).not.toContain('Aurora');
  });
});

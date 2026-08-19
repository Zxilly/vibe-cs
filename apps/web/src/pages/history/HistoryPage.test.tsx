/*
 * `markup` project — the /history frame.
 *
 * Rendered with no client and no cache, which is the first paint every user
 * gets: the read is pending, so what must be on screen is the frame, the
 * skeleton, and a 同步最近比赛 that is disabled with a reason because the health
 * probe has not answered either. Nothing here may be a count of rows that have
 * not arrived.
 *
 * The wired behaviour — rows, downloading, cancelling — is
 * `historyPage.interaction.test.tsx`.
 */

import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { HistoryWorkspace } from '../HistoryPage';

const html = renderMarkup(
  <MemoryRouter initialEntries={['/history']}>
    <HistoryWorkspace />
  </MemoryRouter>,
);

describe('the page frame', () => {
  it('is a Page with a Toolbar carrying the §7 title', () => {
    expect(html).toContain('data-page=');
    expect(html).toContain('data-page-toolbar');
    expect(html).toContain('比赛历史');
  });

  it('carries the artboard s count strip and its platform note', () => {
    expect(html).toContain('全部 0');
    // Page-scoped counts say so: the service pages the list (§10.3).
    expect(html).toContain('本页未下载 0');
    expect(html).toContain('本页已入库 0');
    expect(html).toContain('Valve 官方链路');
  });

  it('offers 同步最近比赛 and the Steam settings link', () => {
    expect(html).toContain('同步最近比赛');
    expect(html).toContain('href="/settings?section=app"');
  });
});

describe('the first paint', () => {
  it('shows a skeleton rather than an empty account', () => {
    expect(html).toContain('正在读取比赛历史');
    expect(html).not.toContain('还没有可显示的对局');
  });

  it('blocks the writes while the service has not answered, and says why', () => {
    expect(html).toContain('正在连接本地服务，稍后即可使用');
    expect(html).toContain('需要服务');
    expect(html).toContain('disabled=""');
  });

  it('prints the corpus total in the footer, so nothing is silently truncated', () => {
    expect(html).toContain('共 0 场对局');
  });

  it('says nothing about a last sync it has not read', () => {
    expect(html).not.toContain('上次同步');
  });
});

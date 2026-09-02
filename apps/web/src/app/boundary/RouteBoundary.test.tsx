import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import {
  NotFound,
  RouteBoundary,
  RouteErrorState,
  RouteLoading,
  ROUTE_STATE_MIN_HEIGHT_CLASS,
} from './RouteBoundary';

describe('RouteLoading — 加载中 · 表格骨架', () => {
  const html = renderMarkup(<RouteLoading />);

  it('announces itself as busy without claiming a percentage', () => {
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    // 「不显示虚构百分比」: no progress semantics at all. The `%` values in the
    // markup are the bar widths of the artboard's skeleton, not a completion
    // figure — none of them reaches the reader as text or as an aria value.
    expect(html).not.toContain('role="progressbar"');
    expect(html).not.toContain('aria-valuenow');
  });

  it('gives the stage name, which is all there is to give', () => {
    expect(html).toContain('正在打开这个页面');
    expect(renderMarkup(<RouteLoading stage="正在解析回合" />)).toContain('正在解析回合');
  });

  it('holds the artboard height', () => {
    expect(html).toContain(ROUTE_STATE_MIN_HEIGHT_CLASS);
    expect(html).toContain('data-skeleton-layout="panel"');
  });

  it('keeps the page and top-bar geometry while a lazy route loads', () => {
    expect(html).toContain('data-page');
    expect(html).toContain('data-page-toolbar');
    expect(html).toContain('data-toolbar-height="topbar"');
    expect(html).toContain('data-page-body');
  });
});

describe('RouteErrorState — 这个页面没能打开', () => {
  it('renders the artboard copy verbatim', () => {
    const html = renderMarkup(<RouteErrorState />);
    expect(html).toContain('这个页面没能打开');
    expect(html).toContain('其他页面仍可使用。返回工作台，或导出这次错误的诊断信息。');
    expect(html).toContain('返回工作台');
  });

  it('is toned as a failure — fail border and fail heading', () => {
    const html = renderMarkup(<RouteErrorState />);
    expect(html).toContain('data-tone="error"');
    expect(html).toContain('data-route-failed');
    expect(html).toContain('border-fail-border');
    expect(html).toContain('text-fail-text');
  });

  it('offers 重试 only when retrying is possible', () => {
    expect(renderMarkup(<RouteErrorState />)).not.toContain('重试');
    expect(renderMarkup(<RouteErrorState onRetry={() => {}} />)).toContain('重试');
  });

  it('offers 导出诊断 only when the shell can export one', () => {
    expect(renderMarkup(<RouteErrorState />)).not.toContain('导出诊断');
    expect(renderMarkup(<RouteErrorState onExportDiagnostics={() => {}} />)).toContain('导出诊断');
  });

  it('keeps the raw error out of the page', () => {
    const html = renderMarkup(<RouteErrorState error={new Error('ENOENT: no such file')} />);
    expect(html).not.toContain('ENOENT');
  });

  it('holds the artboard height', () => {
    expect(renderMarkup(<RouteErrorState />)).toContain(ROUTE_STATE_MIN_HEIGHT_CLASS);
  });
});

describe('NotFound', () => {
  const html = renderMarkup(<NotFound />);

  it('reads as an absence rather than a malfunction', () => {
    expect(html).toContain('找不到这个页面');
    expect(html).toContain('这个地址不存在。其余功能不受影响。');
    // The empty tone, not the failure card: the reference draws no 404 state,
    // and a missing route is not a broken one.
    expect(html).toContain('data-tone="empty"');
    expect(html).not.toContain('border-fail-border');
  });

  it('carries the one recovery action every placeholder must have', () => {
    expect(html).toContain('返回工作台');
  });
});

describe('RouteBoundary', () => {
  it('renders the route when nothing throws and nothing suspends', () => {
    const html = renderMarkup(
      <RouteBoundary>
        <p>比赛工作区</p>
      </RouteBoundary>,
    );
    expect(html).toContain('比赛工作区');
    expect(html).not.toContain('这个页面没能打开');
  });
});

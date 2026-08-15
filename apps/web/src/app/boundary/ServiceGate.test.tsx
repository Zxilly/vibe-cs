import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import {
  ServiceGate,
  ServiceOfflineBanner,
  ServiceRequiredHint,
  ServiceStatusMarker,
  SERVICE_REQUIRED_ROW_CLASS,
} from './ServiceGate';
import type { ApiHealth } from '../../shared/desktop/dto';

/** Never settles: a static render only ever observes the first probe anyway. */
function pendingProbe(): Promise<ApiHealth> {
  return new Promise<ApiHealth>(() => {});
}

describe('ServiceStatusMarker — 顶栏状态点', () => {
  it('names the state in words, not only in colour', () => {
    expect(renderMarkup(<ServiceStatusMarker status="online" />)).toContain('本地服务在线');
    expect(renderMarkup(<ServiceStatusMarker status="offline" />)).toContain('本地服务未连接');
    expect(renderMarkup(<ServiceStatusMarker status="checking" />)).toContain('正在连接本地服务');
  });

  it('goes from a filled ok dot to a hollow fail dot — 从绿变为空心砖红', () => {
    const online = renderMarkup(<ServiceStatusMarker status="online" />);
    expect(online).toContain('data-status="ok"');
    expect(online).toContain('data-shape="filled"');

    const offline = renderMarkup(<ServiceStatusMarker status="offline" />);
    expect(offline).toContain('data-status="fail"');
    expect(offline).toContain('data-shape="hollow"');
  });

  it('carries the state as data and as a live region', () => {
    const html = renderMarkup(<ServiceStatusMarker status="offline" />);
    expect(html).toContain('data-service-status="offline"');
    expect(html).toContain('role="status"');
  });

  it('paints the offline text with the fail token, never a literal', () => {
    expect(renderMarkup(<ServiceStatusMarker status="offline" />)).toContain('text-fail-text');
  });
});

describe('ServiceOfflineBanner — 全局降级横幅', () => {
  const banner = renderMarkup(<ServiceOfflineBanner onReconnect={() => {}} />);

  it('states what stopped working and what did not', () => {
    expect(banner).toContain('本地服务未连接，分析、录制和导出暂时无法开始');
    expect(banner).toContain('已导入的比赛和已生成的视频仍可浏览');
    expect(banner).toContain('正在进行的任务会在服务恢复后自动接续状态');
  });

  it('is a danger Notice, so it is persistent and carries one recovery action', () => {
    expect(banner).toContain('data-tone="danger"');
    expect(banner).toContain('role="alert"');
    expect(banner).toContain('重新连接');
  });

  it('appends the probe failure when there is one', () => {
    const html = renderMarkup(
      <ServiceOfflineBanner onReconnect={() => {}} detail="连接被拒绝 (10061)" />,
    );
    expect(html).toContain('连接被拒绝 (10061)');
  });

  it('disables 重新连接 while a probe is already in flight', () => {
    const html = renderMarkup(<ServiceOfflineBanner onReconnect={() => {}} reconnecting />);
    expect(html).toContain('正在重连');
    expect(html).toContain('disabled');
  });
});

describe('ServiceRequiredHint — 行内「需要服务」', () => {
  it('renders the artboard copy', () => {
    expect(renderMarkup(<ServiceRequiredHint />)).toContain('需要服务');
  });

  it('exports the row dimming as a class rather than as a per-page decision', () => {
    expect(SERVICE_REQUIRED_ROW_CLASS).toBe('opacity-50');
  });
});

describe('ServiceGate', () => {
  it('renders its children and nothing of its own — the shell composes the chrome', () => {
    const html = renderMarkup(
      <ServiceGate probe={pendingProbe} poll={false}>
        <p>资料库</p>
      </ServiceGate>,
    );
    expect(html).toBe('<p>资料库</p>');
  });
});

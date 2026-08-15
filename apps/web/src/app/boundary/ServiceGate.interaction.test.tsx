import { Trans } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Button } from '../../design/primitives';
import { renderInteractive } from '../../test/render';
import type { ApiHealth } from '../../shared/desktop/dto';
import {
  ServiceGate,
  ServiceOfflineNotice,
  ServiceStatusMarker,
  useService,
  useServiceAction,
} from './ServiceGate';

const HEALTH: ApiHealth = { status: 'ok', version: '0.1.0', started_at: '2026-08-15T09:00:00Z' };

/**
 * A probe the test drives. `up` flips what the next call does, which is the
 * whole scenario the artboard describes: the service goes away, the shell
 * degrades, the service comes back, the shell recovers without a reload.
 */
function controllableProbe() {
  const state = { up: false, calls: 0 };
  const probe = (): Promise<ApiHealth> => {
    state.calls += 1;
    return state.up ? Promise.resolve(HEALTH) : Promise.reject(new Error('本地服务未启动'));
  };
  return { state, probe };
}

/** An action that needs the service — the artboard's 「导入 Demo · 需要服务」. */
function ImportAction() {
  const service = useServiceAction();
  return (
    <Button {...service.buttonProps}>
      <Trans>导入 Demo</Trans>
      {service.suffix}
    </Button>
  );
}

/**
 * The gate-connected marker. `AppShell` does exactly this — `useService()` once
 * for the title bar, status passed down — so the wiring is asserted here rather
 * than shipped as a component nothing but this file would render.
 */
function GateStatus() {
  return <ServiceStatusMarker status={useService().status} />;
}

/** Read-only content: 「只读内容照常可用」 — never disabled, never hidden. */
function DemoList() {
  return <p>Aurora vs Meridian</p>;
}

function Shell({ probe }: { probe: () => Promise<ApiHealth> }) {
  return (
    <ServiceGate probe={probe} poll={false}>
      <GateStatus />
      <ServiceOfflineNotice />
      <DemoList />
      <ImportAction />
    </ServiceGate>
  );
}

describe('ServiceGate — 离线降级', () => {
  it('shows the banner, flips the dot and disables the action once the probe fails', async () => {
    const { probe } = controllableProbe();
    const { getByRole, getByText, findByRole } = renderInteractive(<Shell probe={probe} />);

    const banner = await findByRole('alert');
    expect(banner.textContent).toContain('本地服务未连接，分析、录制和导出暂时无法开始');
    expect(banner.textContent).toContain('已导入的比赛和已生成的视频仍可浏览');
    // The probe's own message rides along as the detail line.
    expect(banner.textContent).toContain('本地服务未启动');

    expect(getByRole('status').getAttribute('data-service-status')).toBe('offline');

    const action = getByRole('button', { name: /导入 Demo/u });
    expect(action.hasAttribute('disabled')).toBe(true);
    // 「不隐藏、不静默失败」: the button is still there, and it says why.
    expect(action.textContent).toContain('· 需要服务');
    expect(action.getAttribute('title')).toBe('本地服务未连接，恢复后无需刷新页面即可继续');
    expect(action.getAttribute('aria-describedby')).not.toBeNull();

    // 「只读内容照常可用」
    expect(getByText('Aurora vs Meridian')).toBeTruthy();
  });

  it('blocks the action before the first probe answers, with its own reason', async () => {
    const { getByRole } = renderInteractive(
      <Shell probe={() => new Promise<ApiHealth>(() => {})} />,
    );

    await waitFor(() => {
      expect(getByRole('status').getAttribute('data-service-status')).toBe('checking');
    });

    const action = getByRole('button', { name: /导入 Demo/u });
    expect(action.hasAttribute('disabled')).toBe(true);
    expect(action.getAttribute('title')).toBe('正在连接本地服务，稍后即可使用');
    // 「checking」 shows no banner: a flash on every cold start trains the user
    // to ignore it.
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('recovers on 重新连接 — banner collapses, action returns, no reload', async () => {
    const { state, probe } = controllableProbe();
    const { getByRole, findByRole, queryByRole } = renderInteractive(<Shell probe={probe} />);

    await findByRole('alert');

    state.up = true;
    fireEvent.click(getByRole('button', { name: /重新连接/u }));

    await waitFor(() => {
      expect(queryByRole('alert')).toBeNull();
    });

    expect(getByRole('status').getAttribute('data-service-status')).toBe('online');
    expect(getByRole('status').textContent).toContain('本地服务在线');

    const action = getByRole('button', { name: '导入 Demo' });
    expect(action.hasAttribute('disabled')).toBe(false);
    expect(action.getAttribute('title')).toBeNull();
  });

  it('refetches everything else after recovery, and not the probe itself', async () => {
    const { state, probe } = controllableProbe();
    const demoFetches = { count: 0 };

    function Demos() {
      const query = useQuery({
        queryKey: ['demos'],
        queryFn: () => {
          demoFetches.count += 1;
          return Promise.resolve(demoFetches.count);
        },
      });
      return <p>demos:{query.data ?? '-'}</p>;
    }

    const { getByRole, getByText, findByRole } = renderInteractive(
      <ServiceGate probe={probe} poll={false}>
        <ServiceOfflineNotice />
        <Demos />
      </ServiceGate>,
    );

    await findByRole('alert');
    await waitFor(() => {
      expect(getByText('demos:1')).toBeTruthy();
    });
    const probeCallsWhileDown = state.calls;

    state.up = true;
    fireEvent.click(getByRole('button', { name: /重新连接/u }));

    // 「重连成功后……被禁用的动作恢复，不需要刷新页面」: the stale cache is
    // refreshed by the gate, not by the user navigating.
    await waitFor(() => {
      expect(getByText('demos:2')).toBeTruthy();
    });

    // One extra probe — the manual reconnect. The recovery invalidation must
    // not re-enter the health query, or it would loop.
    expect(state.calls).toBe(probeCallsWhileDown + 1);
  });

  it('does not invalidate on a cold start that succeeds straight away', async () => {
    const demoFetches = { count: 0 };

    function Demos() {
      const query = useQuery({
        queryKey: ['demos'],
        queryFn: () => {
          demoFetches.count += 1;
          return Promise.resolve(demoFetches.count);
        },
      });
      return <p>demos:{query.data ?? '-'}</p>;
    }

    const { getByRole, getByText } = renderInteractive(
      <ServiceGate probe={() => Promise.resolve(HEALTH)} poll={false}>
        <GateStatus />
        <Demos />
      </ServiceGate>,
    );

    await waitFor(() => {
      expect(getByRole('status').getAttribute('data-service-status')).toBe('online');
    });
    await waitFor(() => {
      expect(getByText('demos:1')).toBeTruthy();
    });

    // checking → online is not a recovery; refetching here would double every
    // query on every launch.
    expect(demoFetches.count).toBe(1);
  });
});

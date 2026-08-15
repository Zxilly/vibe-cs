/*
 * `interaction` project — 设置 · AI 与 Agent against a stubbed bridge.
 *
 * The three load-bearing assertions:
 *
 *   · 「录制前始终由你确认」 cannot be turned off, and says why (§4.5.3 ①);
 *   · changing the retention *policy* writes the policy and **does not sweep** —
 *     an irreversible delete is never a side effect of a preference (§10.1
 *     gap 2, decided in `AiAgentSection`'s header);
 *   · both destructive actions take a second confirmation, and the copy in it
 *     names what survives.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type {
  AgentSessionStorageStats,
  AgentWorkspaceSettings,
  AppConfig,
} from '../../shared/desktop/dto';
import { HEALTHY, renderPage } from '../delivery/test/renderPage';
import { AiAgentSection } from './AiAgentSection';

const SETTINGS: AgentWorkspaceSettings = {
  session_retention: { mode: 'recent_count', count: 50 },
  take_limit: 5,
};

const STORAGE: AgentSessionStorageStats = {
  session_count: 14,
  entry_count: 186,
  object_ref_count: 21,
  plan_count: 9,
  plan_origin_count: 17,
  conversation_bytes: 38_000_000,
  plan_bytes: 4_200_000,
  oldest_session_at: '2026-07-02T09:02:00.000Z',
  newest_session_at: '2026-08-15T09:47:00.000Z',
};

const CONFIG = {
  llm: { provider: 'OpenAI 兼容', model: 'gpt-4.1-mini', base_url: '', api_key: '', prompt: '' },
  llm_has_api_key: true,
} as unknown as AppConfig;

interface Harness {
  readonly written: AgentWorkspaceSettings[];
  readonly swept: number[];
  readonly cleared: number[];
  readonly exported: number[];
  readonly reached: string[];
  readonly stub: Record<string, unknown>;
}

function renderSection(overrides: Partial<Record<string, unknown>> = {}): Harness {
  const written: AgentWorkspaceSettings[] = [];
  const swept: number[] = [];
  const cleared: number[] = [];
  const exported: number[] = [];
  const reached: string[] = [];

  const stub: Record<string, unknown> = {
    getConfig: () => Promise.resolve(CONFIG),
    getAgentWorkspaceSettings: () => Promise.resolve(SETTINGS),
    getAgentSessionStorage: () => Promise.resolve(STORAGE),
    updateAgentWorkspaceSettings: (settings: AgentWorkspaceSettings) => {
      written.push(settings);
      return Promise.resolve(settings);
    },
    applyAgentSessionRetention: () => {
      swept.push(1);
      return Promise.resolve({ removed_sessions: 3 });
    },
    clearAgentSessions: () => {
      cleared.push(1);
      return Promise.resolve({ removed_sessions: 14 });
    },
    exportAgentSessions: () => {
      exported.push(1);
      return Promise.resolve({ exported_at: '2026-08-15T09:41:00.000Z', settings: SETTINGS, sessions: [] });
    },
    ...overrides,
  };

  const client = new Proxy(stub, {
    get(target, property, receiver) {
      if (typeof property === 'string') reached.push(property);
      return Reflect.get(target, property, receiver) as unknown;
    },
  });

  /* `HEALTHY` seeds the entry `app/boundary/ServiceGate` owns. Without it every
     service-backed action is disabled 「正在连接本地服务」 — which is a real
     state, and the reason the harness makes seeding explicit. */
  renderPage({ element: <AiAgentSection />, client, health: HEALTHY });

  return { written, swept, cleared, exported, reached, stub };
}

/** Waits until the stored settings have arrived, because the retention control
 *  and the take slider do not exist before they do. */
async function ready(): Promise<void> {
  await screen.findByRole('radiogroup', { name: '会话保留多久' });
}

describe('§4.5.3 rule ①', () => {
  it('draws 录制前始终由你确认 on, refuses the click, and says why', async () => {
    renderSection();
    const toggle = await screen.findByRole('switch', { name: '录制前始终由你确认' });

    expect(toggle.getAttribute('aria-checked')).toBe('true');
    /* `locked`, not `disabled`: the design system's own treatment for 「不可关
       闭」 — announced as disabled and inert, rather than greyed out as though a
       setting had failed to load. */
    expect(toggle.getAttribute('aria-disabled')).toBe('true');
    expect(toggle.getAttribute('data-locked')).toBe('true');

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    const reason = document.getElementById(toggle.getAttribute('aria-describedby') ?? '');
    expect(reason?.textContent).toContain('不可关闭');
    expect(reason?.textContent).toContain('必须有一次人工确认');
  });

  it('has no field behind it: nothing is written when the panel loads', async () => {
    const { written } = renderSection();
    await ready();
    expect(written).toEqual([]);
  });
});

describe('保留多久', () => {
  it('shows the stored policy, not the first preset', async () => {
    renderSection();
    await ready();
    const chosen = screen.getByRole('radio', { name: '最近 50 条' }) as HTMLInputElement;
    expect(chosen.checked).toBe(true);
  });

  it('adds the stored policy as its own option when it is none of the four', async () => {
    renderSection({
      getAgentWorkspaceSettings: () =>
        Promise.resolve({ session_retention: { mode: 'recent_count', count: 20 }, take_limit: 5 }),
    });
    await ready();
    const chosen = (await screen.findByRole('radio', { name: '最近 20 条' })) as HTMLInputElement;
    expect(chosen.checked).toBe(true);
    // …and the four presets are still offered beside it.
    expect(screen.getByRole('radio', { name: '最近 50 条' })).toBeTruthy();
  });

  it('writes the whole settings document, take limit included', async () => {
    const { written } = renderSection();
    await ready();

    fireEvent.click(screen.getByRole('radio', { name: '30 天' }));

    await waitFor(() => {
      expect(written).toEqual([
        { session_retention: { mode: 'max_age_days', days: 30 }, take_limit: 5 },
      ]);
    });
  });

  it('does NOT sweep: changing a preference must not delete anything', async () => {
    const { swept, reached } = renderSection();
    await ready();

    fireEvent.click(screen.getByRole('radio', { name: '不保留' }));

    await waitFor(() => {
      expect(reached).toContain('updateAgentWorkspaceSettings');
    });
    expect(swept).toEqual([]);
    expect(reached).not.toContain('applyAgentSessionRetention');
  });

  it('sweeps only from 立即应用, and only after a confirmation', async () => {
    const { swept } = renderSection();
    await ready();

    fireEvent.click(screen.getByRole('button', { name: /立即应用/u }));
    expect(swept).toEqual([]);
    expect(screen.getByText('现在按保留策略清理会话？')).toBeTruthy();

    fireEvent.click(document.querySelector('[data-dialog-action="confirm"]') as HTMLElement);

    await waitFor(() => {
      expect(swept).toEqual([1]);
    });
    expect(await screen.findByText(/已删除 3 条会话/u)).toBeTruthy();
  });
});

describe('take 上限', () => {
  it('reads the stored limit and writes the one the user let go of', async () => {
    const { written } = renderSection();
    await ready();

    const slider = screen.getByRole('slider', { name: '每条会话保留的 take 上限' });
    expect((slider as HTMLInputElement).value).toBe('5');

    fireEvent.change(slider, { target: { value: '8' } });
    fireEvent.blur(slider);

    await waitFor(() => {
      expect(written).toEqual([
        { session_retention: { mode: 'recent_count', count: 50 }, take_limit: 8 },
      ]);
    });
  });
});

describe('占用 · 导出 · 清空', () => {
  it('prints what a clear frees and what it does not', async () => {
    renderSection();
    expect(await screen.findByText(/当前占用 38 MB/u)).toBeTruthy();
    expect(screen.getByText(/14 条会话/u)).toBeTruthy();
    expect(screen.getByText(/方案另占 4\.2 MB/u)).toBeTruthy();
  });

  it('takes a second confirmation to clear, and names what survives', async () => {
    const { cleared } = renderSection();
    await ready();

    fireEvent.click(screen.getByRole('button', { name: /清空会话/u }));
    expect(cleared).toEqual([]);
    expect(screen.getByText('清空全部会话？')).toBeTruthy();
    expect(screen.getByText(/方案、录制任务和已生成的视频不受影响/u)).toBeTruthy();

    fireEvent.click(document.querySelector('[data-dialog-action="confirm"]') as HTMLElement);

    await waitFor(() => {
      expect(cleared).toEqual([1]);
    });
    expect(await screen.findByText(/已删除 14 条会话/u)).toBeTruthy();
  });

  it('exports without a confirmation — it destroys nothing — and reports the result', async () => {
    const { exported } = renderSection();
    await ready();

    fireEvent.click(screen.getByRole('button', { name: /导出/u }));

    await waitFor(() => {
      expect(exported).toEqual([1]);
    });
    expect(await screen.findByText(/已导出 0 条会话/u)).toBeTruthy();
  });

  it('renders a failed read in place, with a retry', async () => {
    renderSection({
      getAgentWorkspaceSettings: () => Promise.reject(new Error('本地服务没有响应')),
    });

    expect(await screen.findByText(/读不到 Agent 的会话设置/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });
});

describe('模型', () => {
  it('prints the configured provider and model, and never the key itself', async () => {
    renderSection();
    expect(await screen.findByText('OpenAI 兼容')).toBeTruthy();
    expect(screen.getByText('gpt-4.1-mini')).toBeTruthy();
    expect(screen.getByText('密钥已配置')).toBeTruthy();
  });
});

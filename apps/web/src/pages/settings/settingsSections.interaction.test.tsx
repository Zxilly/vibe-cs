/*
 * Interaction tests for the three sections phase 3g added — 应用, 文件与资料库
 * and 游戏与录制. (「AI 与 Agent」 has its own file from 3e; 「高级与诊断」 is a
 * readout whose one button now does something, so it has a case here too.)
 *
 * What these pin is the part that is easy to get wrong and invisible when it
 * is: **a settings write sends the whole config document.** `updateConfig`
 * replaces it, so a section that built a partial object would silently reset
 * every field it did not know about — including the ones another section owns.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { AppConfig, QuickCheckResponse, StorageStatus } from '../../shared/desktop/dto';
import { HEALTHY, renderPage } from '../delivery/test/renderPage';
import { AdvancedSection } from './AdvancedSection';
import { AppSection } from './AppSection';
import { FilesSection } from './FilesSection';
import { GameSection } from './GameSection';

const CONFIG: AppConfig = {
  locale: 'zh-CN',
  theme: 'light',
  update_manifest_url: '',
  data_dir: 'D:\\CS2',
  demo_watch_paths: ['D:\\CS2\\demos'],
  cs2_path: 'E:\\SteamLibrary\\steamapps\\common\\Counter-Strike Global Offensive',
  steam_path: '',
  steam: {
    steam_id: '',
    web_api_key: '',
    authentication_code: '',
    known_share_code: '',
    maximum_results: 20,
  },
  llm: {
    provider: 'openai', model: 'gpt-4.1-mini', base_url: '', api_key: '', prompt: '',
    parameter_style: 'openai', parameters: {},
  },
  /* The service answers whether a secret is set, never the secret — so these
     four booleans are part of the document a write has to send back. */
  steam_has_web_api_key: false,
  steam_has_authentication_code: false,
  steam_has_share_code: false,
  llm_has_api_key: false,
  clear_llm_api_key: false,
  recording: {
    pre_roll_seconds: 1.5,
    post_roll_seconds: 1,
    resolution: '1920x1080',
    fps: 60,
    show_radar: true,
    show_hud: true,
    voice: 'all_players',
    camera_fov: 90,
    viewmodel_fov: 68,
    flash_alpha: 255,
  },
};

const STORAGE: StorageStatus = {
  data_dir: 'D:\\CS2',
  directory_bytes: 42_000_000_000,
  filesystem_total_bytes: 500_000_000_000,
  filesystem_available_bytes: 218_000_000_000,
  file_count: 1_204,
  directory_count: 18,
  scan_complete: true,
  checked_at: '2026-08-16T09:00:00.000Z',
};

const CHECKS: QuickCheckResponse = {
  checks: [
    { kind: 'game', state: 'ready', label: 'CS2', detail: '版本 1.40.9.6' },
    { kind: 'hlae', state: 'ready', label: 'HLAE', detail: 'C:/hlae/HLAE.exe' },
    { kind: 'encoder', state: 'missing', label: 'Video encoder', detail: '未探测到编码器' },
  ],
  checked_at: '2026-08-16T08:02:00.000Z',
};

interface Harness {
  readonly written: AppConfig[];
}

function render(
  element: React.ReactElement,
  overrides: Record<string, unknown> = {},
  options: { readonly offline?: boolean } = {},
): Harness {
  const written: AppConfig[] = [];
  const client: Record<string, unknown> = {
    getConfig: () => Promise.resolve(CONFIG),
    updateConfig: (config: AppConfig) => {
      written.push(config);
      return Promise.resolve(config);
    },
    storageStatus: () => Promise.resolve(STORAGE),
    quickCheck: () => Promise.resolve(CHECKS),
    getHlaeStatus: () => Promise.resolve({ available: true, messages: [] }),
    runtimeState: () => Promise.resolve({ status: 'ok', version: '0.0.0' }),
    ...overrides,
  };
  renderPage({
    element,
    client,
    ...(options.offline === true ? { health: undefined } : { health: HEALTHY }),
  });
  return { written };
}

async function loaded(label: string): Promise<void> {
  await screen.findByText(label);
}

describe('应用', () => {
  it('writes the whole document when the theme changes', async () => {
    const { written } = render(<AppSection />);
    await loaded('语言');

    fireEvent.click(screen.getByRole('radio', { name: '深色' }));

    await waitFor(() => expect(written).toHaveLength(1));
    // Everything else intact — `updateConfig` replaces the document.
    expect(written[0]).toEqual({ ...CONFIG, theme: 'dark' });
  });

  it('says the change applies at the next start rather than pretending it is live', async () => {
    render(<AppSection />);
    await loaded('语言');
    expect(document.body.textContent).toContain('下次启动应用时生效');
  });

  it('groups the current controls into two bounded settings panels', async () => {
    render(<AppSection />);
    await loaded('语言');

    expect(document.querySelectorAll('[data-settings-block]')).toHaveLength(2);
    expect(document.querySelectorAll('[data-settings-row]')).toHaveLength(3);
  });

  it('refuses a non-HTTPS update source at the field, not at the service', async () => {
    const { written } = render(<AppSection />);
    await loaded('更新源');

    const input = screen.getByLabelText('更新源地址');
    fireEvent.change(input, { target: { value: 'http://example.com/manifest.json' } });
    fireEvent.blur(input);

    expect(document.body.textContent).toContain('只接受 https://');
    expect(written).toHaveLength(0);
  });

  it('accepts an HTTPS one', async () => {
    const { written } = render(<AppSection />);
    await loaded('更新源');

    const input = screen.getByLabelText('更新源地址');
    fireEvent.change(input, { target: { value: 'https://example.com/manifest.json' } });
    fireEvent.blur(input);

    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]?.update_manifest_url).toBe('https://example.com/manifest.json');
  });
});

describe('文件与资料库', () => {
  it('prints usage and free space from the storage read', async () => {
    render(<FilesSection />);
    await waitFor(() => {
      expect(document.querySelector('[data-storage-usage]')).not.toBeNull();
    });
    expect(document.querySelector('[data-storage-usage]')?.textContent).toContain('GB');
  });

  it('says the scan was partial rather than printing a total that is too small', async () => {
    render(<FilesSection />, {
      storageStatus: () => Promise.resolve({ ...STORAGE, scan_complete: false }),
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain('只统计了一部分');
    });
  });

  it('removes a watched folder and keeps the rest of the config', async () => {
    const { written } = render(<FilesSection />);
    await waitFor(() => {
      expect(document.querySelector('[data-watch-path]')).not.toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: '移除' }));

    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]).toEqual({ ...CONFIG, demo_watch_paths: [] });
  });

  it('warns that changing the data directory leaves the old files behind', async () => {
    // The picker needs a desktop shell, which the harness does not provide —
    // so what is asserted is that the row states the consequence, which is the
    // part a user has to read before they press anything.
    render(<FilesSection />);
    await loaded('位置');
    expect(document.body.textContent).toContain('不会被搬走');
  });

  it('saves the complete Steam history connection without resetting other settings', async () => {
    const { written } = render(<FilesSection />);
    const steamId = await screen.findByLabelText(/^Steam ID/u);

    fireEvent.change(steamId, { target: { value: '76561198000000000' } });
    fireEvent.change(screen.getByLabelText(/^Steam Web API 密钥/u), { target: { value: 'a'.repeat(32) } });
    fireEvent.change(screen.getByLabelText(/^Steam 验证码/u), { target: { value: 'ABCD-EFGHI-JKLM' } });
    fireEvent.change(screen.getByLabelText(/^最近分享代码/u), {
      target: { value: 'CSGO-ABCDE-ABCDE-ABCDE-ABCDE-ABCDE' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存 Steam 设置' }));

    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]?.steam.steam_id).toBe('76561198000000000');
    expect(written[0]?.steam.web_api_key).toBe('a'.repeat(32));
    expect(written[0]?.data_dir).toBe(CONFIG.data_dir);
    expect(written[0]?.llm).toEqual(CONFIG.llm);
  });
});

describe('游戏与录制', () => {
  it('writes a voice policy as one value, not two flags', async () => {
    const { written } = render(<GameSection />);
    await loaded('语音');

    fireEvent.click(screen.getByRole('radio', { name: '全部静音' }));

    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]?.recording.voice).toBe('muted');
    // The collapse (§10 note 5): there is no second flag to disagree with it.
    expect(written[0]?.recording).not.toHaveProperty('mute_voice');
  });

  it('toggles HUD without disturbing the radar', async () => {
    const { written } = render(<GameSection />);
    await loaded('HUD');

    fireEvent.click(screen.getByRole('switch', { name: 'HUD' }));

    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]?.recording.show_hud).toBe(false);
    expect(written[0]?.recording.show_radar).toBe(true);
  });

  it('lists the encoder checks and says when they were taken', async () => {
    render(<GameSection />);
    await loaded('成品生成能力');
    await waitFor(() => {
      expect(document.body.textContent).toContain('未探测到编码器');
    });
    expect(document.body.textContent).toContain('未探测到编码器');
    expect(document.body.textContent).toContain('上次检查');
  });

  it('says the encoder block is empty rather than looking clean', async () => {
    // A block with no rows and no sentence reads as "everything is fine".
    render(<GameSection />, {
      quickCheck: () => Promise.resolve({ ...CHECKS, checks: [] }),
    });
    await loaded('成品生成能力');
    await waitFor(() => {
      expect(document.body.textContent).toContain('没有编码器项');
    });
  });

  it('states 「改动只影响之后新建的录制任务」 once, at the top', async () => {
    render(<GameSection />);
    await loaded('游戏');
    expect(document.body.textContent).toContain('改动只影响之后新建的录制任务');
  });

  it('disables the writes with a written reason while the service is down', async () => {
    render(<GameSection />, {}, { offline: true });
    await loaded('语音');

    expect(screen.getByRole('switch', { name: 'HUD' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('radio', { name: '全部静音' }).hasAttribute('disabled')).toBe(true);
    expect(document.querySelector('[data-disabled-reason]')?.textContent).toContain('本地服务');
  });

  it('never writes a partial recording object', async () => {
    // The failure this guards is invisible: a section that spread only its own
    // fields would reset the FOVs and the resolution on every toggle.
    const spy = vi.fn((config: AppConfig) => Promise.resolve(config));
    render(<GameSection />, { updateConfig: spy });
    await loaded('雷达');

    fireEvent.click(screen.getByRole('switch', { name: '雷达' }));

    await waitFor(() => expect(spy).toHaveBeenCalled());
    const sent = spy.mock.calls[0]?.[0] as AppConfig;
    expect(sent.recording.camera_fov).toBe(90);
    expect(sent.recording.resolution).toBe('1920x1080');
    expect(sent.cs2_path).toBe(CONFIG.cs2_path);
  });
});

describe('高级与诊断', () => {
  /* This section reads more of the runtime and HLAE documents than the other
     three do — it *is* the diagnostics readout — so it needs fuller stubs. */
  const DIAGNOSTIC_STUBS = {
    runtimeState: () =>
      Promise.resolve({
        status: 'ok',
        version: '0.4.2',
        started_at: '2026-08-17T01:00:00.000Z',
        runtime_session: 'session-1',
        active_recording_job: null,
        data_dir: 'D:\CS2',
      }),
    getHlaeStatus: () =>
      Promise.resolve({
        available: true,
        executable: 'D:\hlae\HLAE.exe',
        messages: [],
        automatic_launch_enabled: false,
      }),
  };

  it('localizes the known managed-capture safety boundary', async () => {
    render(<AdvancedSection />, {
      ...DIAGNOSTIC_STUBS,
      getHlaeStatus: () => Promise.resolve({
        available: true,
        executable: 'D:\\hlae\\HLAE.exe',
        automatic_launch_enabled: true,
        messages: [
          'Recording jobs launch a fresh managed HLAE and CS2 process for offline Demo playback with -insecure; proposal exports remain process-free',
        ],
      }),
    });

    expect(await screen.findByText(/录制作业会启动新的受管 HLAE/u)).toBeTruthy();
    expect(document.body.textContent).not.toContain('proposal exports remain process-free');
  });

  it('uses title rails for diagnostic readouts', async () => {
    render(<AdvancedSection />, DIAGNOSTIC_STUBS);
    await loaded('运行时');

    expect(document.querySelectorAll('[data-settings-layout="split"]')).toHaveLength(4);
  });

  it('prepares a missing managed capture component and refreshes its status', async () => {
    let prepared = false;
    const prepareManagedHlae = vi.fn(() => {
      prepared = true;
      return Promise.resolve({ available: true, messages: [] });
    });
    render(<AdvancedSection />, {
      ...DIAGNOSTIC_STUBS,
      getHlaeStatus: () => Promise.resolve({
        available: prepared,
        executable: prepared ? String.raw`D:\hlae\HLAE.exe` : null,
        messages: prepared ? [] : ['managed HLAE is missing'],
        automatic_launch_enabled: prepared,
      }),
      prepareManagedHlae,
    });

    fireEvent.click(await screen.findByRole('button', { name: '准备采集组件' }));

    await waitFor(() => expect(prepareManagedHlae).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(document.body.textContent).toContain('自动启动');
      expect(screen.queryByRole('button', { name: '准备采集组件' })).toBeNull();
    });
  });

  it('writes a report and offers to locate it', async () => {
    const exportDiagnostics = vi.fn(() =>
      Promise.resolve({
        path: String.raw`D:\CS2\diagnostics\report-2026-08-17.json`,
        created_at: '2026-08-17T02:00:00.000Z',
        contains_secrets: false,
      }),
    );
    render(<AdvancedSection />, { ...DIAGNOSTIC_STUBS, exportDiagnostics });

    fireEvent.click(await screen.findByRole('button', { name: /^导出$/u }));

    await waitFor(() => expect(exportDiagnostics).toHaveBeenCalledTimes(1));
    // Queried by marker, not by text: `<Trans>` puts the interpolated path in
    // its own node, so the sentence is split across elements.
    const result = await waitFor(() => {
      const node = document.querySelector('[data-diagnostics-result]');
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });
    // The path, because a filename the user never saw is not findable.
    expect(result.textContent).toContain('report-2026-08-17.json');
    expect(result.textContent).toContain('不含任何密钥或媒体内容');
    expect(screen.getByRole('button', { name: /定位文件/u })).not.toBeNull();
  });

  it('says 不含密钥 only when the service said so', async () => {
    const exportDiagnostics = vi.fn(() =>
      Promise.resolve({
        path: String.raw`D:\CS2\diagnostics\report.json`,
        created_at: '2026-08-17T02:00:00.000Z',
        // The page reads the flag rather than assuming it — a report that ever
        // does carry one must not be handed over under a promise that it does not.
        contains_secrets: true,
      }),
    );
    render(<AdvancedSection />, { ...DIAGNOSTIC_STUBS, exportDiagnostics });

    fireEvent.click(await screen.findByRole('button', { name: /^导出$/u }));

    const result = await waitFor(() => {
      const node = document.querySelector('[data-diagnostics-result]');
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });
    expect(result.textContent).toContain('report.json');
    expect(result.textContent).not.toContain('不含任何密钥');
  });

  it('offers a retry when the write fails', async () => {
    const exportDiagnostics = vi.fn(() => Promise.reject(new Error('disk full')));
    render(<AdvancedSection />, { ...DIAGNOSTIC_STUBS, exportDiagnostics });

    fireEvent.click(await screen.findByRole('button', { name: /^导出$/u }));

    await screen.findByRole('button', { name: /重试/u });
    expect(exportDiagnostics).toHaveBeenCalledTimes(1);
  });
});

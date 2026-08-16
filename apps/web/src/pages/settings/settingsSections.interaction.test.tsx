/*
 * Interaction tests for the three sections phase 3g added — 应用, 文件与资料库
 * and 游戏与录制. (「AI 与 Agent」 has its own file from 3e; 「高级与诊断」 is a
 * readout with one button and is covered by the markup suite.)
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
  llm: { provider: 'openai', model: 'gpt-4.1-mini', base_url: '', api_key: '', prompt: '' },
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
    { kind: 'cs2', state: 'ready', label: 'CS2', detail: '版本 1.40.9.6' },
    { kind: 'encoder', state: 'ready', label: 'H.264', detail: '可用' },
    { kind: 'ffmpeg', state: 'missing', label: 'AAC', detail: '未探测到编码器' },
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
    await loaded('视频输出能力');
    await waitFor(() => {
      expect(document.body.textContent).toContain('H.264');
    });
    expect(document.body.textContent).toContain('未探测到编码器');
    expect(document.body.textContent).toContain('上次检查');
  });

  it('says the encoder block is empty rather than looking clean', async () => {
    // A block with no rows and no sentence reads as "everything is fine".
    render(<GameSection />, {
      quickCheck: () => Promise.resolve({ ...CHECKS, checks: [] }),
    });
    await loaded('视频输出能力');
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

/**
 * `interaction` project — configuration reads and the one write in this round.
 *
 * No real IPC (see `demos.interaction.test.tsx`). The reason `config.ts` ships
 * a mutation is asserted here: saving the config document has to refresh the
 * probes derived from it *and* the demo library, or settings reports success
 * while the dependency row keeps showing the stale state.
 */

import { act, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type {
  AgentStatus,
  AppConfig,
  DemoWatchStatus,
  QuickCheckResponse,
  StorageStatus,
} from '../shared/desktop/dto';
import {
  invalidateConfig,
  rejectWatchPath,
  useAgentStatus,
  useAppConfig,
  useQuickCheck,
  useSetDemoWatchPaths,
  useStorageStatus,
  useUpdateAppConfig,
} from './config';
import { useDemoWatchStatus } from './demos';
import { dataErrorMessage } from './errors';
import { countingStub, renderDataHook } from './test/renderDataHook';

const CONFIG: AppConfig = {
  locale: 'zh-CN',
  theme: 'light',
  update_manifest_url: '',
  data_dir: 'C:/vibe-cs',
  demo_watch_paths: ['C:/demos'],
  cs2_path: 'C:/Steam/steamapps/common/cs2',
  steam_path: 'C:/Steam',
  steam: {
    steam_id: '',
    web_api_key: '',
    authentication_code: '',
    known_share_code: '',
    maximum_results: 50,
  },
  steam_has_web_api_key: false,
  steam_has_authentication_code: false,
  steam_has_share_code: false,
  llm: {
    provider: 'openai', model: 'gpt-4o-mini', base_url: '', api_key: '', prompt: '',
    parameter_style: 'openai', parameters: {},
  },
  llm_has_api_key: false,
  clear_llm_api_key: false,
  recording: {
    pre_roll_seconds: 3,
    post_roll_seconds: 2,
    resolution: '1920x1080',
    fps: 60,
    show_radar: true,
    show_hud: true,
    voice: 'all_players',
    camera_fov: 90,
    viewmodel_fov: 68,
    flash_alpha: 0.4,
  },
};

const QUICK_CHECK: QuickCheckResponse = {
  checks: [{ kind: 'game', state: 'ready', label: 'CS2', detail: '已就绪' }],
  checked_at: '2026-08-15T09:00:00Z',
};

const STORAGE: StorageStatus = {
  data_dir: 'C:/vibe-cs',
  directory_bytes: 1_000,
  filesystem_total_bytes: 100_000,
  filesystem_available_bytes: 50_000,
  file_count: 10,
  directory_count: 3,
  scan_complete: true,
  checked_at: '2026-08-15T09:00:00Z',
};

const AGENT_STATUS: AgentStatus = {
  runtimeAvailable: true,
  configured: true,
  provider: 'kimi-code',
  model: 'k3',
  streaming: true,
};

const WATCH: DemoWatchStatus = {
  running: true,
  roots: [{ path: 'C:/demos', state: 'watching', message: null }],
  last_scan_at: '2026-08-15T09:00:00Z',
  last_event_at: null,
  last_error: null,
  imported: 0,
  updated: 0,
  missing: 0,
};

describe('useAppConfig', () => {
  it('reads the config document', async () => {
    const config = countingStub(CONFIG);
    const { result } = renderDataHook(() => useAppConfig(), { client: { getConfig: config.call } });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.data?.data_dir).toBe('C:/vibe-cs');
  });

  it('keeps a failure readable instead of rendering an empty form', async () => {
    const config = countingStub(CONFIG);
    config.fail(new Error('配置文件损坏'));

    const { result } = renderDataHook(() => useAppConfig(), { client: { getConfig: config.call } });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(dataErrorMessage(result.current.error)).toBe('配置文件损坏');
  });
});

describe('useAgentStatus', () => {
  it('reads the effective runtime instead of inferring it from the settings document', async () => {
    const status = countingStub(AGENT_STATUS);
    const { result } = renderDataHook(() => useAgentStatus(), {
      client: { agentStatus: status.call },
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.data).toMatchObject({ configured: true, model: 'k3' });
  });
});

describe('invalidateConfig', () => {
  it('sweeps the document and every probe derived from it', async () => {
    const config = countingStub(CONFIG);
    const quickCheck = countingStub(QUICK_CHECK);
    const storage = countingStub(STORAGE);

    const { result, queryClient } = renderDataHook(
      () => ({
        config: useAppConfig(),
        quickCheck: useQuickCheck(),
        storage: useStorageStatus(),
      }),
      {
        client: {
          getConfig: config.call,
          quickCheck: quickCheck.call,
          storageStatus: storage.call,
        },
      },
    );

    await waitFor(() => {
      expect(result.current.config.isSuccess).toBe(true);
      expect(result.current.quickCheck.isSuccess).toBe(true);
      expect(result.current.storage.isSuccess).toBe(true);
    });

    await act(async () => {
      await invalidateConfig(queryClient);
    });

    await waitFor(() => {
      expect(config.calls()).toBe(2);
      expect(quickCheck.calls()).toBe(2);
      expect(storage.calls()).toBe(2);
    });
  });
});

describe('useUpdateAppConfig', () => {
  it('saves, then refreshes the probes and the demo library', async () => {
    const config = countingStub(CONFIG);
    const quickCheck = countingStub(QUICK_CHECK);
    const watch = countingStub(WATCH);
    const update = countingStub(CONFIG);

    const { result } = renderDataHook(
      () => ({
        config: useAppConfig(),
        quickCheck: useQuickCheck(),
        watch: useDemoWatchStatus(),
        save: useUpdateAppConfig(),
      }),
      {
        client: {
          getConfig: config.call,
          quickCheck: quickCheck.call,
          getDemoWatchStatus: watch.call,
          updateConfig: update.call,
        },
      },
    );

    await waitFor(() => {
      expect(result.current.config.isSuccess).toBe(true);
      expect(result.current.quickCheck.isSuccess).toBe(true);
      expect(result.current.watch.isSuccess).toBe(true);
    });

    await act(async () => {
      await result.current.save.mutateAsync({ ...CONFIG, cs2_path: 'D:/cs2' });
    });

    expect(update.lastArgs()[0]).toMatchObject({ cs2_path: 'D:/cs2' });

    await waitFor(() => {
      expect(config.calls()).toBe(2);
      // The dependency row is derived from the path that just changed.
      expect(quickCheck.calls()).toBe(2);
      // `demo_watch_paths` lives in the same document, so the library has to
      // hear about the save as well.
      expect(watch.calls()).toBe(2);
    });
  });

  it('reports a failed save without invalidating anything', async () => {
    const config = countingStub(CONFIG);
    const update = countingStub(CONFIG);
    update.fail(new Error('写入被拒绝'));

    const { result } = renderDataHook(
      () => ({ config: useAppConfig(), save: useUpdateAppConfig() }),
      { client: { getConfig: config.call, updateConfig: update.call } },
    );

    await waitFor(() => {
      expect(result.current.config.isSuccess).toBe(true);
    });

    await act(async () => {
      await result.current.save.mutateAsync(CONFIG).catch(() => undefined);
    });

    await waitFor(() => {
      expect(result.current.save.isError).toBe(true);
    });
    expect(dataErrorMessage(result.current.save.error)).toBe('写入被拒绝');
    // A rejected write must not pretend the server state moved.
    expect(config.calls()).toBe(1);
  });
});

describe('useSetDemoWatchPaths', () => {
  it('writes the shortened list back and refreshes both the config and the library', async () => {
    const config = countingStub(CONFIG);
    const update = countingStub(CONFIG);
    const watch = countingStub(WATCH);

    const { result } = renderDataHook(
      () => ({
        config: useAppConfig(),
        watch: useDemoWatchStatus(),
        save: useSetDemoWatchPaths(),
      }),
      {
        client: {
          getConfig: config.call,
          updateConfig: update.call,
          getDemoWatchStatus: watch.call,
        },
      },
    );

    await waitFor(() => {
      expect(result.current.config.isSuccess).toBe(true);
      expect(result.current.watch.isSuccess).toBe(true);
    });

    await act(async () => {
      await result.current.save.mutateAsync({ config: CONFIG, paths: ['C:/demos', 'D:/more'] });
    });

    // The whole document goes back, with only `demo_watch_paths` moved — the
    // PUT replaces the config, so a partial body would drop everything else.
    expect(update.lastArgs()[0]).toEqual({ ...CONFIG, demo_watch_paths: ['C:/demos', 'D:/more'] });

    await waitFor(() => {
      expect(config.calls()).toBe(2);
      // 「监听目录」 is read back by the watch status, which lives under the
      // `demos` namespace — the second half of the invalidation.
      expect(watch.calls()).toBe(2);
    });
  });
});

describe('rejectWatchPath', () => {
  it('refuses an empty path', () => {
    expect(rejectWatchPath('', [])).toBe('empty');
    expect(rejectWatchPath('   ', [])).toBe('empty');
  });

  it('refuses a duplicate however it is spelled', () => {
    // Windows paths differ by case and by a trailing separator while naming
    // one folder; two entries for one folder would make 「停止监听」 remove the
    // wrong row.
    expect(rejectWatchPath('D:\\CS2\\demos', ['D:\\CS2\\demos\\'])).toBe('duplicate');
    expect(rejectWatchPath('d:/cs2/demos/', ['D:\\CS2\\demos'])).toBe('duplicate');
  });

  it('accepts a new folder', () => {
    expect(rejectWatchPath('E:\\replays', ['D:\\CS2\\demos'])).toBeNull();
  });
});

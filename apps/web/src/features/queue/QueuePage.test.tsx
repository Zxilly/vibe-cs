import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { QueuePage, QueuePlaybackReadiness, recordingExecutionOutcome } from './QueuePage';
import { queueTestItems } from './queueTestFixtures';

const previewControlUnavailable = {
  executable_available: true,
  executable: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\bin\\win64\\cs2.exe',
  gsi_installed: false,
  gsi_fresh: false,
  gsi_sequence: 0,
  gsi_received_at: null,
  map_name: null,
  map_phase: null,
  player_name: null,
  player_activity: null,
  ready_to_launch: true,
  gsi_ready: false,
  warnings: [],
};

const queueState = vi.hoisted(() => ({
  items: [] as typeof queueTestItems,
  selectedId: null as string | null,
  select: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  clear: vi.fn(),
  move: vi.fn(),
  reorder: vi.fn(),
  toggleAll: vi.fn(),
}));

vi.mock('./queueStore', () => ({
  useQueueStore: (selector: (state: typeof queueState) => unknown) => selector(queueState),
}));

describe('recording queue workspace', () => {
  beforeEach(() => {
    queueState.items = [];
    queueState.selectedId = null;
    vi.clearAllMocks();
  });

  it('does not treat immediate terminal execution responses as active starts', () => {
    expect(recordingExecutionOutcome('failed')).toMatchObject({
      tracksActiveJob: false,
      tone: 'danger',
    });
    expect(recordingExecutionOutcome('cancelled')).toMatchObject({
      tracksActiveJob: false,
      tone: 'warning',
    });
    expect(recordingExecutionOutcome('queued')).toMatchObject({
      tracksActiveJob: true,
      tone: 'info',
    });
  });

  it('turns a truly empty queue into one compact path back to the library', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <QueuePage />
      </MemoryRouter>,
    );

    expect(markup).toContain('href="/library"');
    expect(markup).toContain('queue-empty-workspace');
    expect(markup).not.toContain('queue-stats');
    expect(markup).not.toContain('queue-layout');
    expect(markup).not.toContain('queue-action-dock');
  });

  it('does not surface local playback readiness for an idle empty queue', () => {
    const markup = renderToStaticMarkup(
      <QueuePlaybackReadiness
        itemCount={0}
        playbackActive={false}
        status={previewControlUnavailable}
        error={null}
      />,
    );

    expect(markup).toBe('');
  });

  it('describes an active playback heartbeat as local preview control instead of a recording dependency', () => {
    const markup = renderToStaticMarkup(
      <QueuePlaybackReadiness
        itemCount={0}
        playbackActive
        status={previewControlUnavailable}
        error={null}
      />,
    );

    expect(markup).toContain('本地预览控制');
    expect(markup).toContain('不影响 HLAE 录制');
    expect(markup).not.toContain('请安装');
    expect(markup).not.toContain('自动录制');
  });

  it('keeps the planning workspace and action dock when real queue items exist', () => {
    queueState.items = [...queueTestItems];
    queueState.selectedId = queueTestItems[0]?.id ?? null;

    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <QueuePage />
      </MemoryRouter>,
    );

    expect(markup).toContain('queue-stats');
    expect(markup).toContain('queue-layout');
    expect(markup).toContain('queue-action-dock');
    expect(markup).not.toContain('queue-empty-workspace');
  });

  it('presents the only current native capture path without retired repair UI', () => {
    queueState.items = [...queueTestItems];
    queueState.selectedId = queueTestItems[0]?.id ?? null;

    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <QueuePage />
      </MemoryRouter>,
    );

    expect(markup).toContain('当前成片链路以 1.0× 确定性回放采集画面和游戏音频');
    expect(markup).not.toContain('这个旧队列项包含');
    expect(markup).not.toContain('改为原生默认值');
  });
});

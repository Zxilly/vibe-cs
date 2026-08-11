import { afterEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { DesktopError, commands, desktopMediaUrl, normalizeDemo, normalizeSide, request } from './client';
import type { DemoRecord } from './dto';

describe('desktop command client', () => {
  afterEach(() => {
    invokeMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('uses Tauri invoke instead of an HTTP origin', async () => {
    invokeMock.mockResolvedValue({ status: 'ok', version: '0.1.0' });

    await expect(request('/health', { method: 'POST', body: { probe: true } })).resolves.toEqual({
      status: 'ok',
      version: '0.1.0',
    });
    expect(invokeMock).toHaveBeenCalledWith('desktop_call', {
      call: {
        method: 'post',
        path: '/health',
        body: { probe: true },
      },
    });
  });

  it('preserves structured desktop command failures', async () => {
    invokeMock.mockRejectedValue({
      status: 409,
      code: 'RUNTIME_BUSY',
      message: '录制服务正忙',
    });

    await expect(request('/recording/queue')).rejects.toMatchObject({
      name: 'DesktopError',
      status: 409,
      code: 'RUNTIME_BUSY',
      message: '录制服务正忙',
    });
  });

  it('cancels stale UI work without falling back to fetch', async () => {
    invokeMock.mockReturnValue(new Promise(() => undefined));
    const controller = new AbortController();
    const pending = request('/health', { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
  });

  it('routes media only through the managed desktop protocol', () => {
    expect(desktopMediaUrl('/api/v1/recorded-clips/clip-id/stream')).toMatch(
      /^(?:vibe-cs-media:\/\/localhost|http:\/\/vibe-cs-media\.localhost)\/recorded-clips\/clip-id\/stream$/,
    );
    expect(() => desktopMediaUrl('https://evil.example/video.mp4')).toThrow(DesktopError);
  });

  it('keeps editor audio separation as a revision-safe native command', async () => {
    invokeMock.mockResolvedValue({ project: { revision: 8 }, asset: { id: 'audio-1' } });

    await commands.separateEditorAudio('project 1', 'clip/1', 7);

    expect(invokeMock).toHaveBeenCalledWith('desktop_call', {
      call: {
        method: 'post',
        path: '/editor/projects/project%201/clips/clip%2F1/separate-audio',
        body: { expected_revision: 7, mute_source: true },
      },
    });
  });

  it('keeps replay metadata while normalizing player sides', async () => {
    invokeMock.mockResolvedValue({
      frames: [{
        tick: 64,
        players: [{ id: '1', name: 'Player', team: 'CT', position: [1, 2, 3], yaw: 0, health: 100, armor: 0, alive: true, weapon: 'm4a1' }],
        projectiles: [],
        bomb: null,
      }],
      cache: { state: 'hit', version: 1, key: 'abc', bytes: 512, generated_at: '2026-08-10T00:00:00Z', repaired: false, reason: null },
    });

    const replay = await commands.getReplay('demo/id');

    expect(replay.frames[0]?.players[0]?.team).toBe('B');
    expect(replay.cache).toMatchObject({ state: 'hit', bytes: 512 });
  });

  it('encodes bounded playback commands and explicit stop', async () => {
    invokeMock.mockResolvedValue({});

    await commands.preflightDemo('demo/id', { start_tick: 4_096, player: 'Player One', timescale: 0.5 });
    await commands.stopPlayback();

    expect(invokeMock.mock.calls[0]).toEqual(['desktop_call', {
      call: {
        method: 'post',
        path: '/demos/demo%2Fid/playback/preflight',
        body: { start_tick: 4_096, player: 'Player One', timescale: 0.5 },
      },
    }]);
    expect(invokeMock.mock.calls[1]).toEqual(['desktop_call', {
      call: { method: 'post', path: '/playback/stop', body: {} },
    }]);
  });
});

describe('wire normalization', () => {
  it('normalizes persisted demos without leaking storage names into views', () => {
    const record: DemoRecord = {
      id: '0c34a82a-a176-4c88-9514-940245912866',
      path: 'D:\\Demos\\match.dem',
      file_name: 'match.dem',
      display_name: '周末训练',
      source: 'watch',
      status: 'analyzing',
      map_name: 'de_mirage',
      match_date: '2026-08-09T12:00:00Z',
      duration_seconds: 1980,
      total_rounds: 24,
      team_a_name: 'A',
      team_b_name: 'B',
      team_a_score: 13,
      team_b_score: 9,
      remark: '',
      content_sha256: null,
      file_size: 42,
      created_at: '2026-08-09T12:10:00Z',
      updated_at: '2026-08-09T12:11:00Z',
    };

    expect(normalizeDemo(record)).toMatchObject({
      filename: 'match.dem',
      score_team_a: 13,
      score_team_b: 9,
      status: 'parsing',
    });
  });

  it.each([
    ['A', 'A'], ['T', 'A'], ['TERRORIST', 'A'], ['2', 'A'],
    ['B', 'B'], ['CT', 'B'], ['COUNTER-TERRORIST', 'B'], ['3', 'B'],
  ] as const)('maps wire side %s to display team %s', (wire, expected) => {
    expect(normalizeSide(wire)).toBe(expected);
  });

  it('does not guess an unknown team side', () => {
    expect(normalizeSide('spectator')).toBeNull();
  });
});

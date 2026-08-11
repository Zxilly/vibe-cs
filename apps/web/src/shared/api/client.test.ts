import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, api, apiMediaUrl, normalizeDemo, normalizeSide, request, resolveApiBase } from './client';
import type { DemoRecord } from './dto';

describe('API client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends JSON requests under the versioned API namespace and parses a typed response', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ status: 'ok', version: '0.1.0' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await request<{ status: string; version: string }>('/health', {
      method: 'POST',
      body: { probe: true },
    });

    expect(result).toEqual({ status: 'ok', version: '0.1.0' });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/v1/health');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"probe":true}');
    expect(new Headers(init?.headers).get('X-Vibe-CS-Locale')).toBe('zh-CN');
  });

  it('separates clip audio with project CAS and source muting enabled by default', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ project: { revision: 8 }, asset: { id: 'audio-1' } }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await api.separateEditorAudio('project 1', 'clip/1', 7);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/v1/editor/projects/project%201/clips/clip%2F1/separate-audio');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"expected_revision":7,"mute_source":true}');
  });

  it('keeps reusable assets under the shared media API boundary', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: 'asset-1', name: 'clip.mp4' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await api.getMediaAsset('asset/1');

    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/v1/media/assets/asset%2F1');
  });

  it('uses the fixed loopback service for the Tauri protocol', () => {
    expect(resolveApiBase({ protocol: 'tauri:' })).toBe('http://127.0.0.1:47831/api/v1');
  });

  it.each(['http:', 'https:'])('recognizes the Tauri v2 Windows origin over %s', (protocol) => {
    expect(resolveApiBase({ protocol, hostname: 'tauri.localhost' })).toBe(
      'http://127.0.0.1:47831/api/v1',
    );
  });

  it('keeps relative versioned API routing in a browser', () => {
    expect(resolveApiBase({ protocol: 'http:' })).toBe('/api/v1');
  });

  it('keeps media URLs on the configured local API boundary', () => {
    expect(apiMediaUrl('/api/v1/recorded-clips/clip-id/stream')).toBe('/api/v1/recorded-clips/clip-id/stream');
    expect(() => apiMediaUrl('https://evil.example/video.mp4')).toThrow(ApiError);
  });

  it('accepts a validated build-time HTTP API origin and appends the API path', () => {
    expect(resolveApiBase({ configuredBase: 'https://adapter.example.test/service/' })).toBe(
      'https://adapter.example.test/service/api/v1',
    );
    expect(resolveApiBase({ configuredBase: 'file:///untrusted', protocol: 'tauri:' })).toBe(
      'http://127.0.0.1:47831/api/v1',
    );
  });

  it('turns a structured backend problem into ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ detail: { code: 'RUNTIME_BUSY', message: '录制服务正忙' } }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    await expect(request('/recording/queue')).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      code: 'RUNTIME_BUSY',
      message: '录制服务正忙',
    });
  });

  it('normalizes the vibe-cs-domain DemoRecord without leaking wire names into views', () => {
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

  it('keeps replay cache metadata while normalizing replay teams', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        frames: [{
          tick: 64,
          players: [{ id: '1', name: 'Player', team: 'CT', position: [1, 2, 3], yaw: 0, health: 100, armor: 0, alive: true, weapon: 'm4a1' }],
          projectiles: [{ kind: 'smoke', position: [4, 5, 6], active: true }],
          bomb: null,
        }],
        cache: { state: 'hit', version: 1, key: 'abc', bytes: 512, generated_at: '2026-08-10T00:00:00Z', repaired: false, reason: null },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const replay = await api.getReplay('demo/id');
    expect(replay.frames[0]?.players[0]?.team).toBe('B');
    expect(replay.cache).toMatchObject({ state: 'hit', bytes: 512 });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/demos/demo%2Fid/replay');
  });

  it('uses bounded replay cache status and cleanup endpoints', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: 1, entries: 2, bytes: 128, maximum_entries: 128, maximum_bytes: 1024, scan_complete: true, checked_at: '2026-08-10T00:00:00Z' }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ removed_entries: 2, freed_bytes: 128, failed_entries: 0, scan_complete: true, completed_at: '2026-08-10T00:00:01Z' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.replayCacheStatus()).resolves.toMatchObject({ entries: 2, bytes: 128 });
    await expect(api.clearReplayCache()).resolves.toMatchObject({ removed_entries: 2 });
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe('DELETE');
  });

  it('uses bounded player queries, encoded identities, and local avatar cache endpoints', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await api.listPlayers({ search: 'old name', page: 2, page_size: 24 });
    await api.getPlayer('76561198000000001/path');
    await api.avatarCacheStatus();
    await api.clearAvatarCache();

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/v1/players?search=old+name&page=2&page_size=24',
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/v1/players/76561198000000001%2Fpath');
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/v1/avatar-cache');
    expect(fetchMock.mock.calls[3]?.[0]).toBe('/api/v1/avatar-cache');
    expect(fetchMock.mock.calls[3]?.[1]?.method).toBe('DELETE');
  });

  it('encodes output filters and an explicit physical-delete choice', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [], total: 0, page: 2, page_size: 30, scan_limited: false })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: '4ef9c6f5-955d-4919-85fc-1c236f4c524c',
        output_kind: 'export',
        record_deleted: true,
        file_deleted: true,
        file_action: 'managed_file_deleted',
        warning: null,
      })));
    vi.stubGlobal('fetch', fetchMock);

    await api.listOutputs({
      page: 2,
      page_size: 30,
      kind: 'export',
      status: 'failed',
      availability: 'missing',
      search: 'match one',
    });
    await api.deleteOutput('export', '4ef9c6f5-955d-4919-85fc-1c236f4c524c', true);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/v1/outputs?page=2&page_size=30&kind=export&status=failed&availability=missing&search=match+one',
    );
    const [, deleteInit] = fetchMock.mock.calls[1] ?? [];
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      '/api/v1/outputs/export/4ef9c6f5-955d-4919-85fc-1c236f4c524c?delete_file=true',
    );
    expect(deleteInit?.method).toBe('DELETE');
  });

  it('sends only the bounded review selection to the demo review endpoint', async () => {
    const response = {
      demo_id: 'demo-id',
      scope: 'player',
      player_id: 'player-1',
      highlight_ids: [],
      tone: 'coach',
      commentary: 'review',
      evidence_ids: ['player:player-1'],
      evidence_sha256: 'a'.repeat(64),
      provider: 'local',
      model: 'model',
      generated_at: '2026-08-10T00:00:00Z',
      cached: false,
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await api.reviewDemo('demo/id', {
      scope: 'player',
      player_id: 'player-1',
      highlight_ids: [],
      tone: 'coach',
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/v1/demos/demo%2Fid/review');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      scope: 'player',
      player_id: 'player-1',
      highlight_ids: [],
      tone: 'coach',
    });
    expect(String(init?.body)).not.toContain('prompt');
    expect(String(init?.body)).not.toContain('context');
  });

  it('propagates explicit review cancellation to the HTTP request', async () => {
    let requestSignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn<typeof fetch>((_input, init) => {
      requestSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException('cancelled', 'AbortError'));
        if (requestSignal?.aborted) abort();
        else requestSignal?.addEventListener('abort', abort, { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const pending = api.reviewDemo('demo-1', {
      scope: 'match',
      highlight_ids: [],
      tone: 'analytical',
    }, controller.signal);

    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
    expect(requestSignal?.aborted).toBe(true);
  });

  it('uses typed OBS status and empty saved-config control requests', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await api.getObsStatus();
    await api.startObs();
    await api.diagnoseObs();

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/obs/status');
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBeUndefined();
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/v1/obs/start');
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe('POST');
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe('{}');
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/v1/obs/diagnose');
    expect(fetchMock.mock.calls[2]?.[1]?.method).toBe('POST');
    expect(fetchMock.mock.calls[2]?.[1]?.body).toBe('{}');
  });

  it('uses fingerprint-only confirmed OBS tuning mutations and encoded backup ids', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await api.getObsVideoTuningPlan();
    await api.applyObsVideoTuningPlan('a'.repeat(64));
    await api.listObsVideoBackups();
    await api.restoreObsVideoBackup('backup/id');
    await api.deleteObsVideoBackup('backup/id');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/obs/video-tuning/plan');
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      confirm: true,
      expected_fingerprint: 'a'.repeat(64),
    });
    expect(String(fetchMock.mock.calls[1]?.[1]?.body)).not.toContain('target');
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/v1/obs/video-tuning/backups');
    expect(fetchMock.mock.calls[3]?.[0]).toBe('/api/v1/obs/video-tuning/backups/backup%2Fid/restore');
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toEqual({ confirm: true });
    expect(fetchMock.mock.calls[4]?.[0]).toBe('/api/v1/obs/video-tuning/backups/backup%2Fid');
    expect(fetchMock.mock.calls[4]?.[1]?.method).toBe('DELETE');
  });

  it('uses explicit playback status, preflight, and launch endpoints', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await api.playbackStatus();
    await api.preflightDemo('demo/id', { start_tick: 4_096, player: 'Player One', timescale: 0.5 });
    await api.playDemo('demo/id', { start_tick: 4_096 });
    await api.stopPlayback();

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/playback/status');
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBeUndefined();
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/v1/demos/demo%2Fid/playback/preflight');
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe('POST');
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(
      '{"start_tick":4096,"player":"Player One","timescale":0.5}',
    );
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/v1/demos/demo%2Fid/play');
    expect(fetchMock.mock.calls[2]?.[1]?.method).toBe('POST');
    expect(fetchMock.mock.calls[3]?.[0]).toBe('/api/v1/playback/stop');
    expect(fetchMock.mock.calls[3]?.[1]?.method).toBe('POST');
    expect(fetchMock.mock.calls[3]?.[1]?.body).toBe('{}');
  });
});

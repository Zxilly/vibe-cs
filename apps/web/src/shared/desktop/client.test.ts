import { afterEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { DesktopError, commands, desktopMediaUrl, normalizeDemo, normalizeSide, request } from './client';
import type { AppConfig, DemoRecord, MatchAnalysisRecord } from './dto';

function matchAnalysisRecord(): MatchAnalysisRecord {
  const unavailable = { available: false, reason: 'No parsed evidence.' };
  return {
    demo_id: 'demo-1',
    map_name: 'de_mirage',
    tick_rate: 64,
    duration_seconds: 90,
    verified_total_ticks: null,
    teams: [],
    players: [{
      steam_id: '7656119', name: 'Player', team: 'CT', kills: 1, deaths: 0,
      assists: 0, headshots: 1, damage: 100, adr: 100, kill_death_ratio: 1.5, score: 2,
    }],
    rounds: [],
    highlights: [],
    insights: {
      round_economy: [],
      player_utility: [],
      matchups: [],
      availability: {
        purchase_events: unavailable,
        purchase_spend: unavailable,
        utility_events: unavailable,
        utility_damage: unavailable,
        flash_effects: unavailable,
        matchups: unavailable,
      },
    },
  };
}

describe('desktop command client', () => {
  afterEach(() => {
    invokeMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('does not expose retired OBS control commands', () => {
    for (const command of [
      'testObs',
      'getObsStatus',
      'startObs',
      'diagnoseObs',
      'getObsVideoTuningPlan',
      'applyObsVideoTuningPlan',
      'listObsVideoBackups',
      'restoreObsVideoBackup',
      'deleteObsVideoBackup',
    ]) {
      expect(commands).not.toHaveProperty(command);
    }
    expect(commands).not.toHaveProperty('checkHlaeStatus');
  });

  it('sends the exact managed-HLAE settings contract', async () => {
    const config: AppConfig = {
      locale: 'zh-CN', theme: 'dark', update_manifest_url: '', data_dir: '', demo_watch_paths: [],
      cs2_path: 'C:/CS2/cs2.exe', steam_path: 'C:/Steam/steam.exe',
      steam: { steam_id: '', web_api_key: '', authentication_code: '', known_share_code: '', maximum_results: 20 },
      steam_has_web_api_key: false, steam_has_authentication_code: false, steam_has_share_code: false,
      llm: { provider: '', model: '', base_url: '', api_key: '', prompt: '' },
      llm_has_api_key: false, clear_llm_api_key: false,
      recording: {
        pre_roll_seconds: 3, post_roll_seconds: 2.5,
        resolution: '1920x1080', fps: 60, show_radar: true, show_hud: true,
        mute_voice: false, isolate_target_voice: false, camera_fov: 90,
        viewmodel_fov: 68, flash_alpha: 255,
      },
    };
    invokeMock.mockResolvedValue(config);

    await commands.updateConfig(config);

    const body = invokeMock.mock.calls[0]?.[1]?.call.body;
    expect(body).toEqual(config);
  });

  it('sends the exact current audio analysis options when the caller uses product defaults', async () => {
    invokeMock.mockResolvedValue({ beats: [] });

    await commands.analyzeAudioAsset('audio/1');

    expect(invokeMock).toHaveBeenCalledWith('desktop_call', {
      call: {
        method: 'get',
        path: '/media/assets/audio%2F1/audio-analysis?sample_rate=11025&maximum_duration_seconds=1800&maximum_beats=4096&maximum_onsets=4096&energy_points=512&maximum_sections=24',
      },
    });
  });

  it('uses Tauri invoke instead of an HTTP origin', async () => {
    invokeMock.mockResolvedValue({
      status: 'ok',
      version: '0.1.0',
      started_at: '2026-08-13T00:00:00Z',
    });

    await expect(request('/health', { method: 'POST', body: { probe: true } })).resolves.toEqual({
      status: 'ok',
      version: '0.1.0',
      started_at: '2026-08-13T00:00:00Z',
    });
    expect(invokeMock).toHaveBeenCalledWith('desktop_call', {
      call: {
        method: 'post',
        path: '/health',
        body: { probe: true },
      },
    });
  });

  it('executes the opaque server-side recording plan instead of resending queue items', async () => {
    invokeMock.mockResolvedValue({ job_id: 'job-1', status: 'queued' });

    await commands.executeRecordingPlan('plan/unsafe id', false);

    expect(invokeMock).toHaveBeenCalledWith('desktop_call', {
      call: {
        method: 'post',
        path: '/recording/plans/plan%2Funsafe%20id/execute',
        body: { offline_insecure_acknowledged: false },
      },
    });
  });

  it('sends a deterministic cross-match evidence query through the local dispatcher', async () => {
    invokeMock.mockResolvedValue({ items: [], total: 0, page: 1, page_size: 50, availability: {} });

    await commands.searchEvidence({
      q: ' FalleN ',
      event_family: 'kill',
      headshot: false,
      round: 20,
      page: 1,
      page_size: 50,
    });

    expect(invokeMock).toHaveBeenCalledWith('desktop_call', {
      call: {
        method: 'get',
        path: '/evidence/search?q=FalleN&event_family=kill&headshot=false&round=20&page=1&page_size=50',
      },
    });
  });

  it('persists annotations against an exact canonical evidence locator', async () => {
    invokeMock.mockResolvedValue({ id: 'annotation-1' });

    await commands.createEvidenceAnnotation({
      demo_id: 'demo-1',
      evidence_id: 'demo:demo-1/event:kill-7',
      round: 7,
      tick: 42_000,
      body: 'Hold the crossfire',
      tags: ['retake'],
    });

    expect(invokeMock).toHaveBeenCalledWith('desktop_call', {
      call: {
        method: 'post',
        path: '/evidence/annotations',
        body: {
          demo_id: 'demo-1', evidence_id: 'demo:demo-1/event:kill-7',
          round: 7, tick: 42_000, body: 'Hold the crossfire', tags: ['retake'],
        },
      },
    });
  });

  it('sends the current annotation filters through one server-side page request', async () => {
    invokeMock.mockResolvedValue({ items: [], total: 0, page: 2, page_size: 25 });

    await commands.listEvidenceAnnotations({
      q: '  late retake  ',
      tag: ' Utility ',
      demo_id: 'demo-1',
      evidence_id: ' demo:demo-1/event:kill-7 ',
      state: 'resolved',
      page: 2,
      page_size: 25,
    });

    expect(invokeMock).toHaveBeenCalledWith('desktop_call', {
      call: {
        method: 'get',
        path: '/evidence/annotations?q=late+retake&tag=Utility&demo_id=demo-1&evidence_id=demo%3Ademo-1%2Fevent%3Akill-7&state=resolved&page=2&page_size=25',
      },
    });
  });

  it('restores persisted active Match History downloads through the local dispatcher', async () => {
    invokeMock.mockResolvedValue([]);

    await commands.listActiveMatchDownloadJobs();

    expect(invokeMock).toHaveBeenCalledWith('desktop_call', {
      call: { method: 'get', path: '/match-history/downloads/active' },
    });
  });

  it('reads the persisted cross-workflow activity projection through one local request', async () => {
    invokeMock.mockResolvedValue({
      items: [], total: 0, page: 2, page_size: 25,
      summary: { total: 0, active: 0, failed: 0, completed: 0 },
    });

    await commands.listActivities({
      search: 'FalleN', kind: 'recording', state: 'active', page: 2, page_size: 25,
    });

    expect(invokeMock).toHaveBeenCalledWith('desktop_call', {
      call: {
        method: 'get',
        path: '/activities?search=FalleN&kind=recording&state=active&page=2&page_size=25',
      },
    });
  });

  it('does not fake-cancel recording mutations or managed HLAE preparation in the renderer', async () => {
    vi.useFakeTimers();
    invokeMock.mockReturnValue(new Promise(() => undefined));
    let planSettled = false;
    let executeSettled = false;
    let preparationSettled = false;

    void commands.planRecording({ items: [] }).finally(() => { planSettled = true; });
    void commands.executeRecordingPlan('plan-1', false).finally(() => { executeSettled = true; });
    void commands.prepareManagedHlae().finally(() => { preparationSettled = true; });

    await vi.advanceTimersByTimeAsync(15 * 60_000 + 1);

    expect(planSettled).toBe(false);
    expect(executeSettled).toBe(false);
    expect(preparationSettled).toBe(false);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('preserves structured desktop command failures', async () => {
    invokeMock.mockRejectedValue({
      status: 409,
      code: 'RUNTIME_BUSY',
      message: '录制服务正忙',
    });

    await expect(request('/recording/jobs/job-1')).rejects.toMatchObject({
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

  it('keeps a real demo analysis alive beyond the old two-minute cutoff', async () => {
    vi.useFakeTimers();
    invokeMock.mockReturnValue(new Promise(() => undefined));
    const controller = new AbortController();
    let settled = false;
    const pending = commands.analyzeDemo('major-final-map', controller.signal)
      .finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(120_001);

    expect(settled).toBe(false);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
    vi.useRealTimers();
  });

  it('reads one demo lifecycle without starting analysis', async () => {
    invokeMock.mockResolvedValue({
      id: 'demo-1',
      path: 'D:\\Demos\\major.dem',
      file_name: 'major.dem',
      display_name: 'Major final',
      source: 'local',
      status: 'analyzing',
      map_name: null,
      match_date: null,
      duration_seconds: null,
      total_rounds: null,
      team_a_name: null,
      team_b_name: null,
      team_a_score: null,
      team_b_score: null,
      players: [],
      remark: '',
      content_sha256: null,
      file_size: 42,
      created_at: '2026-08-12T00:00:00Z',
      updated_at: '2026-08-12T00:00:01Z',
    });

    await expect(commands.getDemo('demo/1')).resolves.toMatchObject({
      id: 'demo-1',
      lifecycle_status: 'analyzing',
    });
    expect(invokeMock).toHaveBeenCalledWith('desktop_call', {
      call: { method: 'get', path: '/demos/demo%2F1' },
    });
  });

  it('sends the canonical server-side Library window without retired sort aliases', async () => {
    invokeMock.mockResolvedValue({ items: [], total: 137, page: 3, page_size: 20 });

    await commands.listDemos({
      search: 'm0NESY',
      map_name: 'de_mirage',
      status: 'indexing',
      sort: 'duration_desc',
      page: 3,
      page_size: 20,
    });

    expect(invokeMock).toHaveBeenCalledWith('desktop_call', {
      call: {
        method: 'get',
        path: '/demos/compact?search=m0NESY&map_name=de_mirage&status=indexing&sort=duration_desc&page=3&page_size=20',
      },
    });
  });

  it('normalizes a stored analysis read through the same contract as a fresh analysis', async () => {
    invokeMock.mockResolvedValue(matchAnalysisRecord());

    await expect(commands.getAnalysis('demo-1')).resolves.toMatchObject({
      demo_id: 'demo-1',
      players: [{ id: '7656119', team: 'B', kill_death_ratio: 1.5 }],
    });
    const normalized = await commands.getAnalysis('demo-1');
    expect(normalized.players[0]).not.toHaveProperty('rating');
  });

  it('rejects an analysis wire without verified total ticks', async () => {
    const { verified_total_ticks: _verifiedTotalTicks, ...incomplete } = matchAnalysisRecord();
    invokeMock.mockResolvedValue(incomplete);

    await expect(commands.getAnalysis('demo-1')).rejects.toMatchObject({
      code: 'INVALID_ANALYSIS_CONTRACT',
    });
  });

  it('rejects an analysis wire without derived insights', async () => {
    const { insights: _insights, ...incomplete } = matchAnalysisRecord();
    invokeMock.mockResolvedValue(incomplete);

    await expect(commands.getAnalysis('demo-1')).rejects.toMatchObject({
      code: 'INVALID_ANALYSIS_CONTRACT',
    });
  });

  it('routes media only through the managed desktop protocol', () => {
    expect(desktopMediaUrl('/api/recorded-clips/clip-id/stream')).toMatch(
      /^(?:vibe-cs-media:\/\/localhost|http:\/\/vibe-cs-media\.localhost)\/recorded-clips\/clip-id\/stream$/,
    );
    expect(() => desktopMediaUrl('/recorded-clips/clip-id/stream')).toThrow(DesktopError);
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

  it('loads replay only through the current bounded binary route', async () => {
    invokeMock.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);

    await commands.getReplayBinary('demo/id');

    expect(invokeMock).toHaveBeenCalledWith('desktop_binary', {
      path: '/demos/demo%2Fid/replay.bin',
    });
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

  it('keeps proposal preview and confirmed mutation on typed local routes', async () => {
    invokeMock.mockResolvedValue({ ready: true, prerequisites: [] });
    const intent = {
      demo_id: '00000000-0000-4000-8000-000000000001',
      highlight_ids: ['h-1'], camera_style: 'orbit' as const, mode: 'preview' as const,
      lead_seconds: 2.5, tail_seconds: 2,
    };
    await commands.previewHlaeProposal(intent);
    await commands.exportHlaeProposal(intent, {
      base_fingerprint: 'base', proposal_fingerprint: 'proposal', confirmation_token: 'token',
      expected_revision: 1, confirm: true,
    });
    expect(invokeMock.mock.calls[0]).toEqual(['desktop_call', {
      call: { method: 'post', path: '/agent/proposals/hlae/preview', body: intent },
    }]);
    expect(invokeMock.mock.calls[1]?.[1]).toMatchObject({
      call: {
        method: 'post', path: '/agent/proposals/hlae/export',
        body: { intent, confirm: true, confirmation_token: 'token' },
      },
    });
  });

  it('keeps managed HLAE preparation and bundle reveal behind typed desktop boundaries', async () => {
    invokeMock.mockResolvedValue([]);

    await commands.prepareManagedHlae();
    await commands.listHlaeBundles();
    await commands.revealHlaeBundle('C:/Vibe CS/hlae-plans/proposal_0123456789abcdef0123456789abcdef');

    expect(invokeMock.mock.calls[0]).toEqual(['desktop_call', {
      call: { method: 'post', path: '/hlae/managed/prepare', body: {} },
    }]);
    expect(invokeMock.mock.calls[1]).toEqual(['list_hlae_bundles']);
    expect(invokeMock.mock.calls[2]).toEqual(['reveal_hlae_bundle', {
      bundleDirectory: 'C:/Vibe CS/hlae-plans/proposal_0123456789abcdef0123456789abcdef',
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
      players: ['FalleN', 'm0NESY'],
      remark: '',
      content_sha256: null,
      file_size: 42,
      created_at: '2026-08-09T12:10:00Z',
      updated_at: '2026-08-09T12:11:00Z',
    };

    expect(normalizeDemo(record)).toMatchObject({
      path: 'D:\\Demos\\match.dem',
      filename: 'match.dem',
      score_team_a: 13,
      score_team_b: 9,
      team_a_name: 'A',
      team_b_name: 'B',
      status: 'parsing',
      players: ['FalleN', 'm0NESY'],
      updated_at: '2026-08-09T12:11:00Z',
    });
  });

  it('rejects a demo wire that uses the retired player_names field', () => {
    const current: DemoRecord = {
      id: '0c34a82a-a176-4c88-9514-940245912866',
      path: 'D:\\Demos\\match.dem',
      file_name: 'match.dem',
      display_name: 'Match',
      source: 'local',
      status: 'ready',
      map_name: null,
      match_date: null,
      duration_seconds: null,
      total_rounds: null,
      team_a_name: null,
      team_b_name: null,
      team_a_score: null,
      team_b_score: null,
      players: [],
      remark: '',
      content_sha256: null,
      file_size: 42,
      created_at: '2026-08-09T12:10:00Z',
      updated_at: '2026-08-09T12:11:00Z',
    };
    const { players: _players, ...withoutPlayers } = current;
    const retired = { ...withoutPlayers, player_names: ['legacy-player'] };

    expect(() => normalizeDemo(retired as unknown as DemoRecord)).toThrowError(
      expect.objectContaining({ code: 'INVALID_DEMO_CONTRACT' }),
    );
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

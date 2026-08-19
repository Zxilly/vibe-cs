/*
 * 「09 快速合辑」 — interaction.
 *
 * Four properties this page would be wrong without, each pinned here rather
 * than left to a reading of the code:
 *
 *   1. 「预览」 on a beat suggestion does not modify the project — asserted
 *      field by field against a snapshot, and by the absence of any PUT.
 *      「应用」 is the only thing that writes.
 *   2. A save carries a field the page never rendered. The whole document is
 *      replaced by every PUT (there is no patch and no revision), so a save
 *      built from the copy on screen would silently undo whatever else had
 *      changed. The read-modify-write in `data/montage.ts` is what stops it.
 *   3. 「生成视频」 is disabled with a written reason when the service is
 *      offline — never hidden, never silently inert.
 *   4. Every `branding_theme` the wire can hold is a labelled, pressable
 *      option, including the fourth one the artboard does not draw.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type {
  AudioAnalysis,
  BeatAlignmentDraft,
  MediaAsset,
  MontageProjectRecord,
} from '../../shared/desktop/dto';
import { MONTAGE_THEME } from './montageContract';
import { defaultMontageSettings } from './montageSettings';
import {
  montageClient,
  montageProject,
  recordedClip,
  renderMontage,
  testNativeShell,
} from './test/renderMontage';
import { reasonOf } from '../../test/reason';

/* ── fixtures with music and beats ───────────────────────────────────────── */

const MUSIC: MediaAsset = {
  id: 'asset-1',
  project_id: null,
  path: 'D:\\music\\low-orbit.mp3',
  name: 'low-orbit.mp3',
  kind: 'audio',
  duration_seconds: 180,
  width: null,
  height: null,
  file_size: 4_200_000,
  has_audio: true,
  proxy_path: null,
  proxy_status: { status: 'not_requested' },
  waveform: null,
  metadata_status: { status: 'ready' },
  created_at: '2026-08-16T06:00:00.000Z',
};

const ANALYSIS: AudioAnalysis = {
  duration_seconds: 180,
  analysis_sample_rate: 22_050,
  bpm: 120,
  tempo_confidence: 0.92,
  beats: Array.from({ length: 200 }, (_, index) => ({
    index,
    time_seconds: index * 0.5,
    strength: 0.8,
    phrase_position: (index % 4) + 1,
  })),
  onsets: [],
  energy: [],
  sections: [],
  limitations: [],
};

/** Clip 2 would run 20s instead of 18.4s. Clip 1 is already on a beat. */
const DRAFT: BeatAlignmentDraft = {
  advisory_only: true,
  clips: [
    {
      clip_id: 'clip-1',
      timeline_start_seconds: 0,
      timeline_end_seconds: 42,
      planned_duration_seconds: 42,
      source_duration_seconds: 42,
      duration_change_ratio: 0,
      start_beat_index: 0,
      end_beat_index: 84,
      rationale: ['Snapped to beat 0 through beat 84.'],
    },
    {
      clip_id: 'clip-2',
      timeline_start_seconds: 42,
      timeline_end_seconds: 62,
      planned_duration_seconds: 20,
      source_duration_seconds: 20,
      duration_change_ratio: 0.087,
      start_beat_index: 84,
      end_beat_index: 124,
      rationale: ['Minimized the change from source duration.'],
    },
  ],
  unplaced_clip_ids: [],
  constraints: [],
};

const TAKES = {
  items: [
    recordedClip({ id: 'clip-1', title: 'Mirage 1v3 残局', duration_seconds: 42 }),
    recordedClip({ id: 'clip-2', title: 'Ancient 穿墙双杀', duration_seconds: 20 }),
  ],
  total: 2,
  page: 1,
  page_size: 50,
};

interface Harness {
  readonly client: Record<string, unknown>;
  readonly puts: MontageProjectRecord[];
  current: () => MontageProjectRecord;
  external: (edit: (document: MontageProjectRecord) => MontageProjectRecord) => void;
}

/**
 * A service that behaves like the real one: `getMontageProject` answers the
 * authoritative document, `putMontageProject` replaces it wholesale.
 * `external` is another writer — the case the read-modify-write exists for.
 */
function harness(initial: MontageProjectRecord = withMusic()): Harness {
  let document = initial;
  const puts: MontageProjectRecord[] = [];

  return {
    puts,
    current: () => document,
    external: (edit) => {
      document = edit(document);
    },
    client: montageClient({
      getMontageProject: async () => document,
      putMontageProject: async (_id: string, next: MontageProjectRecord) => {
        puts.push(next);
        /* `updated_at` is left alone: these tests are about composition, not
           about the conflict guard, which has its own case below. */
        document = { ...next, updated_at: document.updated_at };
        return document;
      },
      listRecordedClips: async () => TAKES,
      listMediaAssets: async () => ({ items: [MUSIC] }),
      analyzeAudioAsset: async () => ANALYSIS,
      alignClipsToBeats: async () => DRAFT,
    }),
  };
}

function withMusic(): MontageProjectRecord {
  return montageProject({
    clips: [
      { clip_id: 'clip-1', order: 0, trim_start: 0, trim_end: 42, transition: 'cut', title: null, avatar_asset_id: null },
      { clip_id: 'clip-2', order: 1, trim_start: 0, trim_end: 18.4, transition: 'cut', title: null, avatar_asset_id: null },
    ],
    settings: { ...defaultMontageSettings(), background_music: MUSIC.path },
  });
}

async function waitForWorkspace(): Promise<void> {
  await screen.findByText('Kael 个人集锦 v2');
}

/* ── 1. 预览 writes nothing ──────────────────────────────────────────────── */

describe('节拍建议', () => {
  it('previews without touching the project, and only 「应用」 writes', async () => {
    const bench = harness();
    renderMontage({ client: bench.client });
    await waitForWorkspace();

    const before = structuredClone(bench.current());

    fireEvent.click(await screen.findByRole('button', { name: '计算节拍建议' }));
    const card = await screen.findByText(/把片段 02 的时长改为/u);
    const suggestion = card.closest('[data-montage-suggestion]') as HTMLElement;

    /* 预览 — a page-local document, and nothing else. */
    fireEvent.click(within(suggestion).getByRole('button', { name: '预览' }));
    expect(suggestion.dataset['previewing']).toBe('true');
    expect(await screen.findByText('预览中 · 工程尚未改动')).toBeTruthy();

    expect(bench.puts).toHaveLength(0);
    expect(bench.current()).toEqual(before);

    /* Leaving preview restores the table and still writes nothing. */
    /* The strip-level 「退出预览」, not the card's own toggle — both exist, and
       the point is that either of them restores the untouched document. */
    fireEvent.click(document.querySelector('[data-montage-action="exit-preview"]') as HTMLElement);
    await waitFor(() => expect(screen.queryByText('预览中 · 工程尚未改动')).toBeNull());
    expect(bench.puts).toHaveLength(0);
    expect(bench.current()).toEqual(before);

    /* 应用 is the only write, and it changes exactly one field of one clip. */
    fireEvent.click(within(suggestion).getByRole('button', { name: '应用' }));
    await waitFor(() => expect(bench.puts).toHaveLength(1));

    const written = bench.puts[0] as MontageProjectRecord;
    expect(written.clips[1]?.trim_end).toBe(20);
    expect(written.clips[0]).toEqual(before.clips[0]);
    expect(written.settings).toEqual(before.settings);
    expect(written.name).toBe(before.name);
    expect({ ...written.clips[1], trim_end: before.clips[1]?.trim_end }).toEqual(before.clips[1]);
  });
});

// End of the project-workspace interaction coverage.
/* ── 2. a save composes with what it did not render ──────────────────────── */

describe('整份 PUT', () => {
  it('carries a field the page never rendered, instead of undoing it', async () => {
    const bench = harness();
    renderMontage({ client: bench.client });
    await waitForWorkspace();

    /* Another writer — the case a whole-document PUT built from the rendered
       copy would silently revert. The page has never seen this field change. */
    bench.external((document) => ({
      ...document,
      settings: { ...document.settings, include_name_cards: true },
    }));

    fireEvent.click(screen.getByRole('radio', { name: '霓虹' }));
    await waitFor(() => expect(bench.puts).toHaveLength(1));

    const written = bench.puts[0] as MontageProjectRecord;
    expect(written.settings.branding_theme).toBe('neon');
    expect(written.settings.include_name_cards).toBe(true);
  });

  it('keeps both panels’ edits when they are made one after the other', async () => {
    const bench = harness();
    renderMontage({ client: bench.client });
    await waitForWorkspace();

    fireEvent.click(screen.getByRole('radio', { name: '霓虹' }));
    await waitFor(() => expect(bench.puts).toHaveLength(1));

    fireEvent.change(screen.getByLabelText('片段转场'), { target: { value: 'fade' } });
    await waitFor(() => expect(bench.puts).toHaveLength(2));

    const written = bench.puts[1] as MontageProjectRecord;
    expect(written.settings.branding_theme).toBe('neon');
    expect(written.clips.every((clip) => clip.transition === 'fade')).toBe(true);
  });

  it('refuses the write and offers 重新载入 when the document moved underneath it', async () => {
    const bench = harness();
    renderMontage({ client: bench.client });
    await waitForWorkspace();

    bench.external((document) => ({ ...document, updated_at: '2026-08-16T10:00:00.000Z' }));

    fireEvent.click(screen.getByRole('radio', { name: '霓虹' }));

    expect(await screen.findByText('这份工程在别处被改过，刚才的改动没有保存。')).toBeTruthy();
    expect(bench.puts).toHaveLength(0);
    expect(screen.getByRole('button', { name: '重新载入' })).toBeTruthy();
  });
});
/* ── 3. 生成视频 ─────────────────────────────────────────────────────────── */

describe('生成视频', () => {
  it('is disabled with a written reason while the service is offline', async () => {
    const bench = harness();
    renderMontage({ client: bench.client, health: undefined });
    await waitForWorkspace();

    const buttons = screen.getAllByRole('button', { name: /生成视频/u });
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button.hasAttribute('disabled')).toBe(true);
      expect(reasonOf(button)).toBeTruthy();
    }
    expect(screen.getAllByText(/本地服务未连接|正在连接本地服务/u).length).toBeGreaterThan(0);
  });

  it('is disabled with the renderer’s own reason when the project would be refused', async () => {
    const empty = montageProject({ clips: [] });
    const bench = harness(empty);
    renderMontage({ client: bench.client });
    await waitForWorkspace();

    const toolbarButton = (await screen.findAllByRole('button', { name: /生成视频/u }))[0] as HTMLElement;
    expect(toolbarButton.hasAttribute('disabled')).toBe(true);
    expect(await screen.findByText('这份合辑还没有片段')).toBeTruthy();
  });

  it('queues the render once and lands on the task', async () => {
    const bench = harness();
    const exportProject = vi.fn(async () => ({ job_id: 'job-9', status: 'queued' as const }));
    renderMontage({ client: { ...bench.client, exportMontageProject: exportProject } });
    await waitForWorkspace();

    fireEvent.click(screen.getAllByRole('button', { name: /生成视频/u })[0] as HTMLElement);

    await waitFor(() => expect(exportProject).toHaveBeenCalledTimes(1));
    expect(exportProject).toHaveBeenCalledWith('project-1');
    await waitFor(() => expect(document.querySelector('[data-elsewhere]')).not.toBeNull());
  });
});

/* ── 4. the four themes ──────────────────────────────────────────────────── */

describe('包装 · 主题', () => {
  it('offers every member of the wire enum as a labelled option', async () => {
    const bench = harness();
    renderMontage({ client: bench.client });
    await waitForWorkspace();

    const group = screen.getByRole('radiogroup', { name: '合辑主题' });
    const options = within(group).getAllByRole('radio');
    expect(options).toHaveLength(Object.keys(MONTAGE_THEME).length);
    for (const label of ['线框', '极简', '转播', '霓虹']) {
      expect(within(group).getByRole('radio', { name: label })).toBeTruthy();
    }
    expect(within(group).getByRole('radio', { name: '线框' }).getAttribute('aria-checked')).toBe('true');
  });
});

/* ── the strip, and the entrance that is not a double-click ──────────────── */

describe('片段顺序', () => {
  it('reorders from the keyboard alone', async () => {
    const bench = harness();
    renderMontage({ client: bench.client });
    await waitForWorkspace();

    const first = await screen.findByRole('button', { name: /第 1 段/u });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight', ctrlKey: true });

    await waitFor(() => expect(bench.puts).toHaveLength(1));
    const written = bench.puts[0] as MontageProjectRecord;
    expect(written.clips.map((clip) => clip.clip_id)).toEqual(['clip-2', 'clip-1']);
    expect(written.clips.map((clip) => clip.order)).toEqual([0, 1]);
  });

  it('opens the trim editor without a double-click', async () => {
    const bench = harness();
    renderMontage({ client: bench.client });
    await waitForWorkspace();

    const trim = screen.getByRole('button', { name: '裁切' });
    expect(trim.hasAttribute('disabled')).toBe(true);

    fireEvent.click(await screen.findByRole('button', { name: /第 1 段/u }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '裁切' }).hasAttribute('disabled')).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: '裁切' }));

    expect(await screen.findByRole('dialog', { name: /裁切片段/u })).toBeTruthy();
  });

  it('writes a trim through the one save', async () => {
    const bench = harness();
    renderMontage({ client: bench.client, shell: testNativeShell() });
    await waitForWorkspace();

    fireEvent.click(await screen.findByRole('button', { name: /第 1 段/u }));
    fireEvent.click(screen.getByRole('button', { name: '裁切' }));

    const start = await screen.findByLabelText('入点（秒）');
    fireEvent.change(start, { target: { value: '2.5' } });
    fireEvent.click(screen.getByRole('button', { name: '保存裁切' }));

    await waitFor(() => expect(bench.puts).toHaveLength(1));
    expect((bench.puts[0] as MontageProjectRecord).clips[0]?.trim_start).toBe(2.5);
  });
});

/* ── 「更换音乐」 goes through the native shell ───────────────────────────── */

describe('更换音乐', () => {
  it('is disabled with a reason outside the desktop shell', async () => {
    const bench = harness();
    renderMontage({ client: bench.client, shell: testNativeShell({ available: false }) });
    await waitForWorkspace();

    const button = await screen.findByRole('button', { name: '更换音乐' });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(reasonOf(button)).toContain('桌面应用');
  });

  it('imports the picked file and stores its path', async () => {
    const bench = harness();
    const chooseFile = vi.fn(async () => 'D:\\music\\next.mp3');
    const importMediaAsset = vi.fn(async () => ({ ...MUSIC, id: 'asset-2', path: 'D:\\music\\next.mp3' }));

    renderMontage({
      client: { ...bench.client, importMediaAsset },
      shell: testNativeShell({ chooseFile }),
    });
    await waitForWorkspace();

    fireEvent.click(await screen.findByRole('button', { name: '更换音乐' }));

    await waitFor(() => expect(importMediaAsset).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(bench.puts).toHaveLength(1));
    expect((bench.puts[0] as MontageProjectRecord).settings.background_music).toBe('D:\\music\\next.mp3');
  });
});

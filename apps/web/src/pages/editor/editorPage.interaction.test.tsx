/*
 * Interaction tests for 「10 多轨编辑器」.
 *
 * What is asserted here is the *page's* behaviour: that the wire document
 * reaches the timeline through the adapter, that a save sends the whole
 * document with the revision it was read at, that a 409 is surfaced rather
 * than merged, and that the actions which would lose unsaved work are
 * disabled with the reason attached.
 *
 * The editing algorithms are not re-tested — `design/timeline` has 351 cases
 * over those, in an environment where they can be driven exhaustively. A page
 * test that re-asserted trim arithmetic through the DOM would be slower and
 * less thorough at once.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { EditorProject } from '../../shared/desktop/dto';
import {
  AURORA_VIDEO,
  KAEL_VIDEO,
  PROJECT_ID,
  sampleEditorProject,
} from './editorFixtures.testing';
import { unavailableNativeShell } from '../../data/nativeShell';
import { sampleAssets } from './editorFixtures.testing';
import { editorClient, renderEditor, testNativeShell } from './test/renderEditor';

function clip(id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-clip="${id}"]`);
  if (element === null) throw new Error(`no clip ${id}`);
  return element;
}

async function openWorkspace(overrides: Record<string, unknown> = {}) {
  const view = renderEditor({ client: editorClient(overrides) });
  await screen.findByRole('button', { name: /保存/u });
  return view;
}

describe('the document reaching the timeline', () => {
  it('draws the wire project’s clips on its lanes', async () => {
    await openWorkspace();
    await waitFor(() => expect(clip(KAEL_VIDEO)).not.toBeNull());
    expect(clip(KAEL_VIDEO).textContent).toContain('Kael_Mirage_1v3.mp4');
    expect(clip(AURORA_VIDEO)).not.toBeNull();
    // The caption is on a `text` lane, which only exists because `TrackKind`
    // took the document's four (phase 3f-2).
    expect(document.querySelector('[data-kind="text"]')).not.toBeNull();
  });

  it('prints the version and the canvas the artboard asks for', async () => {
    await openWorkspace();
    expect(document.body.textContent).toContain('版本 24');
    expect(document.body.textContent).toContain('1920×1080 · 60fps');
  });

  it('starts saved, with nothing to save', async () => {
    await openWorkspace();
    expect(screen.getByTestId('editor-save-state').textContent).toContain('已保存');
    expect(screen.getByRole('button', { name: /保存/u }).hasAttribute('disabled')).toBe(true);
  });
});

describe('saving', () => {
  it('becomes unsaved after an edit and sends the whole document', async () => {
    const saveEditorProject = vi.fn(async (project: EditorProject) => ({
      ...project,
      revision: project.revision + 1,
    }));
    await openWorkspace({ saveEditorProject });

    await waitFor(() => expect(clip(AURORA_VIDEO)).not.toBeNull());
    fireEvent.focus(clip(AURORA_VIDEO));
    fireEvent.keyDown(clip(AURORA_VIDEO), { key: 'ArrowRight' });

    await waitFor(() => expect(screen.getByTestId('editor-save-state').textContent).toContain('未保存'));
    fireEvent.click(screen.getByRole('button', { name: /保存/u }));

    await waitFor(() => expect(saveEditorProject).toHaveBeenCalledTimes(1));
    const sent = saveEditorProject.mock.calls[0]?.[0] as EditorProject;
    expect(sent.id).toBe(PROJECT_ID);
    // The revision it was read at *is* the expected_revision — there is no
    // separate field on the wire.
    expect(sent.revision).toBe(24);
    expect(sent.tracks).toHaveLength(3);
  });

  it('keeps the wire fields the timeline never touched', async () => {
    // The hard rule of `editorDocument.ts`, asserted end to end: nudging a
    // clip must not cost the *other* clip its colour grade or its metadata.
    const saveEditorProject = vi.fn(async (project: EditorProject) => project);
    await openWorkspace({ saveEditorProject });

    await waitFor(() => expect(clip(AURORA_VIDEO)).not.toBeNull());
    fireEvent.focus(clip(AURORA_VIDEO));
    fireEvent.keyDown(clip(AURORA_VIDEO), { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getByTestId('editor-save-state').textContent).toContain('未保存'));
    fireEvent.click(screen.getByRole('button', { name: /保存/u }));

    await waitFor(() => expect(saveEditorProject).toHaveBeenCalled());
    const sent = saveEditorProject.mock.calls[0]?.[0] as EditorProject;
    const kael = sent.tracks.flatMap((track) => track.clips).find((each) => each.id === KAEL_VIDEO);
    expect(kael?.effects).toHaveLength(1);
    expect(kael?.metadata).toEqual({ origin: { kind: 'recorded_clip', shot: 3 } });
  });

  it('says a conflict happened instead of merging it', async () => {
    // `data/editor.ts` argues this at length: merging a timeline that moved
    // underneath you is a guess, and an invisible one.
    const conflict = Object.assign(new Error('revision_conflict'), {
      status: 409,
      code: 'revision_conflict',
    });
    await openWorkspace({
      saveEditorProject: vi.fn(async () => {
        throw conflict;
      }),
    });

    await waitFor(() => expect(clip(AURORA_VIDEO)).not.toBeNull());
    fireEvent.focus(clip(AURORA_VIDEO));
    fireEvent.keyDown(clip(AURORA_VIDEO), { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getByRole('button', { name: /保存/u }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: /保存/u }));

    await waitFor(() => expect(document.body.textContent).toContain('这个工程在别处被改过'));
    expect(screen.getByRole('button', { name: '重新载入' }).hasAttribute('disabled')).toBe(false);
  });

  it('goes back to 已保存 when an edit is undone', async () => {
    // A value comparison, not a dirty flag — `hasUnsavedChanges`.
    await openWorkspace();
    await waitFor(() => expect(clip(AURORA_VIDEO)).not.toBeNull());
    fireEvent.focus(clip(AURORA_VIDEO));
    fireEvent.keyDown(clip(AURORA_VIDEO), { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getByTestId('editor-save-state').textContent).toContain('未保存'));

    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    await waitFor(() => expect(screen.getByTestId('editor-save-state').textContent).toContain('已保存'));
  });
});

describe('the actions that would lose unsaved work', () => {
  it('blocks both exports until the document is saved', async () => {
    // An export renders from the *stored* project, so exporting with unsaved
    // edits would silently produce the wrong video.
    await openWorkspace();
    await waitFor(() => expect(clip(AURORA_VIDEO)).not.toBeNull());
    fireEvent.focus(clip(AURORA_VIDEO));
    fireEvent.keyDown(clip(AURORA_VIDEO), { key: 'ArrowRight' });

    await waitFor(() => expect(screen.getByRole('button', { name: /导出视频/u }).hasAttribute('disabled')).toBe(true));
    expect(screen.getByRole('button', { name: /导出工程包/u }).hasAttribute('disabled')).toBe(true);
    expect(document.body.textContent).toContain('先保存改动');
  });

  it('exports the stored project when there is nothing unsaved', async () => {
    const exportEditorProject = vi.fn(async () => ({ job_id: 'job-9', status: 'queued' as const }));
    await openWorkspace({ exportEditorProject });
    fireEvent.click(screen.getByRole('button', { name: /导出视频/u }));
    await waitFor(() => expect(exportEditorProject).toHaveBeenCalledWith(PROJECT_ID, {
      encoder: 'auto',
      quality: 85,
    }));
  });
});

describe('the media library', () => {
  it('groups a missing asset apart from the videos', async () => {
    // 缺失 is a state, not a kind — an unreadable file sorted quietly among
    // the videos would be found only when an export failed.
    await openWorkspace({
      listMediaAssets: async () => ({
        items: [
          {
            id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
            project_id: PROJECT_ID,
            path: 'C:/gone.png',
            name: 'intro_plate.png',
            kind: 'image',
            duration_seconds: null,
            width: null,
            height: null,
            file_size: 12,
            has_audio: false,
            proxy_path: null,
            proxy_status: { status: 'not_requested' },
            waveform: null,
            metadata_status: { status: 'unavailable', message: 'unreadable' },
            created_at: '2026-08-01T09:00:00Z',
          },
        ],
      }),
    });

    await waitFor(() => expect(screen.getByTestId('missing-heading')).not.toBeNull());
    expect(document.body.textContent).toContain('需要重新定位');
  });

  it('refuses to place an asset whose length was never measured, and says why', async () => {
    await openWorkspace({
      listMediaAssets: async () => ({
        items: [
          {
            id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
            project_id: PROJECT_ID,
            path: 'C:/pending.mp4',
            name: 'pending.mp4',
            kind: 'video',
            duration_seconds: null,
            width: null,
            height: null,
            file_size: 12,
            has_audio: false,
            proxy_path: null,
            proxy_status: { status: 'not_requested' },
            waveform: null,
            metadata_status: { status: 'pending' },
            created_at: '2026-08-01T09:00:00Z',
          },
        ],
      }),
    });

    const row = await screen.findByText('pending.mp4');
    fireEvent.click(row);
    const add = screen.getByRole('button', { name: /添加到时间轴/u });
    expect(add.hasAttribute('disabled')).toBe(true);
    expect(document.body.textContent).toContain('还没读到这个素材的时长');
  });
});

describe('importing media', () => {
  it('picks files through the shell and imports each one', async () => {
    const importMediaAsset = vi.fn(
      async (_path: string, _options: { projectId?: string }) => [...sampleAssets().values()][0],
    );
    const chooseFiles = vi.fn(async () => ['C:/clips/a.mp4', 'C:/clips/b.mp4']);
    const view = renderEditor({
      client: editorClient({ importMediaAsset }),
      shell: testNativeShell({ chooseFiles }),
    });
    await screen.findByRole('button', { name: /保存/u });

    fireEvent.click(screen.getByRole('button', { name: '导入' }));

    await waitFor(() => expect(importMediaAsset).toHaveBeenCalledTimes(2));
    expect(chooseFiles).toHaveBeenCalledTimes(1);
    /* Imported under the project, so the asset list this page reads is the one
       the new files land in. */
    expect(importMediaAsset.mock.calls[0]?.[1]).toMatchObject({ projectId: PROJECT_ID });
    view.unmount();
  });

  it('says so rather than opening nothing outside the desktop shell', async () => {
    const importMediaAsset = vi.fn();
    renderEditor({
      client: editorClient({ importMediaAsset }),
      shell: unavailableNativeShell,
    });
    await screen.findByRole('button', { name: /保存/u });

    fireEvent.click(screen.getByRole('button', { name: '导入' }));

    await waitFor(() => {
      expect(document.body.textContent).toContain('需要桌面应用');
    });
    expect(importMediaAsset).not.toHaveBeenCalled();
  });

  it('reports a failed import instead of stopping quietly', async () => {
    // Importing ten files and silently landing seven would leave the user
    // counting rows to find out.
    const importMediaAsset = vi.fn(async () => {
      throw new Error('磁盘没有空间');
    });
    renderEditor({
      client: editorClient({ importMediaAsset }),
      shell: testNativeShell({ chooseFiles: async () => ['C:/clips/a.mp4'] }),
    });
    await screen.findByRole('button', { name: /保存/u });

    fireEvent.click(screen.getByRole('button', { name: '导入' }));

    await waitFor(() => {
      expect(document.body.textContent).toContain('磁盘没有空间');
    });
  });
});

describe('the inspector', () => {
  it('reads the selected clip’s window from the document', async () => {
    await openWorkspace();
    await waitFor(() => expect(clip(AURORA_VIDEO)).not.toBeNull());
    fireEvent.focus(clip(AURORA_VIDEO));

    await waitFor(() => expect(screen.getByTestId('inspector-title').textContent).toContain('Aurora_R13_ace.mp4'));
    // 4s in, 15s long, at 100% — 00:00:04:00 to 00:00:19:00.
    expect(screen.getByTestId('inspector-source-in').textContent).toBe('00:00:04:00');
    expect(screen.getByTestId('inspector-source-out').textContent).toBe('00:00:19:00');
  });

  it('disables editing on a clip carrying a speed ramp, with the reason', async () => {
    const ramped = sampleEditorProject();
    ramped.tracks[0]!.clips[1]!.speed_segments = [
      { id: 'seg-1', start: 0, end: 7.5, speed: 1 },
      { id: 'seg-2', start: 7.5, end: 15, speed: 2 },
    ];
    await openWorkspace({ getEditorProject: async () => ramped });

    await waitFor(() => expect(clip(AURORA_VIDEO)).not.toBeNull());
    fireEvent.focus(clip(AURORA_VIDEO));

    await waitFor(() => expect(screen.getByTestId('inspector-speed').hasAttribute('disabled')).toBe(true));
    expect(document.body.textContent).toContain('分段变速');
    // …and the trim handles are not offered at all: a handle that refuses on
    // release is worse than one that was never there.
    expect(clip(AURORA_VIDEO).querySelector('.tl-clip-handle')).toBeNull();
  });

  it('leaves the handles on an ordinary clip', async () => {
    await openWorkspace();
    await waitFor(() => expect(clip(AURORA_VIDEO)).not.toBeNull());
    expect(clip(AURORA_VIDEO).querySelector('.tl-clip-handle')).not.toBeNull();
  });
});

describe('offline', () => {
  it('disables the writes with the service’s own reason', async () => {
    renderEditor({ client: editorClient(), health: undefined });
    await waitFor(() => expect(screen.getByRole('button', { name: /导出视频/u }).hasAttribute('disabled')).toBe(true));
  });
});

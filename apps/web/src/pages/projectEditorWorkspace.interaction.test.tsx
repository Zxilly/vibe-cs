import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { HealthyServiceGate } from '../test/ServiceGate.testing';
import { reasonOf } from '../test/reason';
import { ProjectWorkspacePage } from './ProjectWorkspacePage';
import { AURORA_VIDEO, PROJECT_ID, sampleAssets } from './editor/editorFixtures.testing';
import { editorClient, renderEditor } from './editor/test/renderEditor';

describe('multitrack mode inside a project shot list', () => {
  it('opens the existing editor, includes shared match media, and explains local-save mode semantics', async () => {
    const assets = [...sampleAssets().values()];
    const shared = { ...(assets[0] as NonNullable<(typeof assets)[number]>), id: 'shared-match', name: '关联比赛片段.mp4', project_id: null };
    const requestedScopes: Array<string | undefined> = [];
    const client = editorClient({
      listMediaAssets: async (projectId?: string) => {
        requestedScopes.push(projectId);
        return { items: projectId === undefined ? [shared] : assets };
      },
    });

    const { container } = renderEditor({
      client,
      route: `/projects/${encodeURIComponent(`editor:${PROJECT_ID}`)}?step=shotlist`,
      element: <HealthyServiceGate><ProjectWorkspacePage /></HealthyServiceGate>,
    });

    await waitFor(() => expect(container.querySelector('[data-editor-mode]')).not.toBeNull());
    await screen.findByRole('button', { name: /保存/u });
    expect(document.querySelector(`[data-clip="${AURORA_VIDEO}"]`)).not.toBeNull();
    expect(await screen.findByText('关联比赛片段.mp4')).toBeTruthy();
    expect(new Set(requestedScopes)).toEqual(new Set([PROJECT_ID, undefined]));

    expect(screen.getByRole('button', { name: '多轨精剪' }).hasAttribute('disabled')).toBe(false);
    expect(reasonOf(screen.getByRole('button', { name: '快速剪辑' }))).toContain('切换前请保存');

    const clip = document.querySelector(`[data-clip="${AURORA_VIDEO}"]`) as HTMLElement;
    fireEvent.focus(clip);
    fireEvent.keyDown(clip, { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getByTestId('editor-save-state').textContent).toContain('未保存'));
    expect(document.body.textContent).toContain('多轨修改保留在本地，切换步骤前请保存');
  });
});

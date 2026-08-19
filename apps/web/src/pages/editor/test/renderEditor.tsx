/*
 * Test-only harness for 「10 多轨编辑器」.
 *
 * The same four providers `renderMontage` explains, for the same reasons —
 * router, desktop client, seeded health, native shell — plus one thing that is
 * specific to this page: **the fixtures are the wire fixtures**.
 *
 * `editorFixtures.testing.ts` builds an `EditorProject`, and these tests feed
 * that straight through `getEditorProject`. Nothing here constructs a
 * `Timeline`: the adapter is under test as much as the page is, and a harness
 * that handed the page a model would skip it.
 *
 * Lives under `test/` so `lingui.config.ts` keeps its strings out of the
 * catalogue and vitest does not mistake it for a suite.
 */

import { useQueryClient } from '@tanstack/react-query';
import type { RenderResult } from '@testing-library/react';
import { useState, type ReactElement, type ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { DesktopClientProvider, type DesktopClient } from '../../../data/desktopClient';
import { qk } from '../../../data/keys';
import {
  NativeShellProvider,
  unavailableNativeShell,
  type NativeShell,
} from '../../../data/nativeShell';
import type { ApiHealth, EditorProject } from '../../../shared/desktop/dto';
import { renderInteractive } from '../../../test/render';
import { EditorPage } from '../../EditorPage';
import { sampleAssets, sampleEditorProject } from '../editorFixtures.testing';

export const HEALTHY: ApiHealth = {
  status: 'ok',
  version: '0.0.0-test',
  started_at: '2026-08-16T09:00:00.000Z',
};

/** A shell that can do everything, with spies the test supplies. */
export function testNativeShell(overrides: Partial<NativeShell> = {}): NativeShell {
  return {
    ...unavailableNativeShell,
    available: true,
    mediaSrc: (path) => `vibe-cs-media://localhost${path}`,
    ...overrides,
  };
}

/**
 * The methods every editor render needs answered, so a test only spells out
 * the ones it is about. Each returns the empty answer of its own shape — a
 * page that draws something from one of these without the test saying so is
 * drawing it from nowhere.
 */
export function editorClient(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const project = sampleEditorProject();
  return {
    listEditorProjects: async () => ({ items: [project] }),
    listAgentPlans: async () => [],
    listMontageProjects: async () => ({ items: [] }),
    listActivities: async () => ({ items: [], total: 0, page: 1, page_size: 50, summary: { total: 0, active: 0, failed: 0, completed: 0, cancelled: 0 } }),
    listOutputs: async () => ({ items: [], total: 0, page: 1, page_size: 100, scan_limited: false }),
    getEditorProject: async () => project,
    createEditorProject: async () => project,
    saveEditorProject: async (next: EditorProject) => ({ ...next, revision: next.revision + 1 }),
    duplicateEditorProject: async () => project,
    deleteEditorProjects: async () => ({ deleted: [], failed: [] }),
    listEditorSnapshots: async () => ({ items: [] }),
    restoreEditorSnapshot: async () => project,
    listEditorPresets: async () => ({ items: [] }),
    applyEditorPreset: async () => project,
    separateEditorAudio: async () => ({
      source_clip_id: '',
      audio_clip_id: '',
      audio_asset_id: '',
      audio_track_id: '',
      revision: project.revision + 1,
    }),
    exportEditorProject: async () => ({ job_id: 'job-9', status: 'queued' as const }),
    exportEditorPackage: async () => ({ path: 'C:/out/package.zip', size: 1 }),
    listMediaAssets: async () => ({ items: [...sampleAssets().values()] }),
    getMediaAsset: async () => [...sampleAssets().values()][0],
    importMediaAsset: async () => [...sampleAssets().values()][0],
    getAssetWaveform: async () => ({ waveform: [], cached: true }),
    getConfig: async () => ({ data_dir: 'D:\\CS2' }),
    ...overrides,
  };
}

export interface RenderEditorOptions {
  readonly client: Record<string, unknown>;
  /** Defaults to the workspace at the sample project. */
  readonly route?: string | undefined;
  /**
   * Omitting the *key* seeds `HEALTHY`; passing it explicitly as `undefined`
   * seeds nothing, which is how a test says 「未连接」. A default parameter
   * could not tell those two apart.
   */
  readonly health?: ApiHealth | undefined;
  readonly shell?: NativeShell | undefined;
  readonly element?: ReactElement | undefined;
}

export function renderEditor(options: RenderEditorOptions): RenderResult {
  const {
    client,
    route = `/editor/${sampleEditorProject().id}`,
    shell = testNativeShell(),
    element = <EditorPage />,
  } = options;
  const health = Object.hasOwn(options, 'health') ? options.health : HEALTHY;

  return renderInteractive(
    <DesktopClientProvider client={client as unknown as DesktopClient}>
      <NativeShellProvider shell={shell}>
        <MemoryRouter initialEntries={[route]}>
          <SeedHealth health={health}>
            <Routes>
              <Route path="/editor" element={element} />
              <Route path="/editor/:projectId" element={element} />
              <Route path="/projects/:projectId" element={element} />
              <Route path="*" element={<span data-elsewhere="">elsewhere</span>} />
            </Routes>
          </SeedHealth>
        </MemoryRouter>
      </NativeShellProvider>
    </DesktopClientProvider>,
  );
}

function SeedHealth({
  health,
  children,
}: {
  readonly health: ApiHealth | undefined;
  readonly children: ReactNode;
}) {
  const queryClient = useQueryClient();
  useState(() => {
    if (health !== undefined) queryClient.setQueryData(qk.service.health(), health);
    return null;
  });
  return <>{children}</>;
}

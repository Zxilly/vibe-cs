/*
 * Test-only harness for 「09 快速合辑」.
 *
 * Four providers, and each one is there because the page would otherwise be
 * testing something other than itself:
 *
 *   router          `/montage/:projectId?` and every `RouteLink`
 *   desktop client  `DesktopClientProvider` — no test touches the IPC bridge,
 *                   and there is no Tauri host under vitest anyway
 *   health cache    seeding `qk.service.health()` is how a test says 「服务在
 *                   线」; *not* seeding it is how it says 「离线」, which is the
 *                   state the disabled-with-a-reason rule is about
 *   native shell    `NativeShellProvider` — 「更换音乐」 and 「打开输出目录」 go
 *                   through `data/nativeShell`, whose production implementation
 *                   answers `available: false` in every non-desktop host
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
import type {
  ApiHealth,
  MontageClipRecord,
  MontageProjectRecord,
} from '../../../shared/desktop/dto';
import type { RecordedClip } from '../../../shared/desktop/viewModels';
import { renderInteractive } from '../../../test/render';
import { MontageWorkspace } from '../../MontagePage';
import { defaultMontageSettings } from '../montageSettings';

export const HEALTHY: ApiHealth = {
  status: 'ok',
  version: '0.0.0-test',
  started_at: '2026-08-16T09:00:00.000Z',
};

/* ── fixtures ────────────────────────────────────────────────────────────── */

export function montageClip(overrides: Partial<MontageClipRecord> = {}): MontageClipRecord {
  return {
    clip_id: 'clip-1',
    order: 0,
    trim_start: 0,
    trim_end: null,
    transition: 'cut',
    title: null,
    avatar_asset_id: null,
    ...overrides,
  };
}

export function montageProject(overrides: Partial<MontageProjectRecord> = {}): MontageProjectRecord {
  return {
    id: 'project-1',
    name: 'Kael 个人集锦 v2',
    clips: [
      montageClip({ clip_id: 'clip-1', order: 0, trim_end: 42 }),
      montageClip({ clip_id: 'clip-2', order: 1, trim_end: 18.4 }),
    ],
    settings: defaultMontageSettings(),
    created_at: '2026-08-16T08:00:00.000Z',
    updated_at: '2026-08-16T09:00:00.000Z',
    ...overrides,
  };
}

export function recordedClip(overrides: Partial<RecordedClip> = {}): RecordedClip {
  return {
    id: 'clip-1',
    title: 'Mirage 1v3 残局',
    player_name: 'Kael',
    map_name: 'de_mirage',
    duration_seconds: 42,
    created_at: '2026-08-16T07:00:00.000Z',
    stream_url: '/api/recorded-clips/clip-1/stream',
    ...overrides,
  };
}

/** A shell that can do everything, with spies the test supplies. */
export function testNativeShell(overrides: Partial<NativeShell> = {}): NativeShell {
  return {
    ...unavailableNativeShell,
    available: true,
    mediaSrc: (path) => `vibe-cs-media://localhost${path}`,
    ...overrides,
  };
}

/* ── the render ──────────────────────────────────────────────────────────── */

export interface RenderMontageOptions {
  readonly client: Record<string, unknown>;
  /** Defaults to the workspace at `/montage/project-1`. */
  readonly route?: string | undefined;
  /**
   * The health entry to seed. Omitting the *key* seeds `HEALTHY`, because most
   * of these tests are not about the service being down; passing it explicitly
   * as `undefined` seeds nothing, which is how a test says 「未连接」. A default
   * parameter could not tell those two apart — `health: undefined` would take
   * the default and quietly test the online path.
   */
  readonly health?: ApiHealth | undefined;
  readonly shell?: NativeShell | undefined;
  /** Overrides the page under test; defaults to `MontagePage`. */
  readonly element?: ReactElement | undefined;
}

export function renderMontage(options: RenderMontageOptions): RenderResult {
  const {
    client,
    route = '/montage/project-1',
    shell = testNativeShell(),
    element = <MontageWorkspace projectId="project-1" />,
  } = options;
  const health = Object.hasOwn(options, 'health') ? options.health : HEALTHY;

  return renderInteractive(
    <DesktopClientProvider client={client as unknown as DesktopClient}>
      <NativeShellProvider shell={shell}>
        <MemoryRouter initialEntries={[route]}>
          <SeedHealth health={health}>
            <Routes>
              <Route path="/montage" element={element} />
              <Route path="/montage/:projectId" element={element} />
              <Route path="/projects/:projectId" element={element} />
              <Route path="*" element={<span data-elsewhere="">elsewhere</span>} />
            </Routes>
          </SeedHealth>
        </MemoryRouter>
      </NativeShellProvider>
    </DesktopClientProvider>,
  );
}

/**
 * The methods every montage render needs answered, so a test only spells out
 * the ones it is about. Each returns the empty answer of its own shape — a
 * page that draws something from one of these without the test saying so is
 * drawing it from nowhere.
 */
export function montageClient(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    listMontageProjects: async () => ({ items: [] }),
    listAgentPlans: async () => [],
    listEditorProjects: async () => ({ items: [] }),
    listActivities: async () => ({ items: [], total: 0, page: 1, page_size: 50, summary: { total: 0, active: 0, failed: 0, completed: 0, cancelled: 0 } }),
    listOutputs: async () => ({ items: [], total: 0, page: 1, page_size: 100, scan_limited: false }),
    getMontageProject: async () => montageProject(),
    putMontageProject: async (_id: string, project: MontageProjectRecord) => project,
    createMontageProject: async () => montageProject(),
    deleteMontageProject: async () => undefined,
    exportMontageProject: async () => ({ job_id: 'job-9', status: 'queued' as const }),
    convertMontageToEditor: async () => ({ id: 'editor-copy-1' }),
    listExportJobs: async () => ({ items: [] }),
    listRecordedClips: async () => ({ items: [recordedClip()], total: 1, page: 1, page_size: 50 }),
    listMediaAssets: async () => ({ items: [] }),
    getAssetWaveform: async () => ({ waveform: [], cached: true }),
    getRecordedClipWaveform: async () => ({ waveform: [], cached: true }),
    getConfig: async () => ({ data_dir: 'D:\\CS2' }),
    ...overrides,
  };
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

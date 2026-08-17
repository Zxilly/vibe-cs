/*
 * 「09 快速合辑」 — markup.
 *
 * The cache is *seeded* rather than fetched: `renderToStaticMarkup` runs no
 * effects, so a query would stay pending forever and every assertion below
 * would be about a skeleton. Writing the entries the page reads gives the
 * loaded page in one pass, which is the state worth asserting structure on.
 */

import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useState, type ReactElement, type ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { DesktopClientProvider, type DesktopClient } from '../../data/desktopClient';
import { qk } from '../../data/keys';
import { NativeShellProvider, unavailableNativeShell } from '../../data/nativeShell';
import type { ApiHealth, MediaAsset, MontageProjectRecord } from '../../shared/desktop/dto';
import type { RecordedClip } from '../../shared/desktop/viewModels';
import { renderMarkup } from '../../test/render';
import { MontagePage } from '../MontagePage';
import { defaultMontageSettings, MONTAGE_TRANSITIONS } from './montageSettings';
import { MONTAGE_THEME } from './montageContract';

const HEALTH: ApiHealth = { status: 'ok', version: '0.0.0-test', started_at: '2026-08-16T09:00:00.000Z' };

const TAKES: RecordedClip[] = [
  {
    id: 'clip-1',
    title: 'Mirage 1v3 残局',
    player_name: 'Kael',
    map_name: 'de_mirage',
    duration_seconds: 42,
    created_at: '2026-08-16T07:00:00.000Z',
    stream_url: '/api/recorded-clips/clip-1/stream',
  },
  {
    id: 'clip-2',
    title: 'Ancient 穿墙双杀',
    player_name: 'Kael',
    map_name: 'de_ancient',
    duration_seconds: 18.4,
    created_at: '2026-08-16T07:10:00.000Z',
    stream_url: '/api/recorded-clips/clip-2/stream',
  },
];

const PROJECT: MontageProjectRecord = {
  id: 'project-1',
  name: 'Kael 个人集锦 v2',
  clips: [
    { clip_id: 'clip-1', order: 0, trim_start: 0, trim_end: 42, transition: 'cut', title: null, avatar_asset_id: null },
    { clip_id: 'clip-2', order: 1, trim_start: 0, trim_end: 18.4, transition: 'cut', title: null, avatar_asset_id: null },
  ],
  settings: { ...defaultMontageSettings(), background_music: 'D:\\music\\low-orbit.mp3' },
  created_at: '2026-08-16T08:00:00.000Z',
  updated_at: '2026-08-16T09:00:00.000Z',
};

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

type Seed = readonly (readonly [QueryKey, unknown])[];

function Seeded({ seed, children }: { readonly seed: Seed; readonly children: ReactNode }) {
  const client = useQueryClient();
  useState(() => {
    for (const [key, value] of seed) client.setQueryData(key, value);
    return null;
  });
  return <>{children}</>;
}

function render(route: string, seed: Seed, element: ReactElement = <MontagePage />): string {
  return renderMarkup(
    <DesktopClientProvider client={{} as unknown as DesktopClient}>
      <NativeShellProvider shell={unavailableNativeShell}>
        <MemoryRouter initialEntries={[route]}>
          <Seeded seed={seed}>
            <Routes>
              <Route path="/montage" element={element} />
              <Route path="/montage/:projectId" element={element} />
            </Routes>
          </Seeded>
        </MemoryRouter>
      </NativeShellProvider>
    </DesktopClientProvider>,
  );
}

const WORKSPACE_SEED: Seed = [
  [qk.service.health(), HEALTH],
  [qk.montage.detail('project-1'), PROJECT],
  [qk.outputs.recordedClips(), { items: TAKES, total: 2, page: 1, page_size: 50 }],
  [qk.media.assets(null), { items: [MUSIC] }],
  [qk.config.app(), { data_dir: 'D:\\CS2' }],
];

describe('/montage/:projectId — the workspace', () => {
  const html = render('/montage/project-1', WORKSPACE_SEED);

  it('is a Page with a toolbar, not a bare div', () => {
    expect(html).toContain('data-page=');
    expect(html).toContain('data-page-toolbar');
    expect(html).toContain('data-toolbar-title="true"');
    expect(html).toContain('Kael 个人集锦 v2');
  });

  it('draws the artboard’s four blocks', () => {
    for (const block of ['clips', 'music', 'packaging', 'export']) {
      expect(html).toContain(`data-montage-block="${block}"`);
    }
  });

  it('prints 「N 段素材 · 时长 · 上次保存」 from the document, not from a fixture', () => {
    expect(html).toContain('2 段素材');
    /* 42 + 18.4 = 60.4s → 1 分 00 秒. */
    expect(html).toContain('1 分');
    expect(html).toContain('00 秒');
  });

  it('renders 「生成视频」 twice — the top bar and the foot of 导出 — and no more', () => {
    const occurrences = html.split('data-montage-export=').length - 1;
    expect(occurrences).toBe(2);
    expect(html).toContain('data-montage-export="toolbar"');
    expect(html).toContain('data-montage-export="panel"');
  });

  it('disables 「在多轨编辑器中打开」 with the reason written on it', () => {
    expect(html).toContain('data-montage-action="editor"');
    expect(html).toMatch(/暂时不能互相转换/u);
  });

  it('labels every branding theme the wire can hold, including the fourth', () => {
    /* `value`, not a `data-montage-theme` of its own: the group is a `Seg` now,
       and the value is what the radio actually submits. */
    for (const theme of Object.keys(MONTAGE_THEME)) {
      expect(html).toContain(`value="${theme}"`);
    }
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('线框');
    expect(html).toContain('极简');
    expect(html).toContain('转播');
    expect(html).toContain('霓虹');
  });

  it('offers every transition the renderer accepts', () => {
    for (const kind of MONTAGE_TRANSITIONS) {
      expect(html).toContain(`value="${kind}"`);
    }
  });

  it('prints the naming rule instead of inventing a file name', () => {
    expect(html).toContain('montage-project-1-');
    expect(html).not.toContain('Kael_highlights_v2.mp4');
  });

  it('omits the size estimate the wire has no field for', () => {
    expect(html).not.toContain('MB');
    expect(html).not.toContain('540');
  });

  it('shows the export directory it read from the config', () => {
    expect(html).toContain('D:\\CS2\\exports');
  });

  it('says the beat suggestions are advisory, in the artboard’s own words', () => {
    expect(html).toContain('节拍建议不会直接修改工程，应用前可逐条预览。');
  });

  it('invents no progress bar — there is no denominator here', () => {
    expect(html).not.toContain('role="progressbar"');
  });
});

describe('/montage/:projectId — before the document arrives', () => {
  const html = render('/montage/project-1', [[qk.service.health(), HEALTH]]);

  it('shows skeletons and no invented percentage', () => {
    expect(html).toContain('data-montage-block="packaging"');
    expect(html).toContain('正在读取包装设置');
    expect(html).not.toContain('role="progressbar"');
  });

  it('keeps 「生成视频」 rendered and disabled rather than hiding it', () => {
    expect(html).toContain('data-montage-export="toolbar"');
    expect(html).toContain('disabled');
  });
});

describe('/montage — the project list', () => {
  it('is the list, with 新建合辑 as its primary action', () => {
    const html = render('/montage', [
      [qk.service.health(), HEALTH],
      [qk.montage.list(), { items: [PROJECT] }],
      [qk.outputs.recordedClips(), { items: TAKES, total: 2, page: 1, page_size: 50 }],
    ]);
    expect(html).toContain('快速合辑');
    expect(html).toContain('data-montage-action="create"');
    expect(html).toContain('Kael 个人集锦 v2');
    expect(html).toContain('data-montage-action="delete"');
  });

  it('offers 「新建合辑」 from the empty state too', () => {
    const html = render('/montage', [
      [qk.service.health(), HEALTH],
      [qk.montage.list(), { items: [] }],
      [qk.outputs.recordedClips(), { items: [], total: 0, page: 1, page_size: 50 }],
    ]);
    expect(html).toContain('还没有合辑');
    expect(html).toContain('新建合辑');
  });
});

describe('with the service offline', () => {
  it('disables 「生成视频」 and writes why, rather than hiding it', () => {
    const html = render(
      '/montage/project-1',
      WORKSPACE_SEED.filter(([key]) => JSON.stringify(key) !== JSON.stringify(qk.service.health())),
    );
    expect(html).toContain('data-montage-export="toolbar"');
    expect(html).toMatch(/本地服务未连接|正在连接本地服务/u);
    expect(html).toContain('需要服务');
  });
});

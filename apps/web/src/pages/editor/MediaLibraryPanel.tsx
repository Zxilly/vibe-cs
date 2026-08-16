/*
 * pages/editor — 素材库, the artboard's left column.
 *
 *   Kael_Mirage_1v3.mp4     42.0s · 1080p60
 *   Aurora_R13_ace.mp4      28.0s · 1080p60
 *   音频
 *   low-orbit.mp3           3:12 · 128 BPM
 *   缺失
 *   intro_plate.png         需要重新定位
 *   [导入]  [重新定位]
 *
 * ── the three groups are three different facts ────────────────────────────
 *
 * The artboard groups by kind (video / 音频) and then breaks that grouping for
 * 缺失. That is not an inconsistency: **缺失 is not a kind, it is a state**, and
 * it is the one the user has to act on. A file that has gone missing sorted
 * quietly among the videos would be found only when an export failed.
 *
 * What makes an asset 「缺失」 here is `metadata_status: unavailable` — the probe
 * ran and could not read the file. `pending` is a *third* state and is drawn as
 * such (「读取中」): an asset whose metadata has not arrived yet has no duration,
 * so 「添加到时间轴」 cannot know how long a clip to make. Collapsing pending
 * into missing would tell the user to relocate a file that is fine.
 *
 * ── 「重新定位」 is disabled, and says why ─────────────────────────────────
 *
 * `relinkMediaAsset` exists on the bridge and is deliberately **not** wired up.
 * Relocating means picking a replacement file, which needs a native file
 * dialog this page has no route to — `importMediaAsset` takes a path the
 * caller already has. The artboard draws the button, so it is drawn, disabled,
 * with the reason on it. Recorded as a gap rather than faked with a text box
 * asking the user to type a Windows path.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useMemo, useState } from 'react';

import { EmptyState } from '../../design/data';
import { Button, cx } from '../../design/primitives';
import type { MediaAsset } from '../../shared/desktop/dto';
import { formatBytes, formatClockDuration, type EditorPanelProps } from './editorContract';

type AssetState = 'ready' | 'pending' | 'missing';

function stateOf(asset: MediaAsset): AssetState {
  if (asset.metadata_status.status === 'unavailable') return 'missing';
  if (asset.metadata_status.status === 'pending') return 'pending';
  return 'ready';
}

/** `1080p60` when both are known, `1080p` when only the size is. */
function formatVideoSpec(asset: MediaAsset): string | null {
  if (asset.height === null) return null;
  return `${asset.height}p`;
}

export function MediaLibraryPanel({ desk, service }: EditorPanelProps) {
  const [selected, setSelected] = useState<string | null>(null);

  const groups = useMemo(() => {
    const video: MediaAsset[] = [];
    const audio: MediaAsset[] = [];
    const missing: MediaAsset[] = [];
    for (const asset of desk.assets) {
      if (stateOf(asset) === 'missing') missing.push(asset);
      else if (asset.kind === 'audio') audio.push(asset);
      else video.push(asset);
    }
    return { video, audio, missing };
  }, [desk.assets]);

  const selectedAsset = desk.assets.find((asset) => asset.id === selected) ?? null;
  const addBlocked =
    selectedAsset === null
      ? t`先选一个素材`
      : selectedAsset.duration_seconds === null
        ? t`还没读到这个素材的时长，读完才能放到时间轴上`
        : service.blocked
          ? service.buttonProps.disabledReason
          : undefined;

  const renderRow = (asset: MediaAsset) => {
    const state = stateOf(asset);
    const spec = formatVideoSpec(asset);
    return (
      <li key={asset.id}>
        <button
          type="button"
          className={cx(
            'flex w-full flex-col gap-0.5 rounded px-3 py-2 text-start text-sm',
            'hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-accent',
            asset.id === selected && 'bg-neutral-100',
          )}
          aria-pressed={asset.id === selected}
          data-asset={asset.id}
          data-state={state}
          onClick={() => setSelected(asset.id)}
          onDoubleClick={() => desk.addAssetToTimeline(asset.id)}
        >
          <span className="truncate">{asset.name}</span>
          <span className="font-mono text-2xs text-neutral-700">
            {state === 'missing' ? (
              <Trans>需要重新定位</Trans>
            ) : state === 'pending' ? (
              <Trans>读取中</Trans>
            ) : (
              [formatClockDuration(asset.duration_seconds), spec, formatBytes(asset.file_size)]
                .filter((part) => part !== null)
                .join(' · ')
            )}
          </span>
        </button>
      </li>
    );
  };

  return (
    <section className="flex min-h-0 flex-col gap-2" aria-label={t`素材库`}>
      <h2 className="px-3 pt-3 text-sm font-medium">
        <Trans>素材库</Trans>
      </h2>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {desk.assets.length === 0 ? (
          <EmptyState
            title={t`还没有素材`}
            description={t`导入本地的视频或音频，它们会成为这个工程可用的素材。`}
            actions={
              <Button variant="secondary" onClick={desk.importAssets} disabled={desk.importing}>
                <Trans>导入素材</Trans>
              </Button>
            }
          />
        ) : (
          <>
            {groups.video.length === 0 ? null : <ul className="px-1">{groups.video.map(renderRow)}</ul>}
            {groups.audio.length === 0 ? null : (
              <>
                <h3 className="px-3 pt-2 text-2xs text-neutral-700">
                  <Trans>音频</Trans>
                </h3>
                <ul className="px-1">{groups.audio.map(renderRow)}</ul>
              </>
            )}
            {groups.missing.length === 0 ? null : (
              <>
                {/* A state, not a kind — see the module comment. */}
                <h3 className="px-3 pt-2 text-2xs text-fail" data-testid="missing-heading">
                  <Trans>缺失</Trans>
                </h3>
                <ul className="px-1">{groups.missing.map(renderRow)}</ul>
              </>
            )}
          </>
        )}
      </div>

      <div className="flex flex-none flex-wrap gap-2 border-t border-divider p-3">
        <Button variant="secondary" size="sm" onClick={desk.importAssets} disabled={desk.importing}>
          <Trans>导入</Trans>
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={addBlocked !== undefined}
          disabledReason={addBlocked ?? ''}
          onClick={() => {
            if (selectedAsset !== null) desk.addAssetToTimeline(selectedAsset.id);
          }}
        >
          <Trans>添加到时间轴</Trans>
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled
          disabledReason={t`重新定位需要挑选替换文件，这一版还没有接上文件对话框`}
        >
          <Trans>重新定位</Trans>
        </Button>
      </div>
    </section>
  );
}

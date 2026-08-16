/*
 * pages/montage — 双击裁切, and the entrance that is not a double-click.
 *
 * The artboard's panel head says 「拖拽排序 · 双击裁切」. A double-click is
 * neither discoverable nor reachable from the keyboard, so it is *an*
 * accelerator here and never the only way in: the strip's head carries a
 * 「裁切」 button for the selected clip, and this drawer is what both open.
 *
 * A Drawer, not a Dialog: 「补齐 · 规范与状态」 gives Drawer 「详情与非阻断编辑」,
 * and trimming is exactly that — the strip and the beat table stay visible and
 * legible behind it, which is the point, because the numbers being edited are
 * what those two are drawn from.
 *
 * ── Why the in/out points are numbers and not a dragged waveform ──────────
 *
 * The peaks come from `getRecordedClipWaveform`, which decodes the take — a
 * real cost, cached afterwards — and they are drawn here as the *context* for
 * the two numbers, with the kept region lit by `Waveform`'s `inPoint` /
 * `outPoint`. Dragging the handles is 「10 多轨编辑器」's job; this page's
 * contract is that trimming is completable from the keyboard, and two numeric
 * fields are the form that is.
 *
 * The video element is a real preview: the Tauri CSP allows the
 * `vibe-cs-media:` scheme and `bridge.rs` whitelists
 * `/recorded-clips/{id}/stream`, so `useNativeShell().mediaSrc` produces a
 * source the shipped app can load. Outside the desktop shell it answers `null`
 * and the placeholder says why rather than rendering a broken player.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useEffect, useState } from 'react';

import { Drawer, Notice } from '../../design/feedback';
import { Button, Field, TextInput } from '../../design/primitives';
import { useRecordedClipWaveform } from '../../data/mediaAssets';
import { useNativeShell } from '../../data/nativeShell';
import { Waveform } from '../../domain/media';
import type { MontageClipRecord } from '../../shared/desktop/dto';
import type { RecordedClip } from '../../shared/desktop/viewModels';
import { formatMontageTimecode } from './montageContract';
import { editClipTrim } from './montageSettings';
import type { MontageEditFn } from '../../data/montage';

export interface ClipTrimDrawerProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly clip: MontageClipRecord | null;
  /** The take behind it. `null` when the recording is gone. */
  readonly take: RecordedClip | null;
  readonly onSave: (edit: MontageEditFn) => void;
  readonly onRemove: () => void;
  readonly saving: boolean;
}

export function ClipTrimDrawer({ open, onClose, clip, take, onSave, onRemove, saving }: ClipTrimDrawerProps) {
  const shell = useNativeShell();
  const [start, setStart] = useState('0');
  const [end, setEnd] = useState('');

  const clipId = clip?.clip_id ?? null;
  /*
   * Seeded when the drawer opens on a clip, and **not** on every change to the
   * document: a refetch triggered by some other panel's save must not overwrite
   * a number the user is halfway through typing. `open` is in the dependencies
   * so closing and reopening the same clip re-reads what was saved.
   */
  useEffect(() => {
    if (!open || clip === null) return;
    setStart(String(clip.trim_start));
    setEnd(clip.trim_end === null ? '' : String(clip.trim_end));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipId, open]);

  const waveform = useRecordedClipWaveform(open && clipId !== null ? clipId : null);

  if (clip === null) return null;

  const sourceSeconds = take?.duration_seconds ?? null;
  const parsedStart = Number(start);
  /* An empty 出点 is 「到素材末尾」 — a real value, not 「未填」. */
  const parsedEnd = end.trim() === '' ? null : Number(end);

  const invalid =
    !Number.isFinite(parsedStart) ||
    parsedStart < 0 ||
    (parsedEnd !== null && (!Number.isFinite(parsedEnd) || parsedEnd <= parsedStart)) ||
    (sourceSeconds !== null && parsedStart >= sourceSeconds) ||
    (sourceSeconds !== null && parsedEnd !== null && parsedEnd > sourceSeconds);

  const kept = parsedEnd ?? sourceSeconds;
  const keptSeconds = kept === null || invalid ? null : kept - parsedStart;
  const src = take === null ? null : shell.mediaSrc(take.stream_url);

  return (
    <Drawer
      open={open}
      title={<Trans>裁切片段</Trans>}
      description={clip.title ?? take?.title ?? clip.clip_id}
      onClose={onClose}
      footer={
        <>
          <Button
            variant="danger"
            size="md"
            data-montage-action="remove-clip"
            disabled={saving}
            onClick={onRemove}
          >
            <Trans>从合辑中移除</Trans>
          </Button>
          <Button
            variant="primary"
            size="md"
            data-montage-action="save-trim"
            disabled={invalid || saving}
            {...(invalid ? { disabledReason: t`入点与出点必须落在素材长度之内，且出点在入点之后` } : {})}
            onClick={() => {
              onSave(editClipTrim(clip.clip_id, { trimStart: parsedStart, trimEnd: parsedEnd }));
              onClose();
            }}
          >
            <Trans>保存裁切</Trans>
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {take === null ? (
          <Notice tone="warning" action={{ label: <Trans>移除这一段</Trans>, onAction: onRemove }}>
            <Trans>这一段对应的录制结果已经不在了，无法预览或裁切。</Trans>
          </Notice>
        ) : null}

        {src === null ? (
          <p className="border border-divider p-3 text-xs text-neutral-600">
            <Trans>预览需要桌面应用，浏览器里无法读取本机录制文件。</Trans>
          </p>
        ) : (
          /* No caption track: a gameplay take has none, and an empty one would
             be a promise of subtitles that are not there. */
          <video
            data-montage-preview="clip"
            src={src}
            controls
            preload="metadata"
            className="w-full border border-divider"
          />
        )}

        <Waveform
          peaks={waveform.data?.waveform ?? []}
          durationSeconds={sourceSeconds ?? 0}
          loading={waveform.isPending}
          inPoint={Number.isFinite(parsedStart) ? parsedStart : 0}
          {...(parsedEnd !== null && Number.isFinite(parsedEnd) ? { outPoint: parsedEnd } : {})}
          label={t`这一段素材的波形`}
        />

        <div className="flex gap-3">
          <Field
            label={<Trans>入点（秒）</Trans>}
            className="flex-1"
            {...(invalid ? { error: <Trans>超出素材范围</Trans> } : {})}
          >
            {(control) => (
              <TextInput
                {...control}
                mono
                inputMode="decimal"
                data-montage-field="trim-start"
                value={start}
                onChange={(event) => setStart(event.target.value)}
              />
            )}
          </Field>
          <Field
            label={<Trans>出点（秒）</Trans>}
            className="flex-1"
            hint={<Trans>留空表示用到素材末尾</Trans>}
          >
            {(control) => (
              <TextInput
                {...control}
                mono
                inputMode="decimal"
                data-montage-field="trim-end"
                value={end}
                onChange={(event) => setEnd(event.target.value)}
              />
            )}
          </Field>
        </div>

        <dl className="flex flex-col gap-1 text-xs text-neutral-700">
          {sourceSeconds === null ? null : (
            <div className="flex justify-between">
              <dt>
                <Trans>素材长度</Trans>
              </dt>
              <dd className="font-mono">{formatMontageTimecode(sourceSeconds)}</dd>
            </div>
          )}
          {keptSeconds === null ? null : (
            <div className="flex justify-between">
              <dt>
                <Trans>保留时长</Trans>
              </dt>
              <dd className="font-mono">{formatMontageTimecode(keptSeconds)}</dd>
            </div>
          )}
        </dl>
      </div>
    </Drawer>
  );
}

/*
 * pages/editor — 属性, the artboard's right column.
 *
 *   属性 · Aurora_R13_ace
 *   时间   入点 00:00:04:08   出点 00:00:32:02   速度 100%
 *   画面   缩放 104%          不透明度 100%
 *   音频   音量 -6.0 dB       与视频链接
 *   调色   原始 · 冷调 · 高对比
 *   [存为预设]
 *
 * ── what is editable here, and what is only readable ──────────────────────
 *
 * **Editable:** 入点 / 出点 (through `trimClip`) and 速度 (`setClipSpeed`).
 * Both are timeline operations, both go through the same undo stack as the
 * pointer gestures, and both refuse for the same reasons with the same words.
 *
 * **Readable only:** 缩放, 不透明度, 音量, 与视频链接, 调色. These live in
 * `EditorClip.transform` / `volume` / `link_group_id` / `effects` — fields the
 * *timeline model does not carry*, by design (see `editorDocument.ts`). Making
 * them editable means either putting them into the model, where every edit
 * operation would have to be taught to ignore them, or writing a second edit
 * path that mutates the shadow directly and does not appear in the undo stack.
 *
 * Neither is worth doing blind, so this round shows the stored values and says
 * they are read-only. That is the honest position: the numbers are real, they
 * came from the document, and the export uses them. What is missing is a
 * control, and a control is a smaller gap than a second undo stack.
 *
 * The one exception is 调色, which *is* wired — through 「应用预设」 rather than
 * through sliders, because the service has a route for exactly that
 * (`applyEditorPreset`) which does the edit server-side and answers the new
 * document. No shadow mutation, no second undo stack: the project is replaced.
 *
 * ── the dB readout ────────────────────────────────────────────────────────
 *
 * `EditorClip.volume` is a linear gain in 0…4; the artboard prints 「-6.0 dB」.
 * `20·log₁₀(gain)` is the conversion, and gain 0 is not −∞ dB on screen but
 * 「静音」 — a readout that says `-Infinity dB` is a bug report waiting to
 * happen.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Fragment, useMemo, useState } from 'react';

import { Empty } from '../../design/data';
import { Button, Field, Input, cn } from '../../design/primitives';
import { clipSourceOut, formatFrameTimecode } from '../../design/timeline';
import { clipAllows, clipRestrictions } from './editorDocument';
import { firstRestrictionMessage } from './editorMessages';
import type { EditorPanelProps } from './editorContract';

/** Linear gain → the artboard's dB reading. */
export function formatGainDb(gain: number): string {
  if (gain <= 0) return '静音';
  return `${(20 * Math.log10(gain)).toFixed(1)} dB`;
}

/** `104%` from a 1.04 scale factor. */
function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function InspectorPanel({ desk, service }: EditorPanelProps) {
  const { editor, document } = desk;
  const [speedDraft, setSpeedDraft] = useState<string | null>(null);

  const clipId = editor.selectedClipId;
  const clip = useMemo(
    () => (clipId === null ? null : (editor.timeline.clips.find((each) => each.id === clipId) ?? null)),
    [clipId, editor.timeline.clips],
  );
  const wire = clipId === null || document === null ? null : (document.clips.get(clipId) ?? null);

  if (clip === null || wire === null || document === null) {
    return (
      <section className="p-3" aria-label={t`属性`}>
        <Empty
          title={t`没有选中片段`}
          description={t`在时间轴上点一个片段，它的入出点、速度与画面参数会出现在这里。`}
          actions={null}
        />
      </section>
    );
  }

  const restrictions = clipRestrictions(document, clip.id);
  const restrictionReason = firstRestrictionMessage(restrictions);
  const speedAllowed = clipAllows(document, clip.id, 'speed');
  const trimAllowed = clipAllows(document, clip.id, 'trim');
  const speedBlocked = !speedAllowed || service.blocked;

  const commitSpeed = () => {
    if (speedDraft === null) return;
    const percent = Number(speedDraft.replace('%', '').trim());
    setSpeedDraft(null);
    if (!Number.isFinite(percent)) return;
    editor.setSelectionSpeed(percent / 100);
  };

  return (
    <section className="flex min-h-0 flex-col gap-4 overflow-y-auto p-3" aria-label={t`属性`}>
      <h2 className="truncate text-sm font-medium" data-testid="inspector-title">
        <Trans>属性 · {clip.label}</Trans>
      </h2>

      {/* ── 时间 ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        <h3 className="text-2xs text-neutral-700">
          <Trans>时间</Trans>
        </h3>
        <dl className="grid grid-cols-2 gap-1 text-xs">
          <dt className="text-neutral-700">
            <Trans>入点</Trans>
          </dt>
          <dd className="font-mono" data-testid="inspector-source-in">
            {formatFrameTimecode(clip.sourceIn, editor.timeline.fps)}
          </dd>
          <dt className="text-neutral-700">
            <Trans>出点</Trans>
          </dt>
          <dd className="font-mono" data-testid="inspector-source-out">
            {formatFrameTimecode(clipSourceOut(clip), editor.timeline.fps)}
          </dd>
          <dt className="text-neutral-700">
            <Trans>时长</Trans>
          </dt>
          <dd className="font-mono">{formatFrameTimecode(clip.duration, editor.timeline.fps)}</dd>
        </dl>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={!trimAllowed}
            disabledReason={restrictionReason ?? t`当前片段已到可用裁切边界`}
            onClick={() => editor.trimSelection('in', -1 / editor.timeline.fps)}
            aria-label={t`入点前移一帧`}
          >
            ⟨ <Trans>入点</Trans>
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={!trimAllowed}
            disabledReason={restrictionReason ?? t`当前片段已到可用裁切边界`}
            onClick={() => editor.trimSelection('in', 1 / editor.timeline.fps)}
            aria-label={t`入点后移一帧`}
          >
            <Trans>入点</Trans> ⟩
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={!trimAllowed}
            disabledReason={restrictionReason ?? t`当前片段已到可用裁切边界`}
            onClick={() => editor.trimSelection('out', -1 / editor.timeline.fps)}
            aria-label={t`出点前移一帧`}
          >
            ⟨ <Trans>出点</Trans>
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={!trimAllowed}
            disabledReason={restrictionReason ?? t`当前片段已到可用裁切边界`}
            onClick={() => editor.trimSelection('out', 1 / editor.timeline.fps)}
            aria-label={t`出点后移一帧`}
          >
            <Trans>出点</Trans> ⟩
          </Button>
        </div>

        <Field label={<Trans>速度</Trans>} hint={t`5% 到 1600%`}>
          {(control) => (
            <Input
              {...control}
              value={speedDraft ?? formatPercent(clip.speed)}
              disabled={speedBlocked}
              data-testid="inspector-speed"
              onChange={(event) => setSpeedDraft(event.target.value)}
              onBlur={commitSpeed}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitSpeed();
                if (event.key === 'Escape') setSpeedDraft(null);
              }}
            />
          )}
        </Field>
        {speedAllowed ? null : (
          <p className="text-2xs text-warn" data-testid="inspector-speed-reason">
            {restrictionReason ?? t`请在支持变速的片段上调整速度`}
          </p>
        )}
      </div>

      {/* ── 画面 ─────────────────────────────────────────────────────────── */}
      <ReadOnlyGroup
        title={<Trans>画面</Trans>}
        rows={[
          [<Trans key="scale">缩放</Trans>, formatPercent(wire.transform.scale_x)],
          [<Trans key="opacity">不透明度</Trans>, formatPercent(wire.transform.opacity)],
          [
            <Trans key="position">位置</Trans>,
            `${Math.round(wire.transform.x)}, ${Math.round(wire.transform.y)}`,
          ],
        ]}
      />

      {/* ── 音频 ─────────────────────────────────────────────────────────── */}
      <ReadOnlyGroup
        title={<Trans>音频</Trans>}
        rows={[
          [<Trans key="volume">音量</Trans>, formatGainDb(wire.volume)],
          [
            <Trans key="link">与视频链接</Trans>,
            wire.link_group_id === null ? t`未链接` : t`已链接`,
          ],
        ]}
      />
      <Button
        variant="secondary"
        size="sm"
        disabled={wire.asset_id === null || wire.text !== null || service.blocked}
        disabledReason={t`只有引用了视频素材的片段可以分离音频`}
        onClick={desk.separateAudio}
      >
        <Trans>分离音频</Trans>
      </Button>

      {/* ── 调色 ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        <h3 className="text-2xs text-neutral-700">
          <Trans>调色</Trans>
        </h3>
        {desk.presets.length === 0 ? (
          <p className="text-2xs text-neutral-700">
            <Trans>还没有存过预设</Trans>
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {desk.presets.map((preset) => (
              <Button
                key={preset.id}
                variant="secondary"
                size="sm"
                disabled={service.blocked || desk.saveState === 'unsaved'}
                disabledReason={
                  desk.saveState === 'unsaved'
                    ? t`先保存当前改动，再应用预设`
                    : (service.buttonProps.disabledReason ?? '')
                }
                onClick={() => desk.applyPreset(preset.id)}
              >
                {preset.name}
              </Button>
            ))}
          </div>
        )}
        <Button variant="secondary" size="sm" disabled disabledReason={t`暂不支持存为预设`}>
          <Trans>存为预设</Trans>
        </Button>
      </div>
    </section>
  );
}

function ReadOnlyGroup({
  title,
  rows,
}: {
  readonly title: React.ReactNode;
  readonly rows: ReadonlyArray<readonly [React.ReactNode, string]>;
}) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-2xs text-neutral-700">
        {title}
        {/* Every value here is real and comes from the document; what is
            missing is a control, not the data. Saying so beats a group of
            inputs that look editable and are not. */}
        <span className={cn('ms-2', 'text-neutral-600')}>
          <Trans>只读</Trans>
        </span>
      </h3>
      <dl className="grid grid-cols-2 gap-1 text-xs">
        {rows.map(([label, value], index) => (
          <Fragment key={index}>
            <dt className="text-neutral-700">{label}</dt>
            <dd className="font-mono">{value}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}

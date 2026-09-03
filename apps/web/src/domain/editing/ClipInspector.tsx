import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Diamond, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button, cn } from '../../design/primitives';
import { DEFAULT_EDITOR_TEXT_BACKGROUND, DEFAULT_EDITOR_TEXT_COLOR } from '../../design/timeline';
import type {
  EditorKeyframeInterpolation,
  EditorKeyframeProperty,
  EditorTransitionKind,
  TimelineClip,
  TimelineTrack,
} from '../../shared/desktop/dto';
import {
  createEditorEffect,
  EDITOR_EFFECT_SCHEMAS,
  editorEffectParameter,
  isSupportedEditorEffectKind,
  moveEditorEffect,
  setEditorEffectParameter,
  type SupportedEditorEffectKind,
} from './effectEditing';
import {
  canAnimateTransformProperty,
  clipKeyframeAtTime,
  clipLocalTimeAtTimeline,
  evaluateClipKeyframeProperty,
  removeClipKeyframe,
  setClipPanAtTime,
  setClipVolumeAtTime,
  upsertClipKeyframe,
} from './keyframeEditing';
import { sameTimelineClip } from './timelineEditing';
import {
  clipSourceTimeAtLocalTime,
  disableClipTimeRemapping,
  enableClipTimeRemapping,
  MAX_TIMELINE_CLIP_SPEED,
  MIN_TIMELINE_CLIP_SPEED,
  rateStretchTimelineClip,
  removeClipSpeedBoundary,
  setClipSpeedSegmentSpeed,
  snapTimeToFrame,
  splitClipSpeedSegment,
} from './timelineInteraction';
export function ClipInspector({
  selected,
  readOnly,
  timelineTimeSeconds,
  fps,
  onSeek,
  onReplace,
}: {
  readonly selected: { readonly track: TimelineTrack; readonly clip: TimelineClip } | null;
  readonly readOnly: boolean;
  readonly timelineTimeSeconds: number;
  readonly fps: number;
  readonly onSeek: (seconds: number) => void;
  readonly onReplace: (clip: TimelineClip) => void;
}) {
  const [draft, setDraft] = useState<TimelineClip | null>(selected?.clip ?? null);
  const [effectKind, setEffectKind] = useState<SupportedEditorEffectKind>('color_adjust');
  useEffect(() => setDraft(selected?.clip ?? null), [selected?.clip]);
  if (draft === null) {
    return <aside className="flex items-center justify-center border-l border-divider p-5 text-sm text-neutral-600"><Trans>选择片段后编辑</Trans></aside>;
  }
  const localTime = clipLocalTimeAtTimeline(draft, timelineTimeSeconds, fps);
  const keyframeTimes = [...new Set(draft.keyframes.map((keyframe) => keyframe.time))].sort((left, right) => left - right);
  const currentFrameKeyframes = draft.keyframes.filter((keyframe) => Math.abs(keyframe.time - localTime) <= 0.5 / fps);
  const previousKeyframeTime = [...keyframeTimes].reverse().find((time) => time < localTime - 0.5 / fps);
  const nextKeyframeTime = keyframeTimes.find((time) => time > localTime + 0.5 / fps);
  const visualProperties: Array<{
    readonly property: Exclude<EditorKeyframeProperty, 'volume' | 'pan'>;
    readonly label: string;
    readonly step: number;
    readonly min?: number;
    readonly max?: number;
  }> = selected?.track.kind === 'audio'
    ? []
    : draft.text !== null
      ? [
        { property: 'x', label: t`位置 X`, step: 1 },
        { property: 'y', label: t`位置 Y`, step: 1 },
        { property: 'opacity', label: t`透明度`, step: 0.01, min: 0, max: 1 },
      ]
      : [
        { property: 'x', label: t`位置 X`, step: 1 },
        { property: 'y', label: t`位置 Y`, step: 1 },
        { property: 'scale_x', label: t`水平缩放`, step: 0.01, min: 0.01, max: 10 },
        { property: 'scale_y', label: t`垂直缩放`, step: 0.01, min: 0.01, max: 10 },
        { property: 'rotation', label: t`旋转`, step: 1 },
        { property: 'opacity', label: t`透明度`, step: 0.01, min: 0, max: 1 },
      ];
  const hasUnsupportedEnabledEffect = draft.effects.some((effect) => effect.enabled && !isSupportedEditorEffectKind(effect.kind));
  const draftChanged = selected !== null
    && draft.id === selected.clip.id
    && !sameTimelineClip(draft, selected.clip);
  const textStyle = draft.text;
  const mediaKind = typeof draft.metadata === 'object' && draft.metadata !== null && !Array.isArray(draft.metadata)
    && typeof draft.metadata.media_kind === 'string'
    ? draft.metadata.media_kind.toLowerCase()
    : '';
  const canTimeRemap = draft.text === null
    && selected?.track.kind !== 'text'
    && selected?.track.kind !== 'caption'
    && !mediaKind.startsWith('image');
  const speedBoundaryAtPlayhead = draft.speed_segments.some((segment) => (
    Math.abs(segment.start - localTime) <= 0.5 / fps || Math.abs(segment.end - localTime) <= 0.5 / fps
  ));
  return (
    <div className="min-h-0" aria-label={t`片段属性`}>
      <label className="flex flex-col gap-1 text-xs">
        <Trans>名称</Trans>
        <input disabled={readOnly} className="border border-divider px-2 py-1.5" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })} />
      </label>
      {(['duration', 'source_in', 'source_out', 'speed'] as const).map((field) => (
        <label key={field} className="mt-3 flex flex-col gap-1 text-xs">
          {field}
          <input
            type="number"
            step="0.1"
            className="border border-divider px-2 py-1.5 font-mono"
            disabled={readOnly
              || draft.speed_segments.length > 0
              || (draft.placement.frame_hold_source_time !== null && field !== 'duration')}
            value={field === 'speed' && draft.placement.reverse ? -draft.placement.speed : draft.placement[field]}
            onChange={(event) => setDraft(updateClipTimingField(draft, field, Number(event.currentTarget.value), fps))}
          />
        </label>
      ))}
      {draft.text !== null || selected?.track.kind === 'text' || selected?.track.kind === 'caption' ? null : (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={draft.placement.reverse}
              disabled={readOnly || draft.speed_segments.length > 0 || draft.placement.frame_hold_source_time !== null}
              onChange={(event) => setDraft({ ...draft, placement: { ...draft.placement, reverse: event.currentTarget.checked } })}
            />
            <Trans>反向播放</Trans>
          </label>
          <Button
            size="sm"
            variant={draft.placement.frame_hold_source_time === null ? 'secondary' : 'primary'}
            disabled={readOnly || draft.speed_segments.length > 0 || selected?.track.kind === 'audio'}
            onClick={() => setDraft({
              ...draft,
              placement: {
                ...draft.placement,
                reverse: false,
                frame_hold_source_time: draft.placement.frame_hold_source_time === null
                  ? clipSourceTimeAtLocalTime(draft, localTime)
                  : null,
              },
            })}
          >
            {draft.placement.frame_hold_source_time === null ? <Trans>定格当前帧</Trans> : <Trans>取消定格</Trans>}
          </Button>
        </div>
      )}
      {!canTimeRemap ? null : (
        <section className="mt-4 border-t border-divider pt-3" aria-label={t`时间重映射`}>
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-semibold"><Trans>时间重映射</Trans></h3>
            {draft.speed_segments.length === 0 ? (
              <Button
                className="ml-auto"
                size="sm"
                variant="secondary"
                disabled={readOnly || draft.placement.reverse || draft.placement.frame_hold_source_time !== null}
                onClick={() => setDraft(enableClipTimeRemapping(draft, globalThis.crypto.randomUUID()))}
              >
                <Trans>启用</Trans>
              </Button>
            ) : (
              <Button
                className="ml-auto"
                size="sm"
                variant="ghost"
                disabled={readOnly}
                onClick={() => setDraft(disableClipTimeRemapping(draft))}
              >
                <Trans>恢复恒定速度</Trans>
              </Button>
            )}
          </div>
          {draft.speed_segments.length === 0 ? (
            <p className="mt-2 text-2xs leading-4 text-neutral-500"><Trans>启用后可在播放头添加速度关键帧，并分别调整片段各区间的速度。</Trans></p>
          ) : (
            <>
              <Button
                className="mt-2 w-full"
                size="sm"
                variant="secondary"
                disabled={readOnly
                  || localTime <= 0.5 / fps
                  || localTime >= draft.placement.duration - 0.5 / fps
                  || speedBoundaryAtPlayhead}
                onClick={() => setDraft(splitClipSpeedSegment(
                  draft,
                  localTime,
                  globalThis.crypto.randomUUID(),
                  fps,
                ))}
              >
                <Plus className="size-3.5" aria-hidden="true" />
                <Trans>在播放头添加速度关键帧</Trans>
              </Button>
              <ol className="mt-2 list-none space-y-1.5">
                {draft.speed_segments.map((segment, index) => (
                  <li
                    key={segment.id}
                    className="grid grid-cols-[minmax(0,1fr)_90px_28px] items-center gap-2 border border-divider bg-neutral-50 px-2 py-1.5"
                    data-speed-segment-id={segment.id}
                  >
                    <span className="min-w-0 truncate font-mono text-2xs text-neutral-600">
                      {segment.start.toFixed(3)}–{segment.end.toFixed(3)}s
                    </span>
                    <label className="flex min-w-0 items-center gap-1 text-2xs">
                      <span className="sr-only"><Trans>区间速度</Trans></span>
                      <input
                        type="number"
                        min={MIN_TIMELINE_CLIP_SPEED * 100}
                        max={MAX_TIMELINE_CLIP_SPEED * 100}
                        step={1}
                        className="min-w-0 flex-1 border border-divider bg-bg px-1.5 py-1 text-right font-mono"
                        aria-label={t`区间 ${index + 1} 速度百分比`}
                        disabled={readOnly}
                        value={Number((segment.speed * 100).toFixed(3))}
                        onChange={(event) => setDraft(setClipSpeedSegmentSpeed(
                          draft,
                          segment.id,
                          event.currentTarget.valueAsNumber / 100,
                          fps,
                        ))}
                      />
                      <span>%</span>
                    </label>
                    <button
                      type="button"
                      className="grid size-7 place-items-center rounded-sm text-fail-text hover:bg-fail-surface disabled:text-neutral-300"
                      aria-label={t`删除区间 ${index + 1} 前的速度关键帧`}
                      disabled={readOnly || index === 0}
                      onClick={() => setDraft(removeClipSpeedBoundary(draft, segment.id))}
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ol>
              <p className="mt-2 text-2xs leading-4 text-neutral-500"><Trans>调整区间速度会改变该区间和片段时长，但保持源 In/Out 不变；Story 后续片段将在保存时波纹移动。</Trans></p>
            </>
          )}
        </section>
      )}
      {draft.capture_intent === null ? null : (
        <section className="mt-4 border-t border-divider pt-3" aria-label={t`录制范围`}>
          <h3 className="text-xs font-semibold"><Trans>录制范围</Trans></h3>
          <label className="mt-2 flex flex-col gap-1 text-xs">
            <Trans>录制视角</Trans>
            <select
              className="border border-divider bg-bg px-2 py-1.5"
              disabled={readOnly}
              value={draft.capture_intent.camera_style}
              aria-label={t`录制视角`}
              onChange={(event) => setDraft(updateCaptureIntent(draft, {
                camera_style: event.currentTarget.value as NonNullable<TimelineClip['capture_intent']>['camera_style'],
              }))}
            >
              <option value="pov"><Trans>第一人称</Trans></option>
              <option value="static"><Trans>固定机位</Trans></option>
              <option value="tracking"><Trans>跟随</Trans></option>
              <option value="dolly"><Trans>推轨</Trans></option>
              <option value="orbit"><Trans>环绕</Trans></option>
              <option value="crane"><Trans>升降</Trans></option>
              <option value="flyby"><Trans>掠过</Trans></option>
            </select>
          </label>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <CaptureIntentNumberField label={t`开始 tick`} value={draft.capture_intent.start_tick} step={1} readOnly={readOnly} onChange={(value) => setDraft(updateCaptureIntent(draft, { start_tick: Math.max(0, Math.trunc(value)) }))} />
            <CaptureIntentNumberField label={t`结束 tick`} value={draft.capture_intent.end_tick} step={1} readOnly={readOnly} onChange={(value) => setDraft(updateCaptureIntent(draft, { end_tick: Math.max(0, Math.trunc(value)) }))} />
            <CaptureIntentNumberField label={t`前留白（秒）`} value={draft.capture_intent.pre_roll_seconds} step={0.1} readOnly={readOnly} onChange={(value) => setDraft(updateCaptureIntent(draft, { pre_roll_seconds: Math.max(0, value) }))} />
            <CaptureIntentNumberField label={t`后留白（秒）`} value={draft.capture_intent.post_roll_seconds} step={0.1} readOnly={readOnly} onChange={(value) => setDraft(updateCaptureIntent(draft, { post_roll_seconds: Math.max(0, value) }))} />
          </div>
          <span className="mt-1 block text-2xs text-neutral-500"><Trans>非第一人称视角需要片段范围内至少四个空间采样点；回合边界镜头应在回合结束前停止。</Trans></span>
          {draft.material.kind === 'planned' ? null : (
            <Button
              className="mt-2 w-full"
              size="sm"
              variant="secondary"
              disabled={readOnly}
              onClick={() => onReplace({ ...draft, material: { kind: 'planned' } })}
            >
              <Trans>重新录制（保留旧文件）</Trans>
            </Button>
          )}
        </section>
      )}
      {textStyle === null ? null : (
        <section className="mt-4 border-t border-divider pt-3" aria-label={t`文字样式`}>
          <h3 className="text-xs font-semibold"><Trans>文字样式</Trans></h3>
          <label className="mt-2 flex flex-col gap-1 text-xs">
            <Trans>文字内容</Trans>
            <textarea
              rows={4}
              maxLength={1_000}
              className="resize-y border border-divider bg-bg px-2 py-1.5"
              disabled={readOnly}
              value={textStyle.content}
              onChange={(event) => setDraft({ ...draft, text: { ...textStyle, content: event.currentTarget.value } })}
            />
          </label>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-xs">
              <Trans>字体</Trans>
              <input
                className="border border-divider bg-bg px-2 py-1.5"
                disabled={readOnly}
                value={textStyle.font_family}
                onChange={(event) => setDraft({ ...draft, text: { ...textStyle, font_family: event.currentTarget.value } })}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <Trans>字号</Trans>
              <input
                type="number"
                min={6}
                max={512}
                step={1}
                className="border border-divider bg-bg px-2 py-1.5 font-mono"
                disabled={readOnly}
                value={textStyle.font_size}
                onChange={(event) => setDraft({ ...draft, text: { ...textStyle, font_size: Number(event.currentTarget.value) } })}
              />
            </label>
            <label className="flex items-center gap-2 text-xs">
              <Trans>文字颜色</Trans>
              <input
                type="color"
                aria-label={t`文字颜色`}
                disabled={readOnly}
                value={htmlColorInputValue(textStyle.color, DEFAULT_EDITOR_TEXT_COLOR)}
                onChange={(event) => setDraft({ ...draft, text: { ...textStyle, color: event.currentTarget.value.toUpperCase() } })}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <Trans>对齐</Trans>
              <select
                className="border border-divider bg-bg px-2 py-1.5"
                disabled={readOnly}
                value={textStyle.align}
                onChange={(event) => setDraft({ ...draft, text: { ...textStyle, align: event.currentTarget.value } })}
              >
                <option value="left"><Trans>左对齐</Trans></option>
                <option value="center"><Trans>居中</Trans></option>
                <option value="right"><Trans>右对齐</Trans></option>
              </select>
            </label>
          </div>
          <label className="mt-2 flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              disabled={readOnly}
              checked={textStyle.background !== null}
              onChange={(event) => setDraft({
                ...draft,
                text: { ...textStyle, background: event.currentTarget.checked ? DEFAULT_EDITOR_TEXT_BACKGROUND : null },
              })}
            />
            <Trans>启用文字背景</Trans>
          </label>
          {textStyle.background === null ? null : (
            <label className="mt-2 flex items-center gap-2 text-xs">
              <Trans>背景颜色</Trans>
              <input
                type="color"
                aria-label={t`背景颜色`}
                disabled={readOnly}
                value={htmlColorInputValue(textStyle.background, DEFAULT_EDITOR_TEXT_BACKGROUND)}
                onChange={(event) => setDraft({ ...draft, text: { ...textStyle, background: event.currentTarget.value.toUpperCase() } })}
              />
            </label>
          )}
        </section>
      )}
      {draft.text !== null || selected?.track.kind === 'text' || selected?.track.kind === 'caption' ? null : (() => {
        const audioProperties = [
          { property: 'volume' as const, label: t`音量`, min: 0, max: 4, step: 0.01, fallback: draft.placement.volume },
          { property: 'pan' as const, label: t`声像`, min: -1, max: 1, step: 0.01, fallback: draft.placement.pan },
        ];
        return (
          <section className="mt-4 border-t border-divider pt-3" aria-label={t`音频自动化`}>
            {audioProperties.map(({ property, label, min, max, step, fallback }) => {
              const propertyKeyframes = draft.keyframes.filter((keyframe) => keyframe.property === property);
              const current = clipKeyframeAtTime(draft, property, localTime, fps);
              const value = evaluateClipKeyframeProperty(draft, property, localTime, fallback);
              return <div key={property} className="mt-2 grid grid-cols-[minmax(0,1fr)_88px_28px] items-center gap-2 text-xs">
                <span>{label}{propertyKeyframes.length === 0 ? null : <span className="ml-1 text-2xs text-neutral-500">{propertyKeyframes.length}</span>}</span>
                <input
                  type="number"
                  min={min}
                  max={max}
                  step={step}
                  className="min-w-0 border border-divider px-2 py-1.5 font-mono"
                  disabled={readOnly}
                  value={value}
                  aria-label={label}
                  onChange={(event) => setDraft(property === 'volume'
                    ? setClipVolumeAtTime(draft, localTime, Number(event.currentTarget.value), fps, globalThis.crypto.randomUUID())
                    : setClipPanAtTime(draft, localTime, Number(event.currentTarget.value), fps, globalThis.crypto.randomUUID()))}
                />
                <button
                  type="button"
                  className={cn(
                    'grid size-7 place-items-center rounded-sm border border-divider hover:bg-neutral-100 disabled:text-neutral-300',
                    current !== null && 'border-accent-300 bg-accent-100 text-accent-text',
                  )}
                  disabled={readOnly}
                  aria-label={current === null ? t`在播放头添加 ${label} 关键帧` : t`删除播放头的 ${label} 关键帧`}
                  onClick={() => setDraft(current === null
                    ? upsertClipKeyframe(draft, property, localTime, value, globalThis.crypto.randomUUID(), fps)
                    : removeClipKeyframe(draft, property, localTime, fps))}
                >
                  <Diamond className="size-3" fill={current === null ? 'none' : 'currentColor'} aria-hidden="true" />
                </button>
              </div>;
            })}
          </section>
        );
      })()}
      {currentFrameKeyframes.length === 0 ? null : (
        <section className="mt-4 border-t border-divider pt-3" aria-label={t`关键帧插值`}>
          <h3 className="mb-2 text-xs font-semibold"><Trans>关键帧插值</Trans></h3>
          {currentFrameKeyframes.map((keyframe) => (
            <div key={keyframe.id} className="mt-2 grid grid-cols-[minmax(0,1fr)_110px] gap-2 text-xs">
              <span className="truncate font-mono text-2xs">{keyframe.property}</span>
              <select
                className="border border-divider bg-bg px-2 py-1"
                aria-label={t`${keyframe.property} 插值`}
                disabled={readOnly}
                value={keyframe.interpolation}
                onChange={(event) => {
                  const interpolation = event.currentTarget.value as EditorKeyframeInterpolation;
                  setDraft({ ...draft, keyframes: draft.keyframes.map((candidate) => candidate.id === keyframe.id
                    ? { ...candidate, interpolation }
                    : candidate) });
                }}
              >
                <option value="hold"><Trans>保持</Trans></option>
                <option value="linear"><Trans>线性</Trans></option>
                <option value="bezier">Bezier</option>
                <option value="ease_in">Ease In</option>
                <option value="ease_out">Ease Out</option>
                <option value="ease_in_out">Ease In/Out</option>
              </select>
              {keyframe.interpolation !== 'bezier' ? null : (
                <div className="col-span-2 grid grid-cols-2 gap-2">
                  {([
                    ['in_tangent', t`入切线`],
                    ['out_tangent', t`出切线`],
                  ] as const).map(([field, label]) => (
                    <label key={field} className="flex items-center gap-2">
                      <span className="flex-1">{label}</span>
                      <input
                        type="number"
                        step={0.1}
                        className="w-20 border border-divider bg-bg px-2 py-1 font-mono"
                        aria-label={t`${keyframe.property} ${label}`}
                        disabled={readOnly}
                        value={keyframe[field]}
                        onChange={(event) => {
                          const value = Number(event.currentTarget.value);
                          setDraft({ ...draft, keyframes: draft.keyframes.map((candidate) => candidate.id === keyframe.id
                            ? { ...candidate, [field]: value }
                            : candidate) });
                        }}
                      />
                    </label>
                  ))}
                </div>
              )}
            </div>
          ))}
        </section>
      )}
      {visualProperties.length === 0 ? null : (
        <section className="mt-4 border-t border-divider pt-3" aria-label={t`变换与关键帧`}>
          <div className="mb-2 flex items-center gap-2">
            <h3 className="text-xs font-semibold"><Trans>变换</Trans></h3>
            <span className="flex items-center overflow-hidden rounded-sm border border-divider">
              <button
                type="button"
                className="grid size-6 place-items-center hover:bg-neutral-100 disabled:text-neutral-300"
                aria-label={t`上一个关键帧`}
                disabled={previousKeyframeTime === undefined}
                onClick={() => previousKeyframeTime === undefined ? undefined : onSeek(draft.placement.start + previousKeyframeTime)}
              ><ChevronLeft className="size-3" aria-hidden="true" /></button>
              <button
                type="button"
                className="grid size-6 place-items-center border-l border-divider hover:bg-neutral-100 disabled:text-neutral-300"
                aria-label={t`下一个关键帧`}
                disabled={nextKeyframeTime === undefined}
                onClick={() => nextKeyframeTime === undefined ? undefined : onSeek(draft.placement.start + nextKeyframeTime)}
              ><ChevronRight className="size-3" aria-hidden="true" /></button>
            </span>
            <span className="ml-auto font-mono text-2xs text-neutral-500"><Trans>片段内</Trans> {localTime.toFixed(3)}s</span>
          </div>
          {visualProperties.map(({ property, label, step, min, max }) => {
            const propertyKeyframes = draft.keyframes.filter((keyframe) => keyframe.property === property);
            const current = clipKeyframeAtTime(draft, property, localTime, fps);
            const animationAllowed = canAnimateTransformProperty(draft, property);
            const fallback = draft.transform[property];
            const value = evaluateClipKeyframeProperty(draft, property, localTime, fallback);
            return (
              <div key={property} className="mt-2 grid grid-cols-[minmax(0,1fr)_88px_28px] items-center gap-2 text-xs">
                <span className="truncate">{label}{propertyKeyframes.length === 0 ? null : <span className="ml-1 text-2xs text-neutral-500">{propertyKeyframes.length}</span>}</span>
                <input
                  type="number"
                  step={step}
                  {...(min === undefined ? {} : { min })}
                  {...(max === undefined ? {} : { max })}
                  className="min-w-0 border border-divider px-2 py-1.5 font-mono"
                  disabled={readOnly || (!animationAllowed && (property === 'rotation' || propertyKeyframes.length > 0))}
                  value={value}
                  onChange={(event) => {
                    const nextValue = Number(event.currentTarget.value);
                    if (propertyKeyframes.length === 0) {
                      setDraft({ ...draft, transform: { ...draft.transform, [property]: nextValue } });
                    } else {
                      setDraft(upsertClipKeyframe(draft, property, localTime, nextValue, globalThis.crypto.randomUUID(), fps));
                    }
                  }}
                  aria-label={label}
                />
                <button
                  type="button"
                  className={cn(
                    'grid size-7 place-items-center rounded-sm border border-divider hover:bg-neutral-100 disabled:text-neutral-300',
                    current !== null && 'border-accent-300 bg-accent-100 text-accent-text',
                  )}
                  disabled={readOnly || (current === null && !animationAllowed)}
                  aria-label={current === null ? t`在播放头添加 ${label} 关键帧` : t`删除播放头的 ${label} 关键帧`}
                  onClick={() => setDraft(current === null
                    ? upsertClipKeyframe(draft, property, localTime, value, globalThis.crypto.randomUUID(), fps)
                    : removeClipKeyframe(draft, property, localTime, fps))}
                >
                  <Diamond className="size-3" fill={current === null ? 'none' : 'currentColor'} aria-hidden="true" />
                </button>
              </div>
            );
          })}
          {draft.keyframes.some((keyframe) => ['scale_x', 'scale_y', 'rotation'].includes(keyframe.property))
            ? <p className="mt-2 text-2xs text-neutral-500"><Trans>动画缩放与旋转不能同时启用；这是导出渲染器的组合约束。</Trans></p>
            : null}
        </section>
      )}
      {draft.text === null && (selected?.track.kind === 'video' || selected?.track.kind === 'overlay') ? (
        <section className="mt-4 border-t border-divider pt-3" aria-label={t`效果`}>
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-semibold"><Trans>效果</Trans> <span className="text-2xs text-neutral-500">{draft.effects.length}</span></h3>
            <select
              className="ml-auto h-7 min-w-0 border border-divider bg-bg px-2 text-2xs"
              aria-label={t`添加效果类型`}
              disabled={readOnly}
              value={effectKind}
              onChange={(event) => setEffectKind(event.currentTarget.value as SupportedEditorEffectKind)}
            >
              <option value="color_adjust"><Trans>颜色调整</Trans></option>
              <option value="grayscale"><Trans>黑白</Trans></option>
              <option value="blur"><Trans>模糊</Trans></option>
            </select>
            <button
              type="button"
              className="grid size-7 place-items-center rounded-sm border border-divider hover:bg-neutral-100 disabled:text-neutral-300"
              aria-label={t`添加效果`}
              disabled={readOnly}
              onClick={() => setDraft({ ...draft, effects: [...draft.effects, createEditorEffect(effectKind, globalThis.crypto.randomUUID())] })}
            ><Plus className="size-3.5" aria-hidden="true" /></button>
          </div>
          <ol className="mt-2 list-none space-y-2">
            {draft.effects.map((effect, index) => {
              const supportedKind = isSupportedEditorEffectKind(effect.kind) ? effect.kind : null;
              const schema = supportedKind === null ? [] : EDITOR_EFFECT_SCHEMAS[supportedKind];
              return (
                <li key={effect.id} className="border border-divider bg-neutral-100/50 p-2">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      aria-label={t`启用效果 ${effectLabel(effect.kind)}`}
                      disabled={readOnly}
                      checked={effect.enabled}
                      onChange={(event) => setDraft({
                        ...draft,
                        effects: draft.effects.map((candidate) => candidate.id === effect.id
                          ? { ...candidate, enabled: event.currentTarget.checked }
                          : candidate),
                      })}
                    />
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">{effectLabel(effect.kind)}</span>
                    <button type="button" className="grid size-6 place-items-center hover:bg-neutral-200 disabled:text-neutral-300" aria-label={t`上移效果 ${effectLabel(effect.kind)}`} disabled={readOnly || index === 0} onClick={() => setDraft({ ...draft, effects: moveEditorEffect(draft.effects, effect.id, -1) })}><ChevronUp className="size-3" aria-hidden="true" /></button>
                    <button type="button" className="grid size-6 place-items-center hover:bg-neutral-200 disabled:text-neutral-300" aria-label={t`下移效果 ${effectLabel(effect.kind)}`} disabled={readOnly || index === draft.effects.length - 1} onClick={() => setDraft({ ...draft, effects: moveEditorEffect(draft.effects, effect.id, 1) })}><ChevronDown className="size-3" aria-hidden="true" /></button>
                    <button type="button" className="grid size-6 place-items-center text-fail-text hover:bg-fail-surface disabled:text-neutral-300" aria-label={t`删除效果 ${effectLabel(effect.kind)}`} disabled={readOnly} onClick={() => setDraft({ ...draft, effects: draft.effects.filter((candidate) => candidate.id !== effect.id) })}><Trash2 className="size-3" aria-hidden="true" /></button>
                  </div>
                  {supportedKind === null ? <p className="mt-1 text-2xs text-fail-text"><Trans>该效果不受当前渲染器支持，请禁用或删除。</Trans></p> : null}
                  {schema.map((parameter) => (
                    <label key={parameter.key} className="mt-2 grid grid-cols-[minmax(0,1fr)_88px] items-center gap-2 text-2xs">
                      <span>{effectParameterLabel(parameter.key)}</span>
                      <input
                        type="number"
                        min={parameter.minimum}
                        max={parameter.maximum}
                        step={parameter.step}
                        className="min-w-0 border border-divider bg-bg px-2 py-1 font-mono"
                        aria-label={`${effectLabel(effect.kind)} ${effectParameterLabel(parameter.key)}`}
                        disabled={readOnly || !effect.enabled}
                        value={editorEffectParameter(effect, parameter)}
                        onChange={(event) => setDraft({
                          ...draft,
                          effects: draft.effects.map((candidate) => candidate.id === effect.id
                            ? setEditorEffectParameter(candidate, parameter, Number(event.currentTarget.value))
                            : candidate),
                        })}
                      />
                    </label>
                  ))}
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}
      {draft.text !== null ? null : ([
        { field: 'video_in', label: t`视频入场转场`, channel: 'video', edge: 'in' },
        { field: 'video_out', label: t`视频出场转场`, channel: 'video', edge: 'out' },
        { field: 'audio_in', label: t`音频入场转场`, channel: 'audio', edge: 'in' },
        { field: 'audio_out', label: t`音频出场转场`, channel: 'audio', edge: 'out' },
      ] as const)
        .filter((item) => selected?.track.kind !== 'audio' || item.channel === 'audio')
        .map((item) => {
          const transition = draft.transitions[item.field];
          const otherField = `${item.channel}_${item.edge === 'in' ? 'out' : 'in'}` as keyof TimelineClip['transitions'];
          const otherDuration = draft.transitions[otherField]?.duration_seconds ?? 0;
          const maximumDuration = Math.max(0, Math.min(5, draft.placement.duration - otherDuration - 1 / fps));
          const setTransitionKind = (kind: EditorTransitionKind | null) => setDraft({
            ...draft,
            transitions: {
              ...draft.transitions,
              [item.field]: kind === null ? null : {
                kind,
                duration_seconds: snapTimeToFrame(Math.min(maximumDuration, transition?.duration_seconds ?? 1), fps),
              },
            },
          });
          return (
            <section key={item.field} className="mt-3 border-t border-divider pt-3" aria-label={item.label}>
              <label className="flex flex-col gap-1 text-xs">
                {item.label}
                <select
                  className="border border-divider bg-bg px-2 py-1.5"
                  disabled={readOnly || maximumDuration < 0.05}
                  value={transition?.kind ?? ''}
                  onChange={(event) => setTransitionKind(event.currentTarget.value === '' ? null : event.currentTarget.value as EditorTransitionKind)}
                >
                  <option value=""><Trans>无</Trans></option>
                  {item.channel === 'audio' ? (
                    <>
                      <option value="constant_power"><Trans>恒定功率</Trans></option>
                      <option value="fade"><Trans>线性淡化</Trans></option>
                    </>
                  ) : (
                    <>
                      <option value="fade"><Trans>淡化</Trans></option>
                      <option value="dip"><Trans>黑场</Trans></option>
                      <option value="flash"><Trans>闪白</Trans></option>
                      <option value="zoom"><Trans>缩放</Trans></option>
                      <option value="wipe"><Trans>擦除</Trans></option>
                      <option value="slide"><Trans>滑动</Trans></option>
                      <option value="blur"><Trans>模糊</Trans></option>
                      <option value="glitch"><Trans>故障</Trans></option>
                      <option value="spin"><Trans>旋转</Trans></option>
                    </>
                  )}
                </select>
              </label>
              {transition === null ? null : (
                <label className="mt-2 flex flex-col gap-1 text-xs">
                  <Trans>持续时间（秒）</Trans>
                  <input
                    type="number"
                    min={0.05}
                    max={maximumDuration}
                    step={1 / fps}
                    className="border border-divider bg-bg px-2 py-1.5 font-mono"
                    aria-label={`${item.label} ${t`持续时间`}`}
                    disabled={readOnly}
                    value={transition.duration_seconds}
                    onChange={(event) => setDraft({
                      ...draft,
                      transitions: {
                        ...draft.transitions,
                        [item.field]: {
                          ...transition,
                          duration_seconds: snapTimeToFrame(Math.min(maximumDuration, Math.max(0.05, event.currentTarget.valueAsNumber)), fps),
                        },
                      },
                    })}
                  />
                </label>
              )}
            </section>
          );
        })}
      <label className="mt-3 flex items-center gap-2 text-xs">
        <input type="checkbox" disabled={readOnly} checked={draft.placement.enabled} onChange={(event) => setDraft({ ...draft, placement: { ...draft.placement, enabled: event.currentTarget.checked } })} />
        <Trans>启用片段</Trans>
      </label>
      <Button className="mt-5 w-full" variant="primary" disabled={readOnly || hasUnsupportedEnabledEffect || !draftChanged} onClick={() => onReplace(draft)}><Trans>保存修改</Trans></Button>
    </div>
  );
}

function updateCaptureIntent(
  clip: TimelineClip,
  update: Partial<NonNullable<TimelineClip['capture_intent']>>,
): TimelineClip {
  if (clip.capture_intent === null) return clip;
  return { ...clip, capture_intent: { ...clip.capture_intent, ...update } };
}

function htmlColorInputValue(color: string, fallback: string): string {
  if (/^#[0-9A-F]{6}$/iu.test(color)) return color.toUpperCase();
  const named = color.trim().toLowerCase();
  const digit = (named === 'white' || (named !== 'black' && fallback === DEFAULT_EDITOR_TEXT_COLOR)) ? 'F' : '0';
  return `#${digit.repeat(6)}`;
}

function CaptureIntentNumberField({
  label,
  value,
  step,
  readOnly,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly step: number;
  readonly readOnly: boolean;
  readonly onChange: (value: number) => void;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-2xs">
      {label}
      <input
        type="number"
        min={0}
        step={step}
        className="min-w-0 border border-divider bg-bg px-2 py-1.5 font-mono"
        disabled={readOnly}
        value={value}
        aria-label={label}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
    </label>
  );
}

function updateClipTimingField(
  clip: TimelineClip,
  field: 'duration' | 'source_in' | 'source_out' | 'speed',
  value: number,
  fps: number,
): TimelineClip {
  if (!Number.isFinite(value) || clip.speed_segments.length > 0) return clip;
  const placement = clip.placement;
  if (placement.frame_hold_source_time !== null) {
    if (field !== 'duration') return clip;
    return {
      ...clip,
      placement: { ...placement, duration: Math.max(1 / Math.max(1, fps), value) },
    };
  }
  if (field === 'duration') {
    return rateStretchTimelineClip(clip, 'end', placement.start + value, fps);
  }
  if (field === 'speed') {
    const speed = Math.min(MAX_TIMELINE_CLIP_SPEED, Math.max(MIN_TIMELINE_CLIP_SPEED, Math.abs(value)));
    const sourceDuration = placement.source_out - placement.source_in;
    const stretched = rateStretchTimelineClip(clip, 'end', placement.start + sourceDuration / speed, fps);
    return { ...stretched, placement: { ...stretched.placement, reverse: value < 0 } };
  }
  const frame = 1 / Math.max(1, fps);
  if (field === 'source_in') {
    const sourceIn = Math.min(
      placement.source_out - placement.speed * frame,
      Math.max(0, value),
    );
    if (placement.reverse) {
      return {
        ...clip,
        placement: {
          ...placement,
          duration: (placement.source_out - sourceIn) / placement.speed,
          source_in: sourceIn,
        },
      };
    }
    const timelineDelta = (sourceIn - placement.source_in) / placement.speed;
    return {
      ...clip,
      placement: {
        ...placement,
        start: placement.start + timelineDelta,
        duration: (placement.source_out - sourceIn) / placement.speed,
        source_in: sourceIn,
      },
    };
  }
  const mediaDuration = clip.material.kind === 'planned'
    ? Number.POSITIVE_INFINITY
    : clip.material.media_duration_seconds;
  const sourceOut = Math.min(
    mediaDuration,
    Math.max(placement.source_in + placement.speed * frame, value),
  );
  if (placement.reverse) {
    const fixedEnd = placement.start + placement.duration;
    const duration = (sourceOut - placement.source_in) / placement.speed;
    return {
      ...clip,
      placement: {
        ...placement,
        start: fixedEnd - duration,
        duration,
        source_out: sourceOut,
      },
    };
  }
  return {
    ...clip,
    placement: {
      ...placement,
      duration: (sourceOut - placement.source_in) / placement.speed,
      source_out: sourceOut,
    },
  };
}

function effectLabel(kind: string): string {
  switch (kind) {
    case 'color_adjust': return t`颜色调整`;
    case 'grayscale': return t`黑白`;
    case 'blur': return t`模糊`;
    default: return kind;
  }
}

function effectParameterLabel(key: string): string {
  switch (key) {
    case 'brightness': return t`亮度`;
    case 'contrast': return t`对比度`;
    case 'saturation': return t`饱和度`;
    case 'radius': return t`半径`;
    default: return key;
  }
}

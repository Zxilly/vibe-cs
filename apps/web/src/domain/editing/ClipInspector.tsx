import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Diamond, Plus, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { Button, cn } from '../../design/primitives';
import {
  DEFAULT_EDITOR_TEXT_BACKGROUND,
  DEFAULT_EDITOR_TEXT_COLOR,
  formatTimelinePosition,
  parseTimelinePosition,
  TIME_EPSILON,
} from '../../design/timeline';
import type {
  EditorKeyframeInterpolation,
  EditorKeyframeProperty,
  EditorTransitionKind,
  TimelineClip,
  TimelineTrack,
} from '../../shared/desktop/dto';
import { CommitColorInput, CommitInput, type CommitResult } from './CommitInput';
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
  clipMediaDuration,
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
  trimTimelineClip,
} from './timelineInteraction';

export function ClipInspector({
  selected,
  readOnly,
  timelineTimeSeconds,
  fps,
  onSeek,
  onReplace,
  cameraPreview,
}: {
  readonly selected: { readonly track: TimelineTrack; readonly clip: TimelineClip } | null;
  readonly readOnly: boolean;
  readonly timelineTimeSeconds: number;
  readonly fps: number;
  readonly onSeek: (seconds: number) => void;
  readonly onReplace: (clip: TimelineClip) => void;
  readonly cameraPreview: ReactNode;
}) {
  const [effectKind, setEffectKind] = useState<SupportedEditorEffectKind>('color_adjust');
  if (selected === null) {
    return <aside className="flex items-center justify-center border-l border-divider p-5 text-sm text-neutral-600"><Trans>选择片段后编辑</Trans></aside>;
  }
  const clip = selected.clip;
  // Every control writes one Human Edit through `onReplace`, the same Interface
  // the Timeline trim uses; Story ripple is applied behind it.
  const commit = (next: TimelineClip): CommitResult => {
    if (readOnly || sameTimelineClip(next, clip)) return false;
    if (next.effects.some((effect) => effect.enabled && !isSupportedEditorEffectKind(effect.kind))) {
      return t`请先停用不支持的效果`;
    }
    onReplace(next);
    return true;
  };
  const commitNumber = (apply: (value: number) => TimelineClip) => (text: string): CommitResult => {
    const value = parseInspectorNumber(text);
    return value === null ? t`请输入数字` : commit(apply(value));
  };
  const timingLocked = clip.speed_segments.length > 0 || clip.placement.frame_hold_source_time !== null;
  const localTime = clipLocalTimeAtTimeline(clip, timelineTimeSeconds, fps);
  const keyframeTimes = [...new Set(clip.keyframes.map((keyframe) => keyframe.time))].sort((left, right) => left - right);
  const currentFrameKeyframes = clip.keyframes.filter((keyframe) => Math.abs(keyframe.time - localTime) <= 0.5 / fps);
  const previousKeyframeTime = [...keyframeTimes].reverse().find((time) => time < localTime - 0.5 / fps);
  const nextKeyframeTime = keyframeTimes.find((time) => time > localTime + 0.5 / fps);
  const visualProperties: Array<{
    readonly property: Exclude<EditorKeyframeProperty, 'volume' | 'pan'>;
    readonly label: string;
    readonly step: number;
    readonly min?: number;
    readonly max?: number;
  }> = selected.track.kind === 'audio'
    ? []
    : clip.text !== null
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
  const hasUnsupportedEnabledEffect = clip.effects.some((effect) => effect.enabled && !isSupportedEditorEffectKind(effect.kind));
  const textStyle = clip.text;
  const mediaKind = typeof clip.metadata === 'object' && clip.metadata !== null && !Array.isArray(clip.metadata)
    && typeof clip.metadata.media_kind === 'string'
    ? clip.metadata.media_kind.toLowerCase()
    : '';
  const canTimeRemap = clip.text === null
    && selected.track.kind !== 'text'
    && selected.track.kind !== 'caption'
    && !mediaKind.startsWith('image');
  const speedBoundaryAtPlayhead = clip.speed_segments.some((segment) => (
    Math.abs(segment.start - localTime) <= 0.5 / fps || Math.abs(segment.end - localTime) <= 0.5 / fps
  ));
  return (
    <div key={clip.id} className="min-h-0" aria-label={t`片段属性`}>
      {readOnly ? <p role="status" className="mb-3 text-xs text-neutral-600"><Trans>当前片段只读，请先结束 Agent 编辑或解锁轨道。</Trans></p> : null}
      {hasUnsupportedEnabledEffect ? <p role="status" className="mb-3 text-xs text-fail-text"><Trans>请先停用不支持的效果，再修改片段。</Trans></p> : null}
      <label className="flex flex-col gap-1 text-xs">
        <Trans>名称</Trans>
        <CommitInput
          aria-label={t`名称`}
          disabled={readOnly}
          value={clip.name}
          onCommit={(text) => text.trim() === '' ? t`名称不能为空` : commit({ ...clip, name: text.trim() })}
        />
      </label>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {([
          ['source_in', t`源入点`],
          ['source_out', t`源出点`],
        ] as const).map(([field, label]) => (
          <label key={field} className="flex min-w-0 flex-col gap-1 text-xs">
            {label}
            <CommitInput
              aria-label={label}
              mono
              inputMode="numeric"
              placeholder="00:00:00:00"
              disabled={readOnly || timingLocked}
              value={formatTimelinePosition(clip.placement[field], fps, 'timecode')}
              onCommit={(text) => {
                const next = trimClipSourcePoint(clip, field, text, fps);
                return typeof next === 'string' ? next : commit(next);
              }}
            />
          </label>
        ))}
      </div>
      <label className="mt-3 flex flex-col gap-1 text-xs">
        <Trans>播放速度（倍）</Trans>
        <CommitInput
          aria-label={t`播放速度（倍）`}
          type="number"
          step={0.1}
          mono
          disabled={readOnly || timingLocked}
          value={Number(((clip.placement.reverse ? -1 : 1) * clip.placement.speed).toFixed(4))}
          onCommit={(text) => {
            const next = stretchClipSpeed(clip, text, fps);
            return typeof next === 'string' ? next : commit(next);
          }}
        />
      </label>
      <p className="mt-2 flex items-center justify-between gap-2 text-xs text-neutral-600">
        <Trans>时间轴时长</Trans>
        <span className="font-mono text-text">{formatTimelinePosition(clip.placement.duration, fps, 'timecode')}</span>
      </p>
      {clip.text !== null || selected.track.kind === 'text' || selected.track.kind === 'caption' ? null : (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={clip.placement.reverse}
              disabled={readOnly || clip.speed_segments.length > 0 || clip.placement.frame_hold_source_time !== null}
              onChange={(event) => commit({ ...clip, placement: { ...clip.placement, reverse: event.currentTarget.checked } })}
            />
            <Trans>反向播放</Trans>
          </label>
          <Button
            size="sm"
            variant={clip.placement.frame_hold_source_time === null ? 'secondary' : 'primary'}
            disabled={readOnly || clip.speed_segments.length > 0 || selected.track.kind === 'audio'}
            onClick={() => commit({
              ...clip,
              placement: {
                ...clip.placement,
                reverse: false,
                frame_hold_source_time: clip.placement.frame_hold_source_time === null
                  ? clipSourceTimeAtLocalTime(clip, localTime)
                  : null,
              },
            })}
          >
            {clip.placement.frame_hold_source_time === null ? <Trans>定格当前帧</Trans> : <Trans>取消定格</Trans>}
          </Button>
        </div>
      )}
      {!canTimeRemap ? null : (
        <section className="mt-4 border-t border-divider pt-3" aria-label={t`时间重映射`}>
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-semibold"><Trans>时间重映射</Trans></h3>
            {clip.speed_segments.length === 0 ? (
              <Button
                className="ml-auto"
                size="sm"
                variant="secondary"
                disabled={readOnly || clip.placement.reverse || clip.placement.frame_hold_source_time !== null}
                onClick={() => commit(enableClipTimeRemapping(clip, globalThis.crypto.randomUUID()))}
              >
                <Trans>启用</Trans>
              </Button>
            ) : (
              <Button
                className="ml-auto"
                size="sm"
                variant="ghost"
                disabled={readOnly}
                onClick={() => commit(disableClipTimeRemapping(clip))}
              >
                <Trans>恢复恒定速度</Trans>
              </Button>
            )}
          </div>
          {clip.speed_segments.length === 0 ? (
            <p className="mt-2 text-xs leading-4 text-neutral-500"><Trans>启用后可在播放头添加速度关键帧，并分别调整片段各区间的速度。</Trans></p>
          ) : (
            <>
              <Button
                className="mt-2 w-full"
                size="sm"
                variant="secondary"
                disabled={readOnly
                  || localTime <= 0.5 / fps
                  || localTime >= clip.placement.duration - 0.5 / fps
                  || speedBoundaryAtPlayhead}
                onClick={() => commit(splitClipSpeedSegment(
                  clip,
                  localTime,
                  globalThis.crypto.randomUUID(),
                  fps,
                ))}
              >
                <Plus className="size-3.5" aria-hidden="true" />
                <Trans>在播放头添加速度关键帧</Trans>
              </Button>
              <ol className="mt-2 list-none space-y-1.5">
                {clip.speed_segments.map((segment, index) => (
                  <li
                    key={segment.id}
                    className="grid grid-cols-[minmax(0,1fr)_90px_28px] items-center gap-2 border border-divider bg-neutral-50 px-2 py-1.5"
                    data-speed-segment-id={segment.id}
                  >
                    <span className="min-w-0 truncate font-mono text-xs text-neutral-600">
                      {segment.start.toFixed(3)}–{segment.end.toFixed(3)}s
                    </span>
                    <label className="flex min-w-0 items-center gap-1 text-xs">
                      <span className="sr-only"><Trans>区间速度</Trans></span>
                      <CommitInput
                        type="number"
                        min={MIN_TIMELINE_CLIP_SPEED * 100}
                        max={MAX_TIMELINE_CLIP_SPEED * 100}
                        step={1}
                        mono
                        ground="bg"
                        className="flex-1 px-1.5 text-right"
                        aria-label={t`区间 ${index + 1} 速度百分比`}
                        disabled={readOnly}
                        value={Number((segment.speed * 100).toFixed(3))}
                        onCommit={commitNumber((value) => setClipSpeedSegmentSpeed(clip, segment.id, value / 100, fps))}
                      />
                      <span>%</span>
                    </label>
                    <button
                      type="button"
                      className="grid size-7 place-items-center rounded-sm text-fail-text hover:bg-fail-surface disabled:text-neutral-300"
                      aria-label={t`删除区间 ${index + 1} 前的速度关键帧`}
                      disabled={readOnly || index === 0}
                      onClick={() => commit(removeClipSpeedBoundary(clip, segment.id))}
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ol>
              <p className="mt-2 text-xs leading-4 text-neutral-500"><Trans>调整区间速度会改变该区间和片段时长，但保持源 In/Out 不变；Story 后续片段会随之波纹移动。</Trans></p>
            </>
          )}
        </section>
      )}
      {clip.capture_intent === null ? null : (
        <section className="mt-4 border-t border-divider pt-3" aria-label={t`录制范围`}>
          <h3 className="text-xs font-semibold"><Trans>录制范围</Trans></h3>
          <label className="mt-2 flex flex-col gap-1 text-xs">
            <Trans>录制视角</Trans>
            <select
              className="border border-divider bg-bg px-2 py-1.5"
              disabled={readOnly}
              value={clip.capture_intent.camera_style}
              aria-label={t`录制视角`}
              onChange={(event) => commit(updateCaptureIntent(clip, {
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
            <CaptureIntentNumberField label={t`开始 tick`} value={clip.capture_intent.start_tick} step={1} readOnly={readOnly} onCommit={commitNumber((value) => updateCaptureIntent(clip, { start_tick: Math.max(0, Math.trunc(value)) }))} />
            <CaptureIntentNumberField label={t`结束 tick`} value={clip.capture_intent.end_tick} step={1} readOnly={readOnly} onCommit={commitNumber((value) => updateCaptureIntent(clip, { end_tick: Math.max(0, Math.trunc(value)) }))} />
            <CaptureIntentNumberField label={t`前留白（秒）`} value={clip.capture_intent.pre_roll_seconds} step={0.1} readOnly={readOnly} onCommit={commitNumber((value) => updateCaptureIntent(clip, { pre_roll_seconds: Math.max(0, value) }))} />
            <CaptureIntentNumberField label={t`后留白（秒）`} value={clip.capture_intent.post_roll_seconds} step={0.1} readOnly={readOnly} onCommit={commitNumber((value) => updateCaptureIntent(clip, { post_roll_seconds: Math.max(0, value) }))} />
          </div>
          <span className="mt-1 block text-xs text-neutral-500"><Trans>非第一人称视角需要片段范围内至少四个空间采样点；回合边界镜头应在回合结束前停止。</Trans></span>
          {cameraPreview}
          {clip.material.kind === 'planned' ? null : (
            <Button
              className="mt-2 w-full"
              size="sm"
              variant="secondary"
              disabled={readOnly}
              onClick={() => commit({ ...clip, material: { kind: 'planned' } })}
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
            <CommitInput
              multiline
              maxLength={1_000}
              aria-label={t`文字内容`}
              disabled={readOnly}
              value={textStyle.content}
              onCommit={(text) => commit({ ...clip, text: { ...textStyle, content: text } })}
            />
          </label>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-xs">
              <Trans>字体</Trans>
              <CommitInput
                ground="bg"
                aria-label={t`字体`}
                disabled={readOnly}
                value={textStyle.font_family}
                onCommit={(text) => text.trim() === '' ? t`字体不能为空` : commit({ ...clip, text: { ...textStyle, font_family: text.trim() } })}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <Trans>字号</Trans>
              <CommitInput
                type="number"
                min={6}
                max={512}
                step={1}
                mono
                ground="bg"
                aria-label={t`字号`}
                disabled={readOnly}
                value={textStyle.font_size}
                onCommit={commitNumber((value) => ({ ...clip, text: { ...textStyle, font_size: Math.min(512, Math.max(6, value)) } }))}
              />
            </label>
            <label className="flex items-center gap-2 text-xs">
              <Trans>文字颜色</Trans>
              <CommitColorInput
                label={t`文字颜色`}
                disabled={readOnly}
                value={htmlColorInputValue(textStyle.color, DEFAULT_EDITOR_TEXT_COLOR)}
                onCommit={(color) => commit({ ...clip, text: { ...textStyle, color } })}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <Trans>对齐</Trans>
              <select
                className="border border-divider bg-bg px-2 py-1.5"
                disabled={readOnly}
                value={textStyle.align}
                onChange={(event) => commit({ ...clip, text: { ...textStyle, align: event.currentTarget.value } })}
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
              onChange={(event) => commit({
                ...clip,
                text: { ...textStyle, background: event.currentTarget.checked ? DEFAULT_EDITOR_TEXT_BACKGROUND : null },
              })}
            />
            <Trans>启用文字背景</Trans>
          </label>
          {textStyle.background === null ? null : (
            <label className="mt-2 flex items-center gap-2 text-xs">
              <Trans>背景颜色</Trans>
              <CommitColorInput
                label={t`背景颜色`}
                disabled={readOnly}
                value={htmlColorInputValue(textStyle.background, DEFAULT_EDITOR_TEXT_BACKGROUND)}
                onCommit={(background) => commit({ ...clip, text: { ...textStyle, background } })}
              />
            </label>
          )}
        </section>
      )}
      {clip.text !== null || selected.track.kind === 'text' || selected.track.kind === 'caption' ? null : (() => {
        const audioProperties = [
          { property: 'volume' as const, label: t`音量`, min: 0, max: 4, step: 0.01, fallback: clip.placement.volume },
          { property: 'pan' as const, label: t`声像`, min: -1, max: 1, step: 0.01, fallback: clip.placement.pan },
        ];
        return (
          <section className="mt-4 border-t border-divider pt-3" aria-label={t`音频自动化`}>
            {audioProperties.map(({ property, label, min, max, step, fallback }) => {
              const propertyKeyframes = clip.keyframes.filter((keyframe) => keyframe.property === property);
              const current = clipKeyframeAtTime(clip, property, localTime, fps);
              const value = evaluateClipKeyframeProperty(clip, property, localTime, fallback);
              return <div key={property} className="mt-2 grid grid-cols-[minmax(0,1fr)_88px_28px] items-center gap-2 text-xs">
                <span>{label}{propertyKeyframes.length === 0 ? null : <span className="ml-1 text-xs text-neutral-500">{propertyKeyframes.length}</span>}</span>
                <CommitInput
                  type="number"
                  min={min}
                  max={max}
                  step={step}
                  mono
                  className="px-2"
                  disabled={readOnly}
                  value={value}
                  aria-label={label}
                  onCommit={commitNumber((next) => property === 'volume'
                    ? setClipVolumeAtTime(clip, localTime, next, fps, globalThis.crypto.randomUUID())
                    : setClipPanAtTime(clip, localTime, next, fps, globalThis.crypto.randomUUID()))}
                />
                <button
                  type="button"
                  className={cn(
                    'grid size-7 place-items-center rounded-sm border border-divider hover:bg-neutral-100 disabled:text-neutral-300',
                    current !== null && 'border-accent-300 bg-accent-100 text-accent-700',
                  )}
                  disabled={readOnly}
                  aria-label={current === null ? t`在播放头添加 ${label} 关键帧` : t`删除播放头的 ${label} 关键帧`}
                  onClick={() => commit(current === null
                    ? upsertClipKeyframe(clip, property, localTime, value, globalThis.crypto.randomUUID(), fps)
                    : removeClipKeyframe(clip, property, localTime, fps))}
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
              <span className="truncate font-mono text-xs">{keyframe.property}</span>
              <select
                className="border border-divider bg-bg px-2 py-1"
                aria-label={t`${keyframe.property} 插值`}
                disabled={readOnly}
                value={keyframe.interpolation}
                onChange={(event) => {
                  const interpolation = event.currentTarget.value as EditorKeyframeInterpolation;
                  commit({ ...clip, keyframes: clip.keyframes.map((candidate) => candidate.id === keyframe.id
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
                      <CommitInput
                        type="number"
                        step={0.1}
                        mono
                        ground="bg"
                        className="w-20 px-2"
                        aria-label={t`${keyframe.property} ${label}`}
                        disabled={readOnly}
                        value={keyframe[field]}
                        onCommit={commitNumber((value) => ({
                          ...clip,
                          keyframes: clip.keyframes.map((candidate) => candidate.id === keyframe.id
                            ? { ...candidate, [field]: value }
                            : candidate),
                        }))}
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
                onClick={() => previousKeyframeTime === undefined ? undefined : onSeek(clip.placement.start + previousKeyframeTime)}
              ><ChevronLeft className="size-3" aria-hidden="true" /></button>
              <button
                type="button"
                className="grid size-6 place-items-center border-l border-divider hover:bg-neutral-100 disabled:text-neutral-300"
                aria-label={t`下一个关键帧`}
                disabled={nextKeyframeTime === undefined}
                onClick={() => nextKeyframeTime === undefined ? undefined : onSeek(clip.placement.start + nextKeyframeTime)}
              ><ChevronRight className="size-3" aria-hidden="true" /></button>
            </span>
            <span className="ml-auto font-mono text-xs text-neutral-500"><Trans>片段内</Trans> {localTime.toFixed(3)}s</span>
          </div>
          {visualProperties.map(({ property, label, step, min, max }) => {
            const propertyKeyframes = clip.keyframes.filter((keyframe) => keyframe.property === property);
            const current = clipKeyframeAtTime(clip, property, localTime, fps);
            const animationAllowed = canAnimateTransformProperty(clip, property);
            const fallback = clip.transform[property];
            const value = evaluateClipKeyframeProperty(clip, property, localTime, fallback);
            return (
              <div key={property} className="mt-2 grid grid-cols-[minmax(0,1fr)_88px_28px] items-center gap-2 text-xs">
                <span className="truncate">{label}{propertyKeyframes.length === 0 ? null : <span className="ml-1 text-xs text-neutral-500">{propertyKeyframes.length}</span>}</span>
                <CommitInput
                  type="number"
                  step={step}
                  {...(min === undefined ? {} : { min })}
                  {...(max === undefined ? {} : { max })}
                  mono
                  className="px-2"
                  disabled={readOnly || (!animationAllowed && (property === 'rotation' || propertyKeyframes.length > 0))}
                  value={value}
                  onCommit={commitNumber((nextValue) => propertyKeyframes.length === 0
                    ? { ...clip, transform: { ...clip.transform, [property]: nextValue } }
                    : upsertClipKeyframe(clip, property, localTime, nextValue, globalThis.crypto.randomUUID(), fps))}
                  aria-label={label}
                />
                <button
                  type="button"
                  className={cn(
                    'grid size-7 place-items-center rounded-sm border border-divider hover:bg-neutral-100 disabled:text-neutral-300',
                    current !== null && 'border-accent-300 bg-accent-100 text-accent-700',
                  )}
                  disabled={readOnly || (current === null && !animationAllowed)}
                  aria-label={current === null ? t`在播放头添加 ${label} 关键帧` : t`删除播放头的 ${label} 关键帧`}
                  onClick={() => commit(current === null
                    ? upsertClipKeyframe(clip, property, localTime, value, globalThis.crypto.randomUUID(), fps)
                    : removeClipKeyframe(clip, property, localTime, fps))}
                >
                  <Diamond className="size-3" fill={current === null ? 'none' : 'currentColor'} aria-hidden="true" />
                </button>
              </div>
            );
          })}
          {clip.keyframes.some((keyframe) => ['scale_x', 'scale_y', 'rotation'].includes(keyframe.property))
            ? <p className="mt-2 text-xs text-neutral-500"><Trans>动画缩放与旋转不能同时启用；这是导出渲染器的组合约束。</Trans></p>
            : null}
        </section>
      )}
      {clip.text === null && (selected.track.kind === 'video' || selected.track.kind === 'overlay') ? (
        <section className="mt-4 border-t border-divider pt-3" aria-label={t`效果`}>
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-semibold"><Trans>效果</Trans> <span className="text-xs text-neutral-500">{clip.effects.length}</span></h3>
            <select
              className="ml-auto h-7 min-w-0 border border-divider bg-bg px-2 text-xs"
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
              onClick={() => commit({ ...clip, effects: [...clip.effects, createEditorEffect(effectKind, globalThis.crypto.randomUUID())] })}
            ><Plus className="size-3.5" aria-hidden="true" /></button>
          </div>
          <ol className="mt-2 list-none space-y-2">
            {clip.effects.map((effect, index) => {
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
                      onChange={(event) => commit({
                        ...clip,
                        effects: clip.effects.map((candidate) => candidate.id === effect.id
                          ? { ...candidate, enabled: event.currentTarget.checked }
                          : candidate),
                      })}
                    />
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">{effectLabel(effect.kind)}</span>
                    <button type="button" className="grid size-6 place-items-center hover:bg-neutral-200 disabled:text-neutral-300" aria-label={t`上移效果 ${effectLabel(effect.kind)}`} disabled={readOnly || index === 0} onClick={() => commit({ ...clip, effects: moveEditorEffect(clip.effects, effect.id, -1) })}><ChevronUp className="size-3" aria-hidden="true" /></button>
                    <button type="button" className="grid size-6 place-items-center hover:bg-neutral-200 disabled:text-neutral-300" aria-label={t`下移效果 ${effectLabel(effect.kind)}`} disabled={readOnly || index === clip.effects.length - 1} onClick={() => commit({ ...clip, effects: moveEditorEffect(clip.effects, effect.id, 1) })}><ChevronDown className="size-3" aria-hidden="true" /></button>
                    <button type="button" className="grid size-6 place-items-center text-fail-text hover:bg-fail-surface disabled:text-neutral-300" aria-label={t`删除效果 ${effectLabel(effect.kind)}`} disabled={readOnly} onClick={() => commit({ ...clip, effects: clip.effects.filter((candidate) => candidate.id !== effect.id) })}><Trash2 className="size-3" aria-hidden="true" /></button>
                  </div>
                  {supportedKind === null ? <p className="mt-1 text-xs text-fail-text"><Trans>该效果不受当前渲染器支持，请禁用或删除。</Trans></p> : null}
                  {schema.map((parameter) => (
                    <label key={parameter.key} className="mt-2 grid grid-cols-[minmax(0,1fr)_88px] items-center gap-2 text-xs">
                      <span>{effectParameterLabel(parameter.key)}</span>
                      <CommitInput
                        type="number"
                        min={parameter.minimum}
                        max={parameter.maximum}
                        step={parameter.step}
                        mono
                        ground="bg"
                        className="px-2"
                        aria-label={`${effectLabel(effect.kind)} ${effectParameterLabel(parameter.key)}`}
                        disabled={readOnly || !effect.enabled}
                        value={editorEffectParameter(effect, parameter)}
                        onCommit={commitNumber((value) => ({
                          ...clip,
                          effects: clip.effects.map((candidate) => candidate.id === effect.id
                            ? setEditorEffectParameter(candidate, parameter, value)
                            : candidate),
                        }))}
                      />
                    </label>
                  ))}
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}
      {clip.text !== null ? null : ([
        { field: 'video_in', label: t`视频入场转场`, channel: 'video', edge: 'in' },
        { field: 'video_out', label: t`视频出场转场`, channel: 'video', edge: 'out' },
        { field: 'audio_in', label: t`音频入场转场`, channel: 'audio', edge: 'in' },
        { field: 'audio_out', label: t`音频出场转场`, channel: 'audio', edge: 'out' },
      ] as const)
        .filter((item) => selected.track.kind !== 'audio' || item.channel === 'audio')
        .map((item) => {
          const transition = clip.transitions[item.field];
          const otherField = `${item.channel}_${item.edge === 'in' ? 'out' : 'in'}` as keyof TimelineClip['transitions'];
          const otherDuration = clip.transitions[otherField]?.duration_seconds ?? 0;
          const maximumDuration = Math.max(0, Math.min(5, clip.placement.duration - otherDuration - 1 / fps));
          const setTransitionKind = (kind: EditorTransitionKind | null) => commit({
            ...clip,
            transitions: {
              ...clip.transitions,
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
                  <CommitInput
                    type="number"
                    min={0.05}
                    max={maximumDuration}
                    step={1 / fps}
                    mono
                    ground="bg"
                    aria-label={`${item.label} ${t`持续时间`}`}
                    disabled={readOnly}
                    value={transition.duration_seconds}
                    onCommit={commitNumber((value) => ({
                      ...clip,
                      transitions: {
                        ...clip.transitions,
                        [item.field]: {
                          ...transition,
                          duration_seconds: snapTimeToFrame(Math.min(maximumDuration, Math.max(0.05, value)), fps),
                        },
                      },
                    }))}
                  />
                </label>
              )}
            </section>
          );
        })}
      <label className="mt-3 flex items-center gap-2 text-xs">
        <input type="checkbox" disabled={readOnly} checked={clip.placement.enabled} onChange={(event) => commit({ ...clip, placement: { ...clip.placement, enabled: event.currentTarget.checked } })} />
        <Trans>启用片段</Trans>
      </label>
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
  onCommit,
}: {
  readonly label: string;
  readonly value: number;
  readonly step: number;
  readonly readOnly: boolean;
  readonly onCommit: (text: string) => CommitResult;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs">
      {label}
      <CommitInput
        type="number"
        min={0}
        step={step}
        mono
        ground="bg"
        className="px-2"
        disabled={readOnly}
        value={value}
        aria-label={label}
        onCommit={onCommit}
      />
    </label>
  );
}

function parseInspectorNumber(text: string): number | null {
  const value = Number(text.trim());
  return text.trim() === '' || !Number.isFinite(value) ? null : value;
}

/**
 * Moves one source point through the Timeline trim of the edge it owns — the
 * head for In (Out when reversed) — so the Inspector and a dragged trim share
 * clamps and frame snapping. Returns the reason when the point cannot land.
 */
function trimClipSourcePoint(
  clip: TimelineClip,
  field: 'source_in' | 'source_out',
  text: string,
  fps: number,
): TimelineClip | string {
  const seconds = parseTimelinePosition(text, fps, 'timecode');
  if (seconds === null) return t`请输入 时:分:秒:帧 时间码`;
  const placement = clip.placement;
  if (field === 'source_in' && seconds >= placement.source_out) return t`入点须早于出点`;
  if (field === 'source_out' && seconds <= placement.source_in) return t`出点须晚于入点`;
  const mediaDuration = clipMediaDuration(clip);
  if (mediaDuration !== null && seconds > mediaDuration + TIME_EPSILON) return t`超出源素材时长`;
  const edge = (field === 'source_in') === !placement.reverse ? 'start' : 'end';
  const timelineDelta = (placement.reverse ? -1 : 1) * (seconds - placement[field]) / placement.speed;
  const edgeTime = edge === 'start' ? placement.start : placement.start + placement.duration;
  const next = trimTimelineClip(clip, edge, edgeTime + timelineDelta, fps, mediaDuration);
  const tolerance = placement.speed / Math.max(1, fps) / 2 + TIME_EPSILON;
  return Math.abs(next.placement[field] - seconds) > tolerance ? t`超出可调整范围` : next;
}

/** Signed speed: a negative value plays the clip in reverse at that magnitude. */
function stretchClipSpeed(clip: TimelineClip, text: string, fps: number): TimelineClip | string {
  const value = parseInspectorNumber(text);
  if (value === null) return t`请输入数字`;
  const speed = Math.abs(value);
  if (speed < MIN_TIMELINE_CLIP_SPEED || speed > MAX_TIMELINE_CLIP_SPEED) {
    return t`速度须在 ${MIN_TIMELINE_CLIP_SPEED}–${MAX_TIMELINE_CLIP_SPEED} 倍之间`;
  }
  const placement = clip.placement;
  const sourceDuration = placement.source_out - placement.source_in;
  const stretched = rateStretchTimelineClip(clip, 'end', placement.start + sourceDuration / speed, fps);
  return { ...stretched, placement: { ...stretched.placement, reverse: value < 0 } };
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

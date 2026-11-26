import { Trans } from '@lingui/react/macro';

import { Input, NativeSelect, Textarea } from '../../design/primitives';
import type { EditorMarker } from '../../shared/desktop/dto';
import { snapTimeToFrame } from './timelineInteraction';

export function MarkerEditorFields({ marker, durationSeconds, fps, onChange }: {
  readonly marker: EditorMarker;
  readonly durationSeconds: number;
  readonly fps: number;
  readonly onChange: (marker: EditorMarker) => void;
}) {
  return (
    <div className="space-y-3">
      <label className="flex flex-col gap-1 text-xs">
        <Trans>名称</Trans>
        <Input
          size="sm"
          ground="bg"
          value={marker.label}
          onChange={(event) => onChange({ ...marker, label: event.currentTarget.value })}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        <Trans>时间</Trans>
        <Input
          size="sm"
          ground="bg"
          mono
          type="number"
          min={0}
          max={durationSeconds}
          step={1 / fps}
          value={marker.time}
          onChange={(event) => onChange({ ...marker, time: Number(event.currentTarget.value) })}
        />
      </label>
      <label className="flex items-center gap-2 text-xs">
        <Trans>颜色</Trans>
        <input
          type="color"
          className="h-7 w-10 cursor-pointer rounded-sm border border-neutral-400 bg-bg p-0.5"
          value={marker.color}
          onChange={(event) => onChange({ ...marker, color: event.currentTarget.value.toUpperCase() })}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        <Trans>类型</Trans>
        <NativeSelect
          size="sm"
          value={marker.kind}
          onChange={(event) => onChange({ ...marker, kind: event.currentTarget.value as EditorMarker['kind'] })}
        >
          <option value="comment"><Trans>评论</Trans></option>
          <option value="chapter"><Trans>章节</Trans></option>
          <option value="segmentation"><Trans>分段</Trans></option>
        </NativeSelect>
      </label>
      <label className="flex flex-col gap-1 text-xs">
        <Trans>持续时间</Trans>
        <Input
          size="sm"
          ground="bg"
          mono
          type="number"
          min={0}
          max={Math.max(0, durationSeconds - marker.time)}
          step={1 / fps}
          value={marker.duration}
          onChange={(event) => onChange({ ...marker, duration: Number(event.currentTarget.value) })}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        <Trans>注释</Trans>
        <Textarea
          rows={4}
          className="bg-bg text-sm leading-5"
          value={marker.comment}
          onChange={(event) => onChange({ ...marker, comment: event.currentTarget.value })}
        />
      </label>
    </div>
  );
}

export function normalizeEditorMarker(marker: EditorMarker, durationSeconds: number, fps: number): EditorMarker {
  const frameRate = Math.max(1, fps);
  const time = snapTimeToFrame(Math.min(durationSeconds, Math.max(0, marker.time)), frameRate);
  const maximumDurationFrames = Math.max(0, Math.floor((durationSeconds - time) * frameRate + 1e-6));
  const requestedDurationFrames = Math.max(0, Math.round(marker.duration * frameRate));
  return {
    ...marker,
    label: marker.label.trim(),
    time,
    duration: Math.min(maximumDurationFrames, requestedDurationFrames) / frameRate,
  };
}

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useState } from 'react';

import { useAssetWaveform } from '../../data/mediaAssets';
import { Button, cn } from '../../design/primitives';
import type { TimelineTrack } from '../../shared/desktop/dto';
import { clipSourceTimeAtLocalTime } from './timelineInteraction';
import { evaluateTrackAudioProperty, type TrackAudioProperty, upsertTrackAudioKeyframe } from './trackAudioEditing';
import { resolveTimelineMaterial } from './timelineMaterial';

export type MixerAutomationMode = 'off' | 'read' | 'write' | 'touch' | 'latch';

export function AudioTrackMixer({ tracks, storyTrackId, timelineTimeSeconds, durationSeconds, fps, playing, readOnly, onReplaceTrack }: {
  readonly tracks: readonly TimelineTrack[];
  readonly storyTrackId: string;
  readonly timelineTimeSeconds: number;
  readonly durationSeconds: number;
  readonly fps: number;
  readonly playing: boolean;
  readonly readOnly: boolean;
  readonly onReplaceTrack: (track: TimelineTrack) => void;
}) {
  const audioTracks = tracks.filter((track) => track.kind === 'audio' || track.id === storyTrackId);
  const [modes, setModes] = useState<Readonly<Record<string, MixerAutomationMode>>>({});
  return (
    <section className="flex size-full min-h-0 flex-col bg-bg" aria-label={t`音轨混音器`}>
      <header className="flex h-8 flex-none items-center border-b border-divider px-2 text-xs font-semibold"><Trans>音轨混音器</Trans></header>
      <div className="flex min-h-0 flex-1 overflow-x-auto overflow-y-hidden p-2">
        {audioTracks.map((track) => (
          <AudioMixerStrip
            key={track.id}
            track={track}
            timelineTimeSeconds={timelineTimeSeconds}
            durationSeconds={durationSeconds}
            fps={fps}
            playing={playing}
            readOnly={readOnly}
            mode={modes[track.id] ?? 'read'}
            onModeChange={(mode) => setModes((current) => ({ ...current, [track.id]: mode }))}
            onReplaceTrack={onReplaceTrack}
          />
        ))}
      </div>
    </section>
  );
}

function AudioMixerStrip({ track, timelineTimeSeconds, durationSeconds, fps, playing, readOnly, mode, onModeChange, onReplaceTrack }: {
  readonly track: TimelineTrack;
  readonly timelineTimeSeconds: number;
  readonly durationSeconds: number;
  readonly fps: number;
  readonly playing: boolean;
  readonly readOnly: boolean;
  readonly mode: MixerAutomationMode;
  readonly onModeChange: (mode: MixerAutomationMode) => void;
  readonly onReplaceTrack: (track: TimelineTrack) => void;
}) {
  const clip = track.clips.find((candidate) => candidate.placement.enabled
    && timelineTimeSeconds >= candidate.placement.start
    && timelineTimeSeconds < candidate.placement.start + candidate.placement.duration) ?? null;
  const assetId = clip === null ? null : resolveTimelineMaterial(clip.material).streamAssetId;
  const waveform = useAssetWaveform(assetId, 240, { enabled: playing && assetId !== null });
  const sourceTime = clip === null ? 0 : clipSourceTimeAtLocalTime(clip, timelineTimeSeconds - clip.placement.start);
  const mediaDuration = clip?.material.kind === 'planned' ? 0 : clip?.material.media_duration_seconds ?? 0;
  const peaks = waveform.data?.waveform ?? [];
  const peakIndex = peaks.length === 0 || mediaDuration <= 0 ? 0 : Math.min(peaks.length - 1, Math.floor(sourceTime / mediaDuration * peaks.length));
  const volume = mode === 'off' ? track.volume : evaluateTrackAudioProperty(track, 'volume', timelineTimeSeconds);
  const pan = mode === 'off' ? track.pan : evaluateTrackAudioProperty(track, 'pan', timelineTimeSeconds);
  const peak = playing && !track.muted ? Math.min(1, Math.max(0, peaks[peakIndex] ?? 0) * Math.min(1, volume)) : 0;
  const replaceProperty = (property: TrackAudioProperty, value: number) => onReplaceTrack(applyMixerAutomation(
    track,
    mode,
    property,
    timelineTimeSeconds,
    durationSeconds,
    value,
    fps,
    () => globalThis.crypto.randomUUID(),
  ));
  return (
    <div className="grid w-28 flex-none grid-rows-[auto_auto_1fr_auto_auto] gap-2 border-r border-divider px-2 pb-2 last:border-r-0" aria-label={t`混音轨 ${track.name}`}>
      <strong className="truncate text-center text-xs">{track.name}</strong>
      <select className="h-7 border border-divider bg-bg px-1 text-2xs" aria-label={t`自动化模式 ${track.name}`} value={mode} onChange={(event) => onModeChange(event.currentTarget.value as MixerAutomationMode)}>
        <option value="off">Off</option>
        <option value="read">Read</option>
        <option value="write">Write</option>
        <option value="touch">Touch</option>
        <option value="latch">Latch</option>
      </select>
      <div className="grid min-h-0 grid-cols-[1fr_10px] gap-2">
        <input
          type="range"
          min={0}
          max={4}
          step={0.01}
          value={volume}
          disabled={readOnly || mode === 'read'}
          aria-label={t`轨道音量 ${track.name}`}
          className="m-auto h-full [direction:rtl] [writing-mode:vertical-lr]"
          onChange={(event) => replaceProperty('volume', event.currentTarget.valueAsNumber)}
        />
        <div className="relative min-h-0 overflow-hidden bg-neutral-200" aria-label={t`峰值 ${track.name} ${Math.round(peak * 100)}%`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(peak * 100)}>
          <span className="absolute inset-x-0 bottom-0 bg-ok transition-[height] duration-75" style={{ height: `${peak * 100}%` }} />
        </div>
      </div>
      <input type="range" min={-1} max={1} step={0.01} value={pan} disabled={readOnly || mode === 'read'} aria-label={t`轨道声像 ${track.name}`} onChange={(event) => replaceProperty('pan', event.currentTarget.valueAsNumber)} />
      <div className="grid grid-cols-2 gap-1">
        <Button size="sm" variant={track.muted ? 'primary' : 'ghost'} aria-pressed={track.muted} disabled={readOnly} onClick={() => onReplaceTrack({ ...track, muted: !track.muted })}>M</Button>
        <Button size="sm" variant={track.solo ? 'primary' : 'ghost'} aria-pressed={track.solo} disabled={readOnly} onClick={() => onReplaceTrack({ ...track, solo: !track.solo })}>S</Button>
      </div>
      <span className={cn('text-center font-mono text-2xs', peak >= 0.95 ? 'text-fail-text' : 'text-neutral-500')}>{Math.round(peak * 100)}%</span>
    </div>
  );
}

export function applyMixerAutomation(
  track: TimelineTrack,
  mode: MixerAutomationMode,
  property: TrackAudioProperty,
  timelineTime: number,
  durationSeconds: number,
  value: number,
  fps: number,
  createId: () => string,
): TimelineTrack {
  if (mode === 'read') return track;
  if (mode === 'off') return { ...track, [property]: value };
  if (mode === 'touch') return upsertTrackAudioKeyframe(track, property, timelineTime, value, fps, createId());
  const retained = mode === 'write'
    ? track.keyframes.filter((keyframe) => keyframe.property !== property)
    : track.keyframes.filter((keyframe) => keyframe.property !== property || keyframe.time < timelineTime);
  let replacement = { ...track, keyframes: retained };
  replacement = upsertTrackAudioKeyframe(replacement, property, timelineTime, value, fps, createId());
  return upsertTrackAudioKeyframe(replacement, property, durationSeconds, value, fps, createId());
}

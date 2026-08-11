import { Timeline, type TimelineState } from '@xzdarcy/react-timeline-editor';
import '@xzdarcy/react-timeline-editor/dist/react-timeline-editor.css';
import { Crosshair, Flag } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, type ComponentProps, type CSSProperties } from 'react';

import type { EditorMarker } from '../../shared/desktop/dto';
import type { KillAxisEvent } from './advancedEditing';
import type { TimelineTrack } from './timelineStore';

type TimelineProps = ComponentProps<typeof Timeline>;
type TimelineRows = TimelineProps['editorData'];
type TimelineAction = TimelineRows[number]['actions'][number];

type EditorTimelineProps = {
  tracks: TimelineTrack[];
  markers: EditorMarker[];
  killEvents: KillAxisEvent[];
  selectedClipIds: string[];
  playhead: number;
  duration: number;
  zoom: number;
  snapping: boolean;
  disabled: boolean;
  waveforms: Record<string, number[]>;
  onSeek: (time: number) => void;
  onSelectClip: (clipId: string | null, additive?: boolean) => void;
  onMoveClip: (clipId: string, trackId: string, start: number) => void;
  onResizeClip: (clipId: string, start: number, end: number, direction: 'left' | 'right') => void;
};

const EVENT_ROW_ID = '__editor-events__';
const MARKER_PREFIX = 'marker:';
const KILL_PREFIX = 'kill:';

function WaveformThumbnail({ points }: { points: number[] | undefined }) {
  if (!points || points.length === 0) return null;
  const coordinates = points.map((point, index) => {
    const x = points.length === 1 ? 0 : index * 100 / (points.length - 1);
    return `${x.toFixed(2)},${(50 - Math.max(0, Math.min(1, point)) * 42).toFixed(2)}`;
  }).join(' ');
  return <svg className="waveform" viewBox="0 0 100 50" preserveAspectRatio="none" aria-hidden="true"><polyline points={coordinates} /></svg>;
}

export const EditorTimeline = memo(function EditorTimeline({
  tracks,
  markers,
  killEvents,
  selectedClipIds,
  playhead,
  duration,
  zoom,
  snapping,
  disabled,
  waveforms,
  onSeek,
  onSelectClip,
  onMoveClip,
  onResizeClip,
}: EditorTimelineProps) {
  const timelineRef = useRef<TimelineState | null>(null);
  const clipIndex = useMemo(() => new Map(
    tracks.flatMap((track) => track.clips.map((clip) => [clip.id, { clip, track }] as const)),
  ), [tracks]);
  const markerIndex = useMemo(() => new Map(markers.map((marker) => [marker.id, marker])), [markers]);
  const killIndex = useMemo(() => new Map(killEvents.map((event) => [`${event.clip_id}:${event.id}`, event])), [killEvents]);

  const editorData = useMemo<TimelineRows>(() => {
    const events: TimelineAction[] = [
      ...markers.map((marker) => ({
        id: `${MARKER_PREFIX}${marker.id}`,
        start: marker.time,
        end: Math.min(duration + 0.1, marker.time + 0.08),
        effectId: `${MARKER_PREFIX}${marker.id}`,
        movable: false,
        flexible: false,
      })),
      ...killEvents.map((event) => ({
        id: `${KILL_PREFIX}${event.clip_id}:${event.id}`,
        start: event.timeline_time,
        end: Math.min(duration + 0.1, event.timeline_time + 0.08),
        effectId: `${KILL_PREFIX}${event.clip_id}:${event.id}`,
        movable: false,
        flexible: false,
      })),
    ];
    return [
      { id: EVENT_ROW_ID, rowHeight: 30, actions: events },
      ...tracks.map((track) => ({
        id: track.id,
        rowHeight: 54,
        classNames: [`editor-timeline-row--${track.kind}`],
        actions: track.clips.map((clip) => ({
          id: clip.id,
          start: clip.start,
          end: clip.start + clip.duration,
          effectId: clip.id,
          selected: selectedClipIds.includes(clip.id),
          movable: !disabled && !track.locked,
          flexible: !disabled && !track.locked && (clip.speedSegments?.length ?? 0) === 0,
        })),
      })),
    ];
  }, [disabled, duration, killEvents, markers, selectedClipIds, tracks]);

  const effects = useMemo<TimelineProps['effects']>(() => Object.fromEntries(
    editorData.flatMap((row) => row.actions.map((action) => [
      action.effectId,
      { id: action.effectId, name: action.effectId },
    ])),
  ), [editorData]);

  useEffect(() => {
    timelineRef.current?.setTime(playhead);
  }, [playhead]);

  const renderAction = (action: TimelineAction) => {
    if (action.id.startsWith(MARKER_PREFIX)) {
      const marker = markerIndex.get(action.id.slice(MARKER_PREFIX.length));
      return <span className="editor-timeline-event editor-timeline-event--marker" style={{ '--event-color': marker?.color ?? '#F59E0B' } as CSSProperties} title={marker?.label}><Flag size={11} /></span>;
    }
    if (action.id.startsWith(KILL_PREFIX)) {
      const event = killIndex.get(action.id.slice(KILL_PREFIX.length));
      return <span className="editor-timeline-event editor-timeline-event--kill" title={event ? `${event.attacker} → ${event.victim}${event.weapon ? ` · ${event.weapon}` : ''}` : undefined}><Crosshair size={11} /></span>;
    }
    const indexed = clipIndex.get(action.id);
    if (!indexed) return null;
    const { clip, track } = indexed;
    return (
      <span className={`editor-timeline-clip editor-timeline-clip--${track.kind}${selectedClipIds.includes(clip.id) ? ' is-selected' : ''}`} style={{ '--clip-color': clip.color } as CSSProperties}>
        {track.kind === 'audio' && clip.assetId ? <WaveformThumbnail points={waveforms[clip.assetId]} /> : null}
        <strong>{clip.name}</strong>
        <small>{clip.duration.toFixed(1)}s{clip.groupId ? ' · G' : ''}{clip.linkGroupId ? ' · L' : ''}</small>
      </span>
    );
  };

  return (
    <div className="editor-timeline-stage" role="region" aria-label="Editor timeline">
      <Timeline
        ref={timelineRef}
        editorData={editorData}
        effects={effects}
        scale={1}
        scaleSplitCount={snapping ? 10 : 5}
        scaleWidth={64 * zoom}
        minScaleCount={20}
        maxScaleCount={Math.max(20, Math.ceil(duration) + 2)}
        rowHeight={54}
        startLeft={12}
        gridSnap={snapping}
        dragLine={snapping}
        autoScroll
        disableDrag={disabled}
        style={{ height: Math.max(180, 62 + editorData.reduce((sum, row) => sum + (row.rowHeight ?? 54), 0)) }}
        getActionRender={renderAction}
        onClickTimeArea={(time) => { onSeek(time); return undefined; }}
        onCursorDrag={onSeek}
        onClickRow={(_event, { row, time }) => {
          if (row.id !== EVENT_ROW_ID) onSelectClip(null);
          onSeek(time);
        }}
        onClickAction={(event, { action }) => {
          if (action.id.startsWith(MARKER_PREFIX)) {
            const marker = markerIndex.get(action.id.slice(MARKER_PREFIX.length));
            if (marker) onSeek(marker.time);
            return;
          }
          if (action.id.startsWith(KILL_PREFIX)) {
            const kill = killIndex.get(action.id.slice(KILL_PREFIX.length));
            if (kill) onSeek(kill.timeline_time);
            return;
          }
          onSelectClip(action.id, event.ctrlKey || event.metaKey || event.shiftKey);
        }}
        onActionMoving={({ action, row }) => row.id !== EVENT_ROW_ID && !clipIndex.get(action.id)?.track.locked}
        onActionMoveEnd={({ action, row, start }) => {
          if (row.id !== EVENT_ROW_ID) onMoveClip(action.id, row.id, start);
        }}
        onActionResizing={({ action, row }) => row.id !== EVENT_ROW_ID
          && !clipIndex.get(action.id)?.track.locked
          && (clipIndex.get(action.id)?.clip.speedSegments?.length ?? 0) === 0}
        onActionResizeEnd={({ action, start, end, dir }) => {
          if (!action.id.startsWith(MARKER_PREFIX) && !action.id.startsWith(KILL_PREFIX)) {
            onResizeClip(action.id, start, end, dir);
          }
        }}
      />
    </div>
  );
});

/*
 * pages/editor — 节目监看, the artboard's upper middle.
 *
 *   00:00:31:12
 *   [K] Kael · 1v3 残局 · 第 21 回合
 *   |◀  ▶  ▶|
 *   00:00:31:12 / 00:02:04:00
 *   适应 · 50% · 100%
 *
 * ── what this monitor is, said plainly ────────────────────────────────────
 *
 * **It previews the topmost video clip under the playhead. It is not a
 * composite.** Overlays, opacity, transforms, colour grades, transitions and
 * audio mixing are not applied — those are the export renderer's, and the
 * export renderer is ffmpeg on the Rust side (`crates/media`), not something
 * this page can run.
 *
 * That limit is stated on screen (「单轨预览」), not hidden. A monitor that
 * looked like a composite and silently was not would send the user to export
 * to find out that their name plate is missing, and 「不隐藏、不静默失败」 is a
 * rule about capability as much as about errors.
 *
 * ── who owns the clock ────────────────────────────────────────────────────
 *
 * The `<video>` does, while it is playing. The playhead follows it rather than
 * driving it: a playhead advanced by `requestAnimationFrame` and a decoder
 * advancing at its own rate drift apart within seconds, and the drift is
 * audible before it is visible. So play → `video.play()`, and each frame reads
 * `video.currentTime` back into the timeline.
 *
 * When paused, the direction reverses — the timeline drives, and the element
 * is seeked to match. `synchronizeMediaPreview`'s 0.15s dead-band is what
 * keeps a seek from fighting a decode.
 *
 * ── |◀ and ▶| are seams, not clips ────────────────────────────────────────
 *
 * The artboard's transport arrows step through *cut points*, which is what an
 * editor needs when checking a cut: every clip edge on the current lane,
 * including the far edge of the last clip. `seamsOnTrack` is that list, and it
 * is shared with the razor so the two cannot disagree about where a cut is.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Seg } from '../../design/primitives';
import { Button } from '../../design/primitives';
import { clipAt, formatFrameTimecode, seamsOnTrack, timelineDuration } from '../../design/timeline';
import { useNativeShell } from '../../data/nativeShell';
import { mediaAssetStreamPath } from '../../data/mediaAssets';
import type { EditorPanelProps } from './editorContract';

/** The artboard's 适应 / 50% / 100%. */
type MonitorScale = 'fit' | 'half' | 'full';

const SCALE_CLASS: Record<MonitorScale, string> = {
  fit: 'max-h-full max-w-full',
  half: 'max-h-[50%] max-w-[50%]',
  full: 'max-h-none max-w-none',
};

export function ProgramMonitor({ desk }: EditorPanelProps) {
  const shell = useNativeShell();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [scale, setScale] = useState<MonitorScale>('fit');

  const { editor, document } = desk;
  const { timeline } = editor;

  /* The topmost video lane with something under the playhead. Lane order is
     the stack order (`toEditorDocument` sorted by `order`), so the first hit
     from the top is what a composite would show on top. */
  const active = useMemo(() => {
    for (const track of timeline.tracks) {
      if (track.kind !== 'video' && track.kind !== 'overlay') continue;
      const clip = clipAt(timeline, track.id, timeline.playhead);
      if (clip !== undefined) return { clip, trackId: track.id };
    }
    return null;
  }, [timeline]);

  const wire = active === null || document === null ? null : (document.clips.get(active.clip.id) ?? null);
  const assetId = wire?.asset_id ?? null;
  const src = assetId === null ? null : shell.mediaSrc(mediaAssetStreamPath(assetId));

  /* Where inside the source file the playhead is. Speed scales it: at 200% a
     second of timeline is two seconds of media. */
  const sourceTime =
    active === null ? 0 : active.clip.sourceIn + (timeline.playhead - active.clip.start) * active.clip.speed;

  /* Paused: the timeline drives, so seek the element to match. Playing: the
     element drives and this effect must not touch `currentTime`, or every
     frame would seek back to where the playhead was one frame ago. */
  useEffect(() => {
    const element = videoRef.current;
    if (element === null || playing) return;
    if (Number.isFinite(element.duration) && Math.abs(element.currentTime - sourceTime) > 0.15) {
      element.currentTime = Math.max(0, sourceTime);
    }
  }, [playing, sourceTime]);

  /* Playing: read the decoder's clock back into the timeline every frame. */
  useEffect(() => {
    const element = videoRef.current;
    if (!playing || element === null || active === null) return undefined;
    if (typeof requestAnimationFrame !== 'function') return undefined;

    let frame = requestAnimationFrame(function step() {
      frame = requestAnimationFrame(step);
      const clip = active.clip;
      const elapsed = (element.currentTime - clip.sourceIn) / clip.speed;
      const next = clip.start + elapsed;
      // Past this clip's out point there is nothing more to show from this
      // file. Stopping is the honest end of a single-lane preview; carrying on
      // would play the next clip's media through the wrong window.
      if (next >= clip.start + clip.duration) {
        element.pause();
        setPlaying(false);
        editor.setPlayhead(clip.start + clip.duration);
        return;
      }
      editor.setPlayhead(next);
    });
    return () => cancelAnimationFrame(frame);
  }, [active, editor, playing]);

  /* A clip change while playing means a different file; stop rather than
     letting the element keep playing the old one behind a new label. */
  useEffect(() => {
    setPlaying(false);
    videoRef.current?.pause();
  }, [active?.clip.id]);

  const seams = active === null ? [] : seamsOnTrack(timeline, active.trackId);
  const previousSeam = [...seams].reverse().find((time) => time < timeline.playhead - 1e-6);
  const nextSeam = seams.find((time) => time > timeline.playhead + 1e-6);
  const total = timelineDuration(timeline);

  return (
    <section className="flex min-h-0 flex-col gap-2 p-3" aria-label={t`节目监看`}>
      <div className="flex flex-none items-baseline gap-2">
        <h2 className="text-sm font-medium">
          <Trans>节目监看</Trans>
        </h2>
        <span className="text-2xs text-neutral-700">
          {/* Said out loud — see the module comment. */}
          <Trans>单轨预览，不含叠加与调色</Trans>
        </span>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-neutral-900">
        {src === null ? (
          <p className="p-6 text-center text-xs text-neutral-300" data-testid="monitor-empty">
            {active === null ? (
              <Trans>播放头下没有画面</Trans>
            ) : (
              <Trans>这个片段没有可播放的素材</Trans>
            )}
          </p>
        ) : (
          <video
            ref={videoRef}
            className={SCALE_CLASS[scale]}
            src={src}
            data-testid="monitor-video"
            preload="metadata"
            onEnded={() => setPlaying(false)}
          />
        )}
      </div>

      <div className="flex flex-none flex-wrap items-center gap-2">
        <span className="font-mono text-sm" data-testid="monitor-timecode">
          {formatFrameTimecode(timeline.playhead, timeline.fps)}
        </span>
        <span className="truncate text-xs text-neutral-700">{active?.clip.label ?? '—'}</span>

        <span className="flex-1" />

        <Button
          variant="secondary"
          size="sm"
          icon
          aria-label={t`上一个剪切点`}
          disabled={previousSeam === undefined}
          disabledReason={t`前面没有剪切点了`}
          onClick={() => {
            if (previousSeam !== undefined) editor.setPlayhead(previousSeam);
          }}
        >
          |◀
        </Button>
        <Button
          variant="secondary"
          size="sm"
          icon
          aria-label={playing ? t`暂停` : t`播放`}
          disabled={src === null}
          disabledReason={t`播放头下没有可播放的素材`}
          onClick={() => {
            const element = videoRef.current;
            if (element === null) return;
            if (playing) {
              element.pause();
              setPlaying(false);
              return;
            }
            element.currentTime = Math.max(0, sourceTime);
            element.playbackRate = Math.max(0.05, Math.min(16, active?.clip.speed ?? 1));
            void element.play().catch(() => setPlaying(false));
            setPlaying(true);
          }}
        >
          {playing ? '❚❚' : '▶'}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          icon
          aria-label={t`下一个剪切点`}
          disabled={nextSeam === undefined}
          disabledReason={t`后面没有剪切点了`}
          onClick={() => {
            if (nextSeam !== undefined) editor.setPlayhead(nextSeam);
          }}
        >
          ▶|
        </Button>

        <span className="font-mono text-2xs text-neutral-700" data-testid="monitor-total">
          {formatFrameTimecode(timeline.playhead, timeline.fps)} / {formatFrameTimecode(total, timeline.fps)}
        </span>

        <Seg
          name="monitor-scale"
          value={scale}
          size="sm"
          aria-label={t`预览比例`}
          options={[
            { value: 'fit' as const, label: <Trans>适应</Trans> },
            { value: 'half' as const, label: '50%' },
            { value: 'full' as const, label: '100%' },
          ]}
          onChange={setScale}
        />
      </div>
    </section>
  );
}

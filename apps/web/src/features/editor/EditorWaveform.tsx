import { useEffect, useRef } from 'react';
import type WaveSurfer from 'wavesurfer.js';

type EditorWaveformProps = {
  url: string;
  peaks: number[];
  duration: number;
  currentTime: number;
  onSeek: (time: number) => void;
};

export function EditorWaveform({ url, peaks, duration, currentTime, onSeek }: EditorWaveformProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const waveformRef = useRef<WaveSurfer | null>(null);
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !url || !Number.isFinite(duration) || duration <= 0) return undefined;
    let disposed = false;
    let destroy: (() => void) | undefined;

    void import('wavesurfer.js').then(({ default: WaveSurfer }) => {
      if (disposed) return;
      const waveform = WaveSurfer.create({
        container,
        url,
        duration,
        ...(peaks.length > 0 ? { peaks: [Float32Array.from(peaks)] } : {}),
        height: 68,
        normalize: true,
        interact: true,
        dragToSeek: true,
        waveColor: '#9DB2CE',
        progressColor: '#2563EB',
        cursorColor: '#0F172A',
        cursorWidth: 2,
        barWidth: 2,
        barGap: 2,
        barRadius: 2,
      });
      waveform.on('interaction', (time) => onSeekRef.current(time));
      waveform.on('error', () => undefined);
      waveform.setTime(Math.max(0, Math.min(duration, currentTime)));
      waveformRef.current = waveform;
      destroy = () => {
        waveformRef.current = null;
        waveform.destroy();
      };
    });

    return () => {
      disposed = true;
      destroy?.();
    };
  }, [duration, peaks, url]);

  useEffect(() => {
    waveformRef.current?.setTime(Math.max(0, Math.min(duration, currentTime)));
  }, [currentTime, duration]);

  return <div ref={containerRef} className="editor-waveform" aria-label="Audio waveform" />;
}

import { useEffect } from 'react';
import type { RefObject } from 'react';

interface MediaAudioGraph {
  readonly gain: GainNode;
  readonly clipPan: StereoPannerNode;
  readonly trackPan: StereoPannerNode;
}

let sharedContext: AudioContext | null = null;
const graphs = new WeakMap<HTMLMediaElement, MediaAudioGraph>();

export function useMediaAudioOutput(
  mediaRef: RefObject<HTMLMediaElement | null>,
  gain: number,
  clipPan: number,
  trackPan: number,
  muted: boolean,
) {
  useEffect(() => {
    const media = mediaRef.current;
    if (media === null) return;
    const graph = mediaAudioGraph(media);
    if (graph === null) {
      media.volume = Math.min(1, Math.max(0, gain));
      media.muted = muted;
      return;
    }
    media.volume = 1;
    media.muted = false;
    graph.gain.gain.value = muted ? 0 : Math.max(0, gain);
    graph.clipPan.pan.value = Math.min(1, Math.max(-1, clipPan));
    graph.trackPan.pan.value = Math.min(1, Math.max(-1, trackPan));
  }, [clipPan, gain, mediaRef, muted, trackPan]);
}

export function resumeMediaAudioOutput(): void {
  if (sharedContext?.state === 'suspended') void sharedContext.resume();
}

function mediaAudioGraph(media: HTMLMediaElement): MediaAudioGraph | null {
  const existing = graphs.get(media);
  if (existing !== undefined) return existing;
  const AudioContextConstructor = globalThis.AudioContext;
  if (AudioContextConstructor === undefined) return null;
  sharedContext ??= new AudioContextConstructor();
  if (typeof sharedContext.createStereoPanner !== 'function') return null;
  const source = sharedContext.createMediaElementSource(media);
  const gain = sharedContext.createGain();
  const clipPan = sharedContext.createStereoPanner();
  const trackPan = sharedContext.createStereoPanner();
  source.connect(gain).connect(clipPan).connect(trackPan).connect(sharedContext.destination);
  const graph = { gain, clipPan, trackPan };
  graphs.set(media, graph);
  return graph;
}

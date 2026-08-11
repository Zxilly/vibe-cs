import { msg } from '../../shared/i18n';
import type { AppConfig, ObsDiagnosis, ObsVideoSettings } from '../../shared/api/dto';

const MAXIMUM_DIAGNOSIS_ATTEMPTS = 10;
const MAXIMUM_RETRY_DELAY_MS = 2_000;

type WaitForRetry = (delayMs: number, signal?: AbortSignal) => Promise<void>;

export type ObsDiagnosisRetryOptions = {
  attempts?: number;
  delayMs?: number;
  signal?: AbortSignal;
  wait?: WaitForRetry;
};

export function hasUnsavedObsRuntimeSettings(current: AppConfig, saved: AppConfig): boolean {
  const currentObs = current.obs;
  const savedObs = saved.obs;
  return currentObs.host !== savedObs.host
    || currentObs.port !== savedObs.port
    || currentObs.password !== savedObs.password
    || currentObs.executable !== savedObs.executable
    || currentObs.scene !== savedObs.scene
    || current.recording.resolution !== saved.recording.resolution
    || current.recording.fps !== saved.recording.fps;
}

export function formatObsFrameRate(video: ObsVideoSettings): string {
  if (video.fps_denominator <= 0) return msg("m0147");
  const framesPerSecond = video.fps_numerator / video.fps_denominator;
  return Number.isInteger(framesPerSecond)
    ? `${framesPerSecond} FPS`
    : `${framesPerSecond.toFixed(2)} FPS`;
}

export async function retryObsDiagnosis(
  diagnose: (signal?: AbortSignal) => Promise<ObsDiagnosis>,
  options: ObsDiagnosisRetryOptions = {},
): Promise<ObsDiagnosis> {
  const attempts = Math.min(
    MAXIMUM_DIAGNOSIS_ATTEMPTS,
    Math.max(1, Math.trunc(options.attempts ?? 7)),
  );
  const delayMs = Math.min(
    MAXIMUM_RETRY_DELAY_MS,
    Math.max(0, Math.trunc(options.delayMs ?? 600)),
  );
  const wait = options.wait ?? waitForRetry;
  let latestError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (options.signal?.aborted) throw abortError();
    try {
      return await diagnose(options.signal);
    } catch (error) {
      latestError = error;
      if (options.signal?.aborted || attempt === attempts) throw error;
      await wait(delayMs, options.signal);
    }
  }

  throw latestError;
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
    const abort = () => {
      globalThis.clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function abortError(): DOMException {
  return new DOMException('OBS diagnosis was cancelled.', 'AbortError');
}

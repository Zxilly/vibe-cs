import { DesktopError, readableError } from '../../shared/desktop/client';
import type { ActivityItem } from '../../shared/desktop/dto';
import { isActivityActive } from './activityPresentation';
import type { ActivityLocator } from './activitySelection';

const ACTIVE_POLL_MS = 1_500;
const MAXIMUM_RETRY_MS = 15_000;

export type ActivityObservation = {
  item: ActivityItem | null;
  loading: boolean;
  stale: boolean;
  error: string | null;
  unavailable: boolean;
};

type StartActivityObservationOptions = {
  locator: ActivityLocator;
  load: (
    kind: ActivityLocator['kind'],
    jobId: string,
    signal: AbortSignal,
  ) => Promise<ActivityItem>;
  onChange: (observation: ActivityObservation) => void;
};

function retryDelay(failures: number): number {
  const exponent = Math.max(0, failures - 1);
  return Math.min(ACTIVE_POLL_MS * (2 ** exponent), MAXIMUM_RETRY_MS);
}

export function startActivityObservation({
  locator,
  load,
  onChange,
}: StartActivityObservationOptions): () => void {
  const controller = new AbortController();
  let disposed = false;
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let lastGood: ActivityItem | null = null;
  let failures = 0;

  const emit = (observation: ActivityObservation) => {
    if (!disposed) onChange(observation);
  };
  const schedule = (delay: number) => {
    timer = globalThis.setTimeout(() => void refresh(), delay);
  };
  const refresh = async () => {
    try {
      const item = await load(locator.kind, locator.jobId, controller.signal);
      if (disposed) return;
      if (
        item.kind !== locator.kind
        || item.job_id !== locator.jobId
        || item.id !== locator.id
      ) {
        throw new Error('Activity response does not match the requested exact locator.');
      }
      lastGood = item;
      failures = 0;
      emit({ item, loading: false, stale: false, error: null, unavailable: false });
      if (isActivityActive(item)) schedule(ACTIVE_POLL_MS);
    } catch (cause) {
      if (disposed || controller.signal.aborted) return;
      if (cause instanceof DesktopError && cause.status === 404) {
        lastGood = null;
        emit({
          item: null,
          loading: false,
          stale: false,
          error: readableError(cause),
          unavailable: true,
        });
        return;
      }
      failures += 1;
      emit({
        item: lastGood,
        loading: false,
        stale: lastGood !== null,
        error: readableError(cause),
        unavailable: false,
      });
      schedule(retryDelay(failures));
    }
  };

  emit({ item: null, loading: true, stale: false, error: null, unavailable: false });
  void refresh();

  return () => {
    disposed = true;
    controller.abort();
    if (timer !== undefined) globalThis.clearTimeout(timer);
  };
}

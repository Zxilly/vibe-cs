import { readableError } from '../../shared/desktop/client';
import type { ActivityFeed } from '../../shared/desktop/viewModels';

const ACTIVE_POLL_MS = 1_500;
const MAXIMUM_RETRY_MS = 15_000;

export type ProductionActivityObservation = {
  feed: ActivityFeed;
  stale: boolean;
  error: string | null;
};

type StartProductionActivityObservationOptions = {
  initial: ActivityFeed;
  load: (signal: AbortSignal) => Promise<ActivityFeed>;
  onChange: (observation: ProductionActivityObservation) => void;
};

type StartProductionActivityObservationAfterInitialOptions = Omit<
  StartProductionActivityObservationOptions,
  'initial'
> & {
  initial: Promise<ActivityFeed>;
};

function retryDelay(failures: number): number {
  return Math.min(ACTIVE_POLL_MS * (2 ** Math.max(0, failures - 1)), MAXIMUM_RETRY_MS);
}

export function startProductionActivityObservation({
  initial,
  load,
  onChange,
}: StartProductionActivityObservationOptions): () => void {
  const controller = new AbortController();
  let disposed = false;
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let lastGood = initial;
  let failures = 0;

  const emit = (observation: ProductionActivityObservation) => {
    if (!disposed) onChange(observation);
  };
  const schedule = (delay: number) => {
    timer = globalThis.setTimeout(() => void refresh(), delay);
  };
  const refresh = async () => {
    try {
      const feed = await load(controller.signal);
      if (disposed) return;
      lastGood = feed;
      failures = 0;
      emit({ feed, stale: false, error: null });
      if (feed.summary.active > 0) schedule(ACTIVE_POLL_MS);
    } catch (cause) {
      if (disposed || controller.signal.aborted) return;
      failures += 1;
      emit({ feed: lastGood, stale: true, error: readableError(cause) });
      schedule(retryDelay(failures));
    }
  };

  emit({ feed: initial, stale: false, error: null });
  if (initial.summary.active > 0) schedule(ACTIVE_POLL_MS);

  return () => {
    disposed = true;
    controller.abort();
    if (timer !== undefined) globalThis.clearTimeout(timer);
  };
}

export function startProductionActivityObservationAfterInitial({
  initial,
  load,
  onChange,
}: StartProductionActivityObservationAfterInitialOptions): () => void {
  let disposed = false;
  let stopObservation: (() => void) | undefined;

  void initial.then((feed) => {
    if (disposed) return;
    stopObservation = startProductionActivityObservation({ initial: feed, load, onChange });
  }, () => {
    // The overview owns the initial request error. This bootstrap only owns polling lifetime.
  });

  return () => {
    disposed = true;
    stopObservation?.();
  };
}

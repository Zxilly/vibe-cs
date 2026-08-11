import { useCallback, useRef, useState } from 'react';

import { readableError } from '../desktop/client';

type AsyncState<T> =
  | { status: 'idle'; data: null; message: null }
  | { status: 'loading'; data: null; message: null }
  | { status: 'success'; data: T; message: string | null }
  | { status: 'error'; data: null; message: string };

export function useAsyncAction<T>() {
  const generation = useRef(0);
  const [state, setState] = useState<AsyncState<T>>({
    status: 'idle',
    data: null,
    message: null,
  });

  const run = useCallback(async (action: () => Promise<T>, successMessage?: string) => {
    const currentGeneration = generation.current + 1;
    generation.current = currentGeneration;
    setState({ status: 'loading', data: null, message: null });
    try {
      const data = await action();
      if (generation.current !== currentGeneration) return null;
      setState({ status: 'success', data, message: successMessage ?? null });
      return data;
    } catch (error) {
      if (generation.current !== currentGeneration) return null;
      setState({ status: 'error', data: null, message: readableError(error) });
      return null;
    }
  }, []);

  const reset = useCallback(() => {
    generation.current += 1;
    setState({ status: 'idle', data: null, message: null });
  }, []);

  return { state, run, reset };
}

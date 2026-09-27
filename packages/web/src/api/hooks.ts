/**
 * Minimal data-fetching hooks. Deliberately tiny: a `useQuery` with abort +
 * refetch, a `useMutation` with pending/error state, and `useDebounce`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { toApiError, type ApiError } from './client';

export interface QueryResult<T> {
  data: T | null;
  error: ApiError | null;
  /** True only for the very first load, so refreshes do not blank the view. */
  isLoading: boolean;
  isRefreshing: boolean;
  refetch: () => void;
  setData: (updater: T | ((previous: T | null) => T | null)) => void;
}

export interface QueryOptions {
  /** Skip the request entirely (e.g. the id is not known yet). */
  enabled?: boolean;
  /** Extra identity values; changing any of them refetches. */
  deps?: readonly unknown[];
}

/**
 * Runs `fetcher` whenever `deps` change. A stale response is discarded by
 * comparing an incrementing request id, so rapid filter changes cannot render
 * out-of-order data.
 */
export function useQuery<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  options: QueryOptions = {},
): QueryResult<T> {
  const { enabled = true } = options;
  const [data, setDataState] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [nonce, setNonce] = useState(0);

  const requestId = useRef(0);
  const hasData = useRef(false);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    if (!enabled) return undefined;
    const id = ++requestId.current;
    const controller = new AbortController();
    if (hasData.current) setIsRefreshing(true);
    else setIsLoading(true);

    fetcherRef
      .current(controller.signal)
      .then((result) => {
        if (id !== requestId.current) return;
        hasData.current = true;
        setDataState(result);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (id !== requestId.current) return;
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setError(toApiError(cause));
      })
      .finally(() => {
        if (id !== requestId.current) return;
        setIsLoading(false);
        setIsRefreshing(false);
      });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, nonce, ...deps]);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);
  const setData = useCallback((updater: T | ((previous: T | null) => T | null)) => {
    setDataState((previous) =>
      typeof updater === 'function'
        ? (updater as (p: T | null) => T | null)(previous)
        : updater,
    );
  }, []);

  return { data, error, isLoading, isRefreshing, refetch, setData };
}

export interface MutationResult<TVars, TData> {
  mutate: (vars: TVars) => Promise<TData | null>;
  isPending: boolean;
  error: ApiError | null;
  reset: () => void;
}

/** Wraps a write so every caller gets pending/error state without boilerplate. */
export function useMutation<TVars, TData>(
  mutator: (vars: TVars) => Promise<TData>,
  options: {
    onError?: (error: ApiError, vars: TVars) => void;
    onSuccess?: (data: TData, vars: TVars) => void;
  } = {},
): MutationResult<TVars, TData> {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const mounted = useRef(true);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const mutate = useCallback(
    async (vars: TVars) => {
      setIsPending(true);
      setError(null);
      try {
        const result = await mutator(vars);
        if (mounted.current) optionsRef.current.onSuccess?.(result, vars);
        return result;
      } catch (cause) {
        const apiError = toApiError(cause);
        if (mounted.current) {
          setError(apiError);
          optionsRef.current.onError?.(apiError, vars);
        }
        return null;
      } finally {
        if (mounted.current) setIsPending(false);
      }
    },
    [mutator],
  );

  const reset = useCallback(() => setError(null), []);
  return { mutate, isPending, error, reset };
}

/** Delays propagation of a rapidly changing value (search boxes). */
export function useDebounce<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** Re-renders on an interval; used for live SLA countdowns and relative times. */
export function useTicker(intervalMs = 30_000): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((n) => n + 1), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return tick;
}

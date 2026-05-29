import { useState, useEffect, useCallback } from 'react';

interface UseFetchState<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export function useFetch<T>(
  fetchFn: () => Promise<T>,
  dependencies: unknown[] = []
): UseFetchState<T> {
  const [state, setState] = useState<UseFetchState<T>>({
    data: null,
    loading: true,
    error: null,
    refetch: async () => {},
  });

  const executeQuery = useCallback(async () => {
    try {
      setState((prev) => ({ ...prev, loading: true, error: null }));
      const result = await fetchFn();
      setState((prev) => ({ ...prev, data: result, loading: false, error: null }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        data: null,
        loading: false,
        error: err instanceof Error ? err : new Error('Unknown error'),
      }));
    }
  }, [fetchFn]);

  useEffect(() => {
    let isMounted = true;

    (async () => {
      try {
        setState((prev) => ({ ...prev, loading: true, error: null }));
        const result = await fetchFn();
        if (isMounted) {
          setState((prev) => ({ ...prev, data: result, loading: false, error: null }));
        }
      } catch (err) {
        if (isMounted) {
          setState((prev) => ({
            ...prev,
            data: null,
            loading: false,
            error: err instanceof Error ? err : new Error('Unknown error'),
          }));
        }
      }
    })();

    return () => {
      isMounted = false;
    };
  }, dependencies);

  return {
    ...state,
    refetch: executeQuery,
  };
}

import { QueryClient } from '@tanstack/react-query';

import { ApiRequestError } from './api-client.js';

/**
 * TanStack Query configuration.
 *
 * Retry policy is deliberately narrow. Retrying a 4xx cannot succeed — the
 * request was rejected on its content — and retrying a 401 is pointless because
 * the API client has already tried to refresh the session. Only transport
 * failures and 5xx responses are retried, twice.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        if (failureCount >= 2) return false;
        if (error instanceof ApiRequestError) {
          if (error.isNetworkFailure) return true;
          return error.statusCode >= 500;
        }
        return false;
      },
      retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 8_000),
      // Live figures (CPU, processes) poll; static data is cached briefly.
      staleTime: 5_000,
      refetchOnWindowFocus: true,
    },
    mutations: {
      // A mutation that failed for a reason the server explained must not be
      // replayed silently: the user needs to see the error.
      retry: false,
    },
  },
});

/** Query key factory, so a key is never spelled out twice. */
export const queryKeys = {
  systemInfo: ['system', 'info'] as const,
  processes: (search: string, sortBy: string) => ['system', 'processes', search, sortBy] as const,
  instance: ['system', 'instance'] as const,
  settings: ['system', 'settings'] as const,
  directory: (path: string, showHidden: boolean) => ['files', 'list', path, showHidden] as const,
  fileContent: (path: string) => ['files', 'read', path] as const,
  fileSearch: (path: string, query: string) => ['files', 'search', path, query] as const,
  audit: (action: string | undefined, limit: number) => ['audit', action ?? 'all', limit] as const,
  sessions: ['auth', 'sessions'] as const,
  users: ['users'] as const,
  terminals: ['terminal', 'sessions'] as const,
  terminalStatus: ['terminal', 'status'] as const,
};

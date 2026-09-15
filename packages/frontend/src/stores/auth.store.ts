import { create } from 'zustand';

import {
  ApiRequestError,
  apiRequest,
  clearTokens,
  hasRefreshToken,
  setSession,
  onSessionCleared,
} from '../lib/api-client.js';

import type { LoginResponse, PublicUser } from '@aether/shared';

/**
 * Authentication state for the whole UI.
 *
 * On boot the app does not know whether it is looking at a brand-new instance
 * (which needs an owner account created), an instance with no session, or an
 * instance with a valid refresh token. `initialise` resolves that once, and the
 * shell renders a spinner until it has.
 */

export type AuthStatus = 'initialising' | 'anonymous' | 'authenticated';

interface AuthState {
  status: AuthStatus;
  user: PublicUser | null;
  /** True when the instance has zero users and needs its owner account. */
  requiresBootstrap: boolean;
  /** Set when boot itself failed, e.g. the backend or database is unreachable. */
  bootError: string | null;
  /** Set when a sign-in or bootstrap attempt was rejected. */
  formError: string | null;
  submitting: boolean;

  initialise: () => Promise<void>;
  login: (username: string, password: string) => Promise<boolean>;
  bootstrap: (username: string, password: string, email?: string) => Promise<boolean>;
  logout: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  clearFormError: () => void;
}

function messageOf(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Please try again.';
}

export const useAuthStore = create<AuthState>((set, get) => ({
  status: 'initialising',
  user: null,
  requiresBootstrap: false,
  bootError: null,
  formError: null,
  submitting: false,

  initialise: async () => {
    set({ status: 'initialising', bootError: null });

    try {
      const bootstrap = await apiRequest<{ requiresBootstrap: boolean }>(
        '/api/auth/bootstrap-status',
        { authenticated: false, allowRefresh: false }
      );

      if (bootstrap.requiresBootstrap) {
        set({ status: 'anonymous', requiresBootstrap: true, user: null });
        return;
      }
    } catch (error) {
      // The backend answers this without authentication, so a failure here
      // means the API or its database is unreachable — not a credentials
      // problem. Report it rather than showing a login form that cannot work.
      set({ status: 'anonymous', bootError: messageOf(error), user: null });
      return;
    }

    if (!hasRefreshToken()) {
      set({ status: 'anonymous', requiresBootstrap: false, user: null });
      return;
    }

    try {
      // The API client exchanges the refresh token automatically when this
      // returns 401, so a successful call here also proves the refresh token
      // is still good.
      const user = await apiRequest<PublicUser>('/api/auth/me');
      set({ status: 'authenticated', user, requiresBootstrap: false });
    } catch {
      clearTokens();
      set({ status: 'anonymous', user: null, requiresBootstrap: false });
    }
  },

  login: async (username, password) => {
    set({ submitting: true, formError: null });
    try {
      const response = await apiRequest<LoginResponse>('/api/auth/login', {
        method: 'POST',
        body: { username, password },
        authenticated: false,
        allowRefresh: false,
      });

      setSession(response);
      set({
        status: 'authenticated',
        user: response.user,
        submitting: false,
        requiresBootstrap: false,
      });
      return true;
    } catch (error) {
      set({ submitting: false, formError: messageOf(error) });
      return false;
    }
  },

  bootstrap: async (username, password, email) => {
    set({ submitting: true, formError: null });
    try {
      const response = await apiRequest<LoginResponse>('/api/auth/bootstrap', {
        method: 'POST',
        body: { username, password, ...(email !== undefined && email !== '' ? { email } : {}) },
        authenticated: false,
        allowRefresh: false,
      });

      setSession(response);
      set({
        status: 'authenticated',
        user: response.user,
        submitting: false,
        requiresBootstrap: false,
      });
      return true;
    } catch (error) {
      set({ submitting: false, formError: messageOf(error) });
      return false;
    }
  },

  logout: async () => {
    try {
      await apiRequest<void>('/api/auth/logout', { method: 'POST' });
    } catch {
      // The session is being discarded locally regardless; a failed server call
      // must not trap the user in a signed-in shell.
    }
    clearTokens();
    set({ status: 'anonymous', user: null, formError: null });
  },

  refreshProfile: async () => {
    if (get().status !== 'authenticated') return;
    try {
      const user = await apiRequest<PublicUser>('/api/auth/me');
      set({ user });
    } catch {
      // The API client already cleared the session if the refresh token was
      // rejected; the session-cleared listener below handles that case.
    }
  },

  clearFormError: () => set({ formError: null }),
}));

// When a refresh token is rejected mid-session the client emits this, and the
// shell returns to the login screen without any component having to poll.
onSessionCleared(() => {
  useAuthStore.setState({ status: 'anonymous', user: null });
});

/** Convenience selector: the signed-in user, or null. */
export function useCurrentUser(): PublicUser | null {
  return useAuthStore((state) => state.user);
}

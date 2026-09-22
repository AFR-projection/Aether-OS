/**
 * HTTP client for the Aether API.
 *
 * Responsibilities:
 * - attach the access token to every authenticated request,
 * - refresh it exactly once when it has expired, coalescing concurrent
 *   refreshes so ten parallel requests do not trigger ten rotations
 *   (a rotation invalidates the previous refresh token, so racing refreshes
 *   would log the user out),
 * - unwrap the `{ data }` envelope and turn `{ error }` into a typed exception.
 *
 * Token storage, and why it is what it is:
 * - The **access token lives in memory only**. A reload loses it, and it is
 *   exchanged for a new one using the refresh token. Nothing can read it out of
 *   `localStorage` because it is never written there.
 * - The **refresh token is persisted in `localStorage`**, because otherwise
 *   every page reload would sign the user out. This is the weakest point in the
 *   client and it is documented in KNOWN-LIMITATIONS.md: any XSS on this origin
 *   could exfiltrate it. The mitigations in place are a strict CSP with no
 *   `unsafe-inline` for scripts, no `dangerouslySetInnerHTML` anywhere in this
 *   package, and server-side session revocation. The correct fix is an
 *   httpOnly cookie plus a CSRF token, which requires backend changes.
 */

import { notify } from '../stores/notification.store.js';

import type { ApiErrorResponse, LoginResponse, TokenPair } from '@aether/shared';

const REFRESH_STORAGE_KEY = 'aether.refreshToken';

/** Thrown for every non-2xx response, and for transport failures. */
export class ApiRequestError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details: unknown;
  readonly requestId: string | undefined;

  constructor(params: {
    code: string;
    message: string;
    statusCode: number;
    details?: unknown;
    requestId?: string;
  }) {
    super(params.message);
    this.name = 'ApiRequestError';
    this.code = params.code;
    this.statusCode = params.statusCode;
    this.details = params.details;
    this.requestId = params.requestId;
  }

  /** True when the caller is not authenticated and retrying will not help. */
  get isAuthFailure(): boolean {
    return this.statusCode === 401;
  }

  get isNetworkFailure(): boolean {
    return this.statusCode === 0;
  }
}

let accessToken: string | null = null;
let refreshToken: string | null = readPersistedRefreshToken();
let refreshInFlight: Promise<boolean> | null = null;
const sessionClearedListeners = new Set<() => void>();

function readPersistedRefreshToken(): string | null {
  try {
    return window.localStorage.getItem(REFRESH_STORAGE_KEY);
  } catch {
    // Storage can be unavailable (disabled cookies, some private modes). A
    // failure here must degrade to "session does not survive reload", not to a
    // crash on boot.
    return null;
  }
}

function persistRefreshToken(token: string | null): void {
  try {
    if (token === null) {
      window.localStorage.removeItem(REFRESH_STORAGE_KEY);
    } else {
      window.localStorage.setItem(REFRESH_STORAGE_KEY, token);
    }
  } catch {
    // Persisting is best-effort; the in-memory copy still works for this tab.
  }
}

/** Stores a freshly issued token pair. */
export function setTokens(pair: Pick<TokenPair, 'accessToken' | 'refreshToken'>): void {
  accessToken = pair.accessToken;
  refreshToken = pair.refreshToken;
  persistRefreshToken(pair.refreshToken);
}

/** Stores the tokens from a login or refresh response. */
export function setSession(response: LoginResponse): void {
  setTokens(response);
}

/** Drops every token. The next authenticated request will fail with 401. */
export function clearTokens(): void {
  accessToken = null;
  refreshToken = null;
  persistRefreshToken(null);
}

export function hasRefreshToken(): boolean {
  return refreshToken !== null;
}

/**
 * Registers a callback fired when the session is definitively gone (refresh
 * token rejected). The shell uses this to return to the login screen.
 */
export function onSessionCleared(listener: () => void): () => void {
  sessionClearedListeners.add(listener);
  return () => sessionClearedListeners.delete(listener);
}

function notifySessionCleared(): void {
  for (const listener of sessionClearedListeners) listener();
}

/** Builds a query string, dropping `undefined` values. */
export function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query === '' ? '' : `?${query}`;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
  /** Send the access token. Defaults to true. */
  authenticated?: boolean;
  /** Set to false for the auth endpoints themselves, which must not recurse. */
  allowRefresh?: boolean;
  /** Raw body (used for `application/octet-stream` uploads). */
  rawBody?: BodyInit;
  contentType?: string;
}

async function parseErrorResponse(response: Response): Promise<ApiRequestError> {
  let payload: ApiErrorResponse | null = null;
  try {
    payload = (await response.json()) as ApiErrorResponse;
  } catch {
    payload = null;
  }

  const error = payload?.error;
  return new ApiRequestError({
    code: error?.code ?? 'HTTP_ERROR',
    message: error?.message ?? `Request failed with status ${response.status}`,
    statusCode: error?.statusCode ?? response.status,
    details: error?.details,
    requestId: error?.requestId ?? response.headers.get('x-request-id') ?? undefined,
  });
}

async function performRefresh(): Promise<boolean> {
  if (refreshToken === null) return false;

  const response = await fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
    credentials: 'same-origin',
  });

  if (!response.ok) {
    // The refresh token is expired, revoked, or belongs to a disabled account.
    // There is nothing left to try: drop the session.
    clearTokens();
    notifySessionCleared();
    return false;
  }

  const payload = (await response.json()) as { data: LoginResponse };
  setSession(payload.data);
  return true;
}

/** Refreshes at most once at a time; concurrent callers share the result. */
function refreshOnce(): Promise<boolean> {
  refreshInFlight ??= performRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function requestWithAuth<T>(path: string, options: RequestOptions): Promise<T> {
  const {
    method = 'GET',
    body,
    query,
    signal,
    authenticated = true,
    allowRefresh = true,
    rawBody,
    contentType,
  } = options;

  const headers: Record<string, string> = {};
  if (authenticated && accessToken !== null) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  if (rawBody === undefined && body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (contentType !== undefined) {
    headers['Content-Type'] = contentType;
  }

  let response: Response;
  try {
    response = await fetch(`${path}${buildQuery(query ?? {})}`, {
      method,
      headers,
      credentials: 'same-origin',
      ...(signal !== undefined ? { signal } : {}),
      ...(rawBody !== undefined
        ? { body: rawBody }
        : body !== undefined
          ? { body: JSON.stringify(body) }
          : {}),
    });
  } catch (cause) {
    // A transport failure is reported as statusCode 0 so callers can tell it
    // apart from a server-side rejection.
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    // A transport failure is a real system event the user should see — the
    // backend or the network is down, not just this one request. Deduped so a
    // burst of failing requests collapses to one standing warning rather than a
    // storm, and cleared by the next success only in the user's eyes (reading
    // it) — the client does not fabricate a recovery it has not observed.
    notify({
      level: 'warning',
      title: 'Connection lost',
      body: 'Could not reach the Aether backend. Retrying automatically.',
      source: 'Connection',
      dedupeKey: 'network-error',
    });
    throw new ApiRequestError({
      code: 'NETWORK_ERROR',
      message: 'Could not reach the Aether backend. Check your connection and try again.',
      statusCode: 0,
      details: { cause: String(cause) },
    });
  }

  if (response.status === 401 && authenticated && allowRefresh) {
    const refreshed = await refreshOnce();
    if (refreshed) {
      return requestWithAuth<T>(path, { ...options, allowRefresh: false });
    }
  }

  if (!response.ok) {
    throw await parseErrorResponse(response);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const payload = (await response.json()) as { data: T };
  return payload.data;
}

/** Performs an authenticated JSON request and returns the unwrapped `data`. */
export function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return requestWithAuth<T>(path, options);
}

/**
 * Downloads a file.
 *
 * The download endpoint streams bytes rather than the JSON envelope, so it
 * needs its own path through the client. The filename is read back from
 * `Content-Disposition` so a server-side rename is respected.
 */
export async function apiDownload(
  path: string,
  query: Record<string, string | number | boolean | undefined>,
  signal?: AbortSignal
): Promise<{ blob: Blob; filename: string }> {
  const headers: Record<string, string> = {};
  if (accessToken !== null) headers.Authorization = `Bearer ${accessToken}`;

  const send = () =>
    fetch(`${path}${buildQuery(query)}`, {
      method: 'GET',
      headers,
      credentials: 'same-origin',
      ...(signal !== undefined ? { signal } : {}),
    });

  let response = await send();

  if (response.status === 401) {
    const refreshed = await refreshOnce();
    if (refreshed) {
      if (accessToken !== null) headers.Authorization = `Bearer ${accessToken}`;
      response = await send();
    }
  }

  if (!response.ok) throw await parseErrorResponse(response);

  const disposition = response.headers.get('content-disposition') ?? '';
  const match = /filename\*=UTF-8''([^;]+)/i.exec(disposition);

  return {
    blob: await response.blob(),
    filename: match?.[1] !== undefined ? decodeURIComponent(match[1]) : 'download',
  };
}

/**
 * Uploads a file as a raw body.
 *
 * `scope` carries the `scope`/`agentId` query fields when the target is a host
 * agent rather than the backend workspace — without them an upload aimed at the
 * host would silently land in the container instead.
 *
 * `fetch` reports upload progress through a stream, which is not implemented
 * here — the UI shows an indeterminate state instead of a fake percentage.
 */
export async function apiUpload(
  targetDirectory: string,
  file: File,
  scope: Record<string, string> = {},
  signal?: AbortSignal
): Promise<void> {
  await apiRequest('/api/files/upload', {
    method: 'POST',
    query: { path: targetDirectory, name: file.name, ...scope },
    rawBody: file,
    contentType: 'application/octet-stream',
    ...(signal !== undefined ? { signal } : {}),
  });
}

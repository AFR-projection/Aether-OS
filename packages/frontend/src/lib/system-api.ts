/**
 * Typed wrappers for the system, audit, user, and session endpoints.
 *
 * Shared by Task Manager, System Monitor, Settings, Security Center, and the App
 * Catalog so a path or a response shape is written once.
 */

import { apiRequest } from './api-client.js';

import type {
  AuditEvent,
  AuthSession,
  Permission,
  ProcessListResponse,
  PublicUser,
  Role,
  SystemInfo,
} from '@aether/shared';


export type ProcessSort = 'memory' | 'pid' | 'name';

export function fetchProcesses(params: {
  sortBy: ProcessSort;
  search?: string;
  limit?: number;
}): Promise<ProcessListResponse> {
  return apiRequest<ProcessListResponse>('/api/system/processes', {
    query: {
      sortBy: params.sortBy,
      limit: params.limit ?? 200,
      ...(params.search !== undefined && params.search !== '' ? { search: params.search } : {}),
    },
  });
}

export type ProcessSignal = 'SIGTERM' | 'SIGINT' | 'SIGHUP' | 'SIGKILL';

/**
 * Sends a signal to a process.
 *
 * The server decides whether the signal is allowed; this wrapper does not
 * pre-filter, so a refusal arrives as a real error message rather than a
 * silently disabled button.
 */
export function signalProcess(
  pid: number,
  signal: ProcessSignal
): Promise<{ pid: number; signal: string; delivered: boolean }> {
  return apiRequest<{ pid: number; signal: string; delivered: boolean }>(
    `/api/system/processes/${pid}/signal`,
    { method: 'POST', body: { signal } }
  );
}

export function fetchSystemInfo(): Promise<SystemInfo> {
  return apiRequest<SystemInfo>('/api/system/info');
}

export function fetchInstance(): Promise<{ instanceId: string; configured: boolean }> {
  return apiRequest<{ instanceId: string; configured: boolean }>('/api/system/instance');
}

export interface SettingRecord {
  key: string;
  value: unknown;
  updatedAt: string;
}

export function fetchSettings(): Promise<{ settings: SettingRecord[] }> {
  return apiRequest<{ settings: SettingRecord[] }>('/api/system/settings');
}

export function updateSettings(settings: Record<string, unknown>): Promise<{ updated: number }> {
  return apiRequest<{ updated: number }>('/api/system/settings', {
    method: 'PUT',
    body: { settings },
  });
}

export function fetchAuditEvents(params: {
  action?: string;
  limit?: number;
  offset?: number;
}): Promise<{ events: AuditEvent[] }> {
  return apiRequest<{ events: AuditEvent[] }>('/api/audit', {
    query: {
      limit: params.limit ?? 100,
      offset: params.offset ?? 0,
      ...(params.action !== undefined && params.action !== '' ? { action: params.action } : {}),
    },
  });
}

export function fetchSessions(): Promise<{ sessions: AuthSession[] }> {
  return apiRequest<{ sessions: AuthSession[] }>('/api/auth/sessions');
}

export function revokeSession(sessionId: string): Promise<{ revoked: boolean }> {
  return apiRequest<{ revoked: boolean }>(`/api/auth/sessions/${sessionId}`, { method: 'DELETE' });
}

export function changePassword(params: {
  currentPassword: string;
  newPassword: string;
}): Promise<{ sessionsRevoked: number }> {
  return apiRequest<{ sessionsRevoked: number }>('/api/auth/password', {
    method: 'POST',
    body: params,
  });
}

export function fetchUsers(): Promise<{ users: PublicUser[]; total: number }> {
  return apiRequest<{ users: PublicUser[]; total: number }>('/api/users', {
    query: { limit: 200, offset: 0 },
  });
}

export function createUser(params: {
  username: string;
  password: string;
  email?: string;
  role: Exclude<Role, 'owner'>;
}): Promise<PublicUser> {
  return apiRequest<PublicUser>('/api/users', { method: 'POST', body: params });
}

export function updateUser(
  userId: string,
  changes: { email?: string | null; role?: Role; isActive?: boolean }
): Promise<PublicUser | null> {
  return apiRequest<PublicUser | null>(`/api/users/${userId}`, {
    method: 'PATCH',
    body: changes,
  });
}

export function deleteUser(userId: string): Promise<void> {
  return apiRequest<void>(`/api/users/${userId}`, { method: 'DELETE' });
}

/** Roles that may be assigned through the API; `owner` is created by the installer. */
export const ASSIGNABLE_ROLES: ReadonlyArray<Exclude<Role, 'owner'>> = [
  'admin',
  'operator',
  'viewer',
];

export type { Permission };

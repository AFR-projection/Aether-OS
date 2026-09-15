/**
 * Shared constants for Aether Cloud OS.
 *
 * These values are used by both the backend (authorization decisions) and the
 * frontend (hiding UI affordances the current user cannot use). The backend is
 * always the authority — the frontend copy is a convenience only.
 */

/** Semantic version of the running Aether release. */
export const AETHER_VERSION = '0.1.0';

/** Every permission the system understands. */
export const PERMISSIONS = [
  'files:read',
  'files:write',
  'files:delete',
  'terminal:create',
  'terminal:attach',
  'process:read',
  'process:manage',
  'system:read',
  'settings:manage',
  'users:manage',
  'audit:read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Roles, ordered from most to least privileged. */
export const ROLES = ['owner', 'admin', 'operator', 'viewer'] as const;

export type Role = (typeof ROLES)[number];

/**
 * Role to permission mapping.
 *
 * `owner` is the account created by the installer / first-run bootstrap.
 * `admin` can do everything except manage other users' accounts.
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: PERMISSIONS,
  admin: [
    'files:read',
    'files:write',
    'files:delete',
    'terminal:create',
    'terminal:attach',
    'process:read',
    'process:manage',
    'system:read',
    'settings:manage',
    'audit:read',
  ],
  operator: [
    'files:read',
    'files:write',
    'terminal:create',
    'terminal:attach',
    'process:read',
    'system:read',
  ],
  viewer: ['files:read', 'process:read', 'system:read'],
};

/** Returns true when `role` grants `permission`. */
export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** WebSocket close codes used by the Aether realtime protocol. */
export const WS_CLOSE = {
  NORMAL: 1000,
  POLICY_VIOLATION: 1008,
  UNSUPPORTED_DATA: 1003,
  INTERNAL_ERROR: 1011,
  /** 4000-4999 is the application-defined range. */
  UNAUTHENTICATED: 4001,
  FORBIDDEN: 4003,
  SESSION_NOT_FOUND: 4004,
  RATE_LIMITED: 4029,
} as const;

/** Default limits. Overridable through environment configuration on the server. */
export const LIMITS = {
  MAX_TERMINAL_SESSIONS_PER_USER: 10,
  MAX_TERMINAL_SESSIONS_GLOBAL: 50,
  TERMINAL_IDLE_TIMEOUT_MS: 30 * 60 * 1000,
  TERMINAL_SCROLLBACK_LINES: 10_000,
  MAX_FILE_READ_BYTES: 5 * 1024 * 1024,
  MAX_UPLOAD_BYTES: 512 * 1024 * 1024,
  MAX_DIRECTORY_ENTRIES: 5_000,
  WS_MESSAGE_MAX_BYTES: 1024 * 1024,
} as const;

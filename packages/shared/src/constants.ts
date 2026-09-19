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
  'ports:read',
  'ports:forward',
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
    'ports:read',
    'ports:forward',
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
    'ports:read',
    'ports:forward',
    'system:read',
  ],
  viewer: ['files:read', 'process:read', 'ports:read', 'system:read'],
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
  /**
   * Bytes moved per frame when a file is streamed to or from a host agent.
   *
   * A host file has to travel as base64 inside the agent's WebSocket frames,
   * and the frame ceiling above is what sizes this: 512 KiB of payload encodes
   * to roughly 700 KB of base64, which leaves the JSON envelope comfortable
   * room under 1 MiB. Raising it past that does not make transfers faster, it
   * makes the agent reject them.
   */
  HOST_STREAM_CHUNK_BYTES: 512 * 1024,
  /**
   * Bytes moved per frame through a port tunnel.
   *
   * Smaller than the file-stream chunk above on purpose. A tunnel carries an
   * interactive session — a page load is many small frames in both directions —
   * so a large chunk buys nothing and delays the other direction by however long
   * it takes to fill. This size keeps a burst of HTML and its assets moving
   * without any one frame monopolising the socket.
   */
  PORT_TUNNEL_CHUNK_BYTES: 128 * 1024,
  /**
   * Bytes buffered on the agent for one tunnel before it is dropped.
   *
   * A tunnel is a raw TCP socket to a server the user started; that server may
   * produce output faster than the WebSocket can carry it, and with no way to
   * push back on a kernel socket through a message channel, the only bounded
   * answers are "buffer up to a limit" and "close". This is the limit.
   */
  PORT_TUNNEL_MAX_BUFFER_BYTES: 8 * 1024 * 1024,
  /** Listening sockets reported by one `ports.list`, newest first. */
  MAX_LISTENING_PORTS: 200,
  /** Concurrent port tunnels one agent will hold open. */
  MAX_PORT_TUNNELS: 32,
} as const;

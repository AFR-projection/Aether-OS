/**
 * Typed wrappers around the terminal endpoints.
 *
 * `POST /api/terminal/sessions` is the only one Code Studio's Run panel needs;
 * everything after it travels over the WebSocket, which `terminal-connection`
 * owns. It lives here rather than inline in a component so the scope fields and
 * the shape of a created session are written once.
 */

import { apiRequest } from './api-client.js';
import { isHostScope, type FsScope } from '../apps/files/files-api.js';

import type { TerminalSession } from '@aether/shared';

export interface CreateTerminalOptions {
  cols: number;
  rows: number;
  /** Directory to start in, relative to the scope's root. */
  cwd?: string;
  /** Run this instead of an interactive shell. */
  command?: string;
  /** Where the session runs. Omitted means the backend workspace. */
  fs?: FsScope;
}

export function createTerminalSession(options: CreateTerminalOptions): Promise<TerminalSession> {
  const scope = isHostScope(options.fs)
    ? { scope: 'host' as const, agentId: options.fs.agentId }
    : {};

  return apiRequest<TerminalSession>('/api/terminal/sessions', {
    method: 'POST',
    body: {
      cols: options.cols,
      rows: options.rows,
      ...(options.cwd !== undefined && options.cwd !== '' ? { cwd: options.cwd } : {}),
      ...(options.command !== undefined && options.command !== ''
        ? { command: options.command }
        : {}),
      ...scope,
    },
  });
}

export function killTerminalSession(sessionId: string): Promise<void> {
  return apiRequest<void>(`/api/terminal/sessions/${sessionId}`, { method: 'DELETE' });
}

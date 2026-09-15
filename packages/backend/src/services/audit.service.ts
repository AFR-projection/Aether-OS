
import { query } from '../db/pool.js';
import { subsystemLogger } from '../utils/logger.js';

import type { AuditAction, AuditOutcome } from '@aether/shared';

const log = subsystemLogger('audit');

export interface AuditEventInput {
  action: AuditAction;
  outcome: AuditOutcome;
  actorUserId?: string | null;
  actorUsername?: string | null;
  sessionId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  target?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Appends an audit event.
 *
 * Audit writes are best-effort: a failure is logged at error level but never
 * fails the request that triggered it. Failing a user's file read because the
 * audit table is full would be a denial of service against the legitimate user,
 * and the failure is loud in the logs either way.
 *
 * Callers are responsible for not putting credentials into `metadata`.
 */
export async function recordAuditEvent(input: AuditEventInput): Promise<void> {
  try {
    await query(
      `INSERT INTO aether.audit_events
         (action, outcome, actor_user_id, actor_username, session_id, ip_address, user_agent, target, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        input.action,
        input.outcome,
        input.actorUserId ?? null,
        input.actorUsername ?? null,
        input.sessionId ?? null,
        input.ipAddress ?? null,
        input.userAgent ? input.userAgent.slice(0, 512) : null,
        input.target ? input.target.slice(0, 1024) : null,
        input.metadata ? JSON.stringify(input.metadata) : null,
      ],
    );
  } catch (error) {
    log.error({ err: error, action: input.action }, 'failed to write audit event');
  }
}

export interface AuditQuery {
  limit: number;
  offset: number;
  action?: string;
  actorUserId?: string;
}

export interface AuditRow {
  id: string;
  at: Date;
  action: string;
  outcome: string;
  actor_user_id: string | null;
  actor_username: string | null;
  session_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  target: string | null;
  metadata: Record<string, unknown> | null;
}

/** Reads recent audit events, newest first. */
export async function listAuditEvents(options: AuditQuery): Promise<AuditRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.action) {
    params.push(options.action);
    conditions.push(`action = $${params.length}`);
  }
  if (options.actorUserId) {
    params.push(options.actorUserId);
    conditions.push(`actor_user_id = $${params.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(options.limit, options.offset);

  const result = await query<AuditRow>(
    `SELECT id, at, action, outcome, actor_user_id, actor_username, session_id,
            ip_address, user_agent, target, metadata
       FROM aether.audit_events
       ${where}
       ORDER BY at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return result.rows;
}

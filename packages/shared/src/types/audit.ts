export const AUDIT_ACTIONS = [
  'auth.login.success',
  'auth.login.failure',
  'auth.logout',
  'auth.token.refresh',
  'auth.bootstrap',
  'auth.session.revoked',
  'user.created',
  'user.updated',
  'user.deleted',
  'terminal.created',
  'terminal.killed',
  'file.read',
  'file.written',
  'file.deleted',
  'file.uploaded',
  'file.downloaded',
  'file.renamed',
  'process.signalled',
  'port.preview.opened',
  'port.preview.closed',
  'permission.denied',
  'rate_limit.exceeded',
  'settings.updated',
  'agent.paired',
  'agent.revoked',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditOutcome = 'success' | 'failure';

export interface AuditEvent {
  id: string;
  at: string;
  action: AuditAction;
  outcome: AuditOutcome;
  actorUserId: string | null;
  actorUsername: string | null;
  sessionId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  /** Resource identifier the action applied to, e.g. a file path or session id. */
  target: string | null;
  /** Non-sensitive structured context. Never contains credentials or tokens. */
  metadata: Record<string, unknown> | null;
}

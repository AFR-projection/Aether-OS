import { describe, expect, it } from 'vitest';

import { dispatchAgentMessage } from './agent-gateway.service.js';

import type { AgentRecord } from './agent-pairing.service.js';

const AGENT: AgentRecord = {
  agentId: '00000000-0000-4000-8000-000000000099',
  label: 'test-agent',
  ownerUserId: '00000000-0000-4000-8000-000000000010',
  createdAt: new Date().toISOString(),
};

function parseReply(raw: string | null): { replyTo: string; ok: boolean; result?: unknown; error?: { code: string; message: string } } {
  expect(raw).not.toBeNull();
  return JSON.parse(raw as string);
}

/**
 * Gateway contract tests.
 *
 * These drive the real dispatcher with a fixed agent record. No database, no
 * socket, no agent process — only the validation layer and the capability
 * wiring are exercised. Anything that would need a database fails with a 500
 * (`INTERNAL_ERROR`), never by silently succeeding.
 */
describe('dispatchAgentMessage', () => {
  it('answers system.info without a database', async () => {
    const raw = await dispatchAgentMessage(AGENT, JSON.stringify({ id: 'g1', type: 'system.info' }));
    const reply = parseReply(raw);
    expect(reply.ok).toBe(true);
    expect((reply.result as { hostname: string }).hostname.length).toBeGreaterThan(0);
  }, 30_000);

  it('rejects malformed JSON', async () => {
    const raw = await dispatchAgentMessage(AGENT, 'not json');
    const reply = parseReply(raw);
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe('VALIDATION_FAILED');
  });

  it('rejects an unknown message type', async () => {
    const raw = await dispatchAgentMessage(AGENT, JSON.stringify({ id: 'g2', type: 'nope' }));
    const reply = parseReply(raw);
    expect(reply.ok).toBe(false);
  });

  it('returns null for hello frames (handled by the WS layer)', async () => {
    const raw = await dispatchAgentMessage(AGENT, JSON.stringify({ id: 'g3', type: 'hello' }));
    expect(raw).toBeNull();
  });

  it('correlates replies with the request id', async () => {
    const raw = await dispatchAgentMessage(AGENT, JSON.stringify({ id: 'corr-42', type: 'system.info' }));
    const reply = parseReply(raw);
    expect(reply.replyTo).toBe('corr-42');
  }, 30_000);

  it('never leaks stack traces in 500 replies', async () => {
    // files.read of a missing file throws a domain error; the reply must carry
    // the message but no stack. A genuinely unexpected fault maps to a generic
    // "Internal error" instead.
    const raw = await dispatchAgentMessage(
      AGENT,
      JSON.stringify({ id: 'g4', type: 'processes.signal', params: { pid: 1.5, signal: 'SIGTERM' } }),
    );
    const reply = parseReply(raw);
    expect(reply.ok).toBe(false);
    expect(JSON.stringify(reply)).not.toContain('at ');
  });
});

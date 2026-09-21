import { WS_CLOSE } from '@aether/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  closeAgentSocket,
  connectedAgentIds,
  handleAgentFrame,
  isAgentRpcConnected,
  registerAgentSocket,
  sendAgentRequest,
  setTerminalSubscriber,
  unregisterAgentSocket,
} from './agent-rpc.service.js';

/**
 * Revocation must close the *live* socket, not merely stamp the database.
 *
 * `closeAgentSocket` is the mechanism the revoke route leans on to make that
 * true, so these tests pin the properties DoD #14 asks for, at the layer that
 * actually holds the socket:
 *
 * - the socket is really closed, with the policy-violation code and reason;
 * - an in-flight request fails immediately rather than waiting out the 20s
 *   timeout;
 * - a terminal stream bridged through the agent stops at once;
 * - a request that arrives after revocation is refused, as if the agent were
 *   offline (because, for this replica, it now is);
 * - closing one agent touches no other agent's socket, stream, or reachability;
 * - the eventual `close` event for the socket we already tore down is a
 *   harmless no-op, not a double-free that could evict a reconnected channel.
 *
 * The channel map is per-process module state with no reset hook, so every test
 * uses its own agent ids and never depends on another test's teardown.
 */

/** The minimal `ws`-shaped socket the module drives, plus recorders for assertions. */
function makeSocket() {
  const sends: string[] = [];
  const closes: Array<{ code?: number; reason?: string }> = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    send(data: string): void {
      sends.push(data);
    },
    close(code?: number, reason?: string): void {
      closes.push({ code, reason });
      socket.readyState = 3; // CLOSED
    },
  };
  return { socket, sends, closes };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('closeAgentSocket', () => {
  it('reports nothing to close for an agent it never held', () => {
    expect(closeAgentSocket('rpc-ghost', WS_CLOSE.FORBIDDEN, 'Agent has been revoked')).toBe(false);
  });

  it('closes the live socket with the given code and reason, and reports it gone', () => {
    const { socket, closes } = makeSocket();
    registerAgentSocket('rpc-close-1', socket);
    expect(isAgentRpcConnected('rpc-close-1')).toBe(true);

    const closed = closeAgentSocket('rpc-close-1', WS_CLOSE.FORBIDDEN, 'Agent has been revoked');

    expect(closed).toBe(true);
    expect(closes).toEqual([{ code: WS_CLOSE.FORBIDDEN, reason: 'Agent has been revoked' }]);
    expect(isAgentRpcConnected('rpc-close-1')).toBe(false);
  });

  it('fails every in-flight request instead of leaving it to time out', async () => {
    const { socket } = makeSocket();
    registerAgentSocket('rpc-close-2', socket);

    // The fake socket records the frame but never answers, so the request stays
    // pending — exactly the state a real revocation interrupts.
    const inflight = sendAgentRequest('rpc-close-2', 'files.read', { path: '/etc/hostname' });

    expect(closeAgentSocket('rpc-close-2', WS_CLOSE.FORBIDDEN, 'Agent has been revoked')).toBe(
      true
    );

    await expect(inflight).rejects.toThrow('Agent has been revoked');
  });

  it('stops streaming terminal output to a subscriber once revoked', () => {
    const { socket } = makeSocket();
    registerAgentSocket('rpc-close-3', socket);

    const events: unknown[] = [];
    setTerminalSubscriber('rpc-close-3', 'sess-a', (event) => events.push(event));

    handleAgentFrame('rpc-close-3', {
      type: 'terminal.event',
      sessionId: 'sess-a',
      event: 'before',
    });
    expect(events).toEqual(['before']);

    closeAgentSocket('rpc-close-3', WS_CLOSE.FORBIDDEN, 'Agent has been revoked');

    // A frame arriving after revocation finds no channel, so the subscriber is
    // never called again — the stream is genuinely torn down, not just flagged.
    handleAgentFrame('rpc-close-3', {
      type: 'terminal.event',
      sessionId: 'sess-a',
      event: 'after',
    });
    expect(events).toEqual(['before']);
  });

  it('refuses a new request after revocation, as if the agent were offline', async () => {
    const { socket } = makeSocket();
    registerAgentSocket('rpc-close-4', socket);

    closeAgentSocket('rpc-close-4', WS_CLOSE.FORBIDDEN, 'Agent has been revoked');

    await expect(sendAgentRequest('rpc-close-4', 'files.read', {})).rejects.toThrow(
      'The host agent is not connected'
    );
  });

  it('closes only the named agent and leaves every other socket serving', () => {
    const a = makeSocket();
    const b = makeSocket();
    registerAgentSocket('rpc-victim', a.socket);
    registerAgentSocket('rpc-bystander', b.socket);

    const bystanderEvents: unknown[] = [];
    setTerminalSubscriber('rpc-bystander', 'sess-b', (event) => bystanderEvents.push(event));

    closeAgentSocket('rpc-victim', WS_CLOSE.FORBIDDEN, 'Agent has been revoked');

    // The bystander's socket was never touched, stays connected, and keeps
    // streaming. Revoking one agent is not a way to disconnect another.
    expect(a.closes).toHaveLength(1);
    expect(b.closes).toHaveLength(0);
    expect(isAgentRpcConnected('rpc-victim')).toBe(false);
    expect(isAgentRpcConnected('rpc-bystander')).toBe(true);

    handleAgentFrame('rpc-bystander', {
      type: 'terminal.event',
      sessionId: 'sess-b',
      event: 'still-here',
    });
    expect(bystanderEvents).toEqual(['still-here']);

    expect(connectedAgentIds()).toContain('rpc-bystander');
    expect(connectedAgentIds()).not.toContain('rpc-victim');
  });

  it('treats the socket close event that follows revocation as a harmless no-op', () => {
    const { socket } = makeSocket();
    registerAgentSocket('rpc-close-5', socket);

    closeAgentSocket('rpc-close-5', WS_CLOSE.FORBIDDEN, 'Agent has been revoked');

    // The real `ws` 'close' event fires slightly later and calls
    // `unregisterAgentSocket` for the same socket. The channel is already gone,
    // so this must not throw and must not resurrect or evict anything.
    expect(() => unregisterAgentSocket('rpc-close-5', socket)).not.toThrow();
    expect(isAgentRpcConnected('rpc-close-5')).toBe(false);
  });

  it('does not let a stale close evict the channel a reconnect installed', () => {
    const first = makeSocket();
    registerAgentSocket('rpc-close-6', first.socket);
    closeAgentSocket('rpc-close-6', WS_CLOSE.FORBIDDEN, 'Agent has been revoked');

    // A fresh socket registers for the same id (a genuine reconnect on another
    // agent would look like this). The delayed close of the *old* socket must
    // not tear down the new channel — `unregisterAgentSocket` is keyed on the
    // exact socket, not just the id.
    const second = makeSocket();
    registerAgentSocket('rpc-close-6', second.socket);
    unregisterAgentSocket('rpc-close-6', first.socket);

    expect(isAgentRpcConnected('rpc-close-6')).toBe(true);
  });
});

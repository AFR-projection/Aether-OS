import { beforeEach, describe, expect, it } from 'vitest';

import {
  agentConnectedAt,
  connectedAgentCount,
  isAgentConnected,
  markAgentConnected,
  markAgentDisconnected,
  resetAgentConnections,
} from './agent-connections.js';

describe('agent connection registry', () => {
  beforeEach(() => {
    resetAgentConnections();
  });

  it('reports an unknown agent as offline', () => {
    expect(isAgentConnected('nobody')).toBe(false);
    expect(agentConnectedAt('nobody')).toBeNull();
  });

  it('marks an agent online on connect', () => {
    markAgentConnected('agent-1');
    expect(isAgentConnected('agent-1')).toBe(true);
    expect(connectedAgentCount()).toBe(1);
  });

  it('marks an agent offline when its socket closes', () => {
    markAgentConnected('agent-1');
    markAgentDisconnected('agent-1');
    expect(isAgentConnected('agent-1')).toBe(false);
    expect(agentConnectedAt('agent-1')).toBeNull();
    expect(connectedAgentCount()).toBe(0);
  });

  it('reports the timestamp of the current connection', () => {
    markAgentConnected('agent-1');
    const connectedAt = agentConnectedAt('agent-1');

    expect(connectedAt).not.toBeNull();
    expect(Number.isNaN(Date.parse(connectedAt ?? ''))).toBe(false);
  });

  it('tracks agents independently', () => {
    markAgentConnected('agent-1');
    markAgentConnected('agent-2');
    markAgentDisconnected('agent-1');

    expect(isAgentConnected('agent-1')).toBe(false);
    expect(isAgentConnected('agent-2')).toBe(true);
    expect(connectedAgentCount()).toBe(1);
  });

  describe('reconnect races', () => {
    it('stays online when a new socket opens before the old one closes', () => {
      // A reconnecting agent can have its new socket accepted before the old
      // socket's `close` event is delivered. Counting sockets rather than
      // holding a boolean is what keeps the agent from being reported offline
      // while it is actually connected.
      markAgentConnected('agent-1');
      markAgentConnected('agent-1');
      markAgentDisconnected('agent-1');

      expect(isAgentConnected('agent-1')).toBe(true);
    });

    it('goes offline once every socket has closed', () => {
      markAgentConnected('agent-1');
      markAgentConnected('agent-1');
      markAgentDisconnected('agent-1');
      markAgentDisconnected('agent-1');

      expect(isAgentConnected('agent-1')).toBe(false);
    });

    it('keeps the original timestamp across a reconnect', () => {
      markAgentConnected('agent-1');
      const first = agentConnectedAt('agent-1');
      markAgentConnected('agent-1');

      expect(agentConnectedAt('agent-1')).toBe(first);
    });

    it('ignores a close for an agent that was never connected', () => {
      // A late `close` from a revoked pair must not decrement another agent.
      markAgentDisconnected('agent-1');
      expect(connectedAgentCount()).toBe(0);
    });

    it('ignores extra closes beyond the socket count', () => {
      markAgentConnected('agent-1');
      markAgentDisconnected('agent-1');
      markAgentDisconnected('agent-1');

      expect(isAgentConnected('agent-1')).toBe(false);
      expect(connectedAgentCount()).toBe(0);
    });
  });
});

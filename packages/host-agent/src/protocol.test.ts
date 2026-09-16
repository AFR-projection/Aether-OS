import { LIMITS } from '@aether/shared';
import { describe, expect, it } from 'vitest';

import { errReply, okReply, parseAgentMessage } from './protocol.js';

describe('parseAgentMessage', () => {
  it('parses a system.info request with empty params', () => {
    const request = parseAgentMessage(JSON.stringify({ id: 'a1', type: 'system.info' }));
    expect(request).toEqual({ id: 'a1', type: 'system.info', params: {} });
  });

  it('applies defaults for processes.list', () => {
    const request = parseAgentMessage(
      JSON.stringify({ id: 'a2', type: 'processes.list', params: {} })
    );
    expect(request.type).toBe('processes.list');
    expect(request.params).toMatchObject({ limit: 100 });
  });

  it('rejects an unknown message type', () => {
    expect(() => parseAgentMessage(JSON.stringify({ id: 'a3', type: 'nope' }))).toThrow(
      /unsupported message type/i
    );
  });

  it('rejects non-JSON frames', () => {
    expect(() => parseAgentMessage('not json')).toThrow(/not valid json/i);
  });

  it('rejects a frame without an envelope id', () => {
    expect(() => parseAgentMessage(JSON.stringify({ type: 'system.info' }))).toThrow(/envelope/i);
  });

  it('rejects out-of-range process signal pids', () => {
    expect(() =>
      parseAgentMessage(
        JSON.stringify({
          id: 'a4',
          type: 'processes.signal',
          params: { pid: 0, signal: 'SIGTERM' },
        })
      )
    ).toThrow(/invalid params/i);
  });

  it('rejects an unsupported process signal', () => {
    expect(() =>
      parseAgentMessage(
        JSON.stringify({
          id: 'a5',
          type: 'processes.signal',
          params: { pid: 42, signal: 'SIGSTOP' },
        })
      )
    ).toThrow(/invalid params/i);
  });

  it('rejects terminal input over the size limit', () => {
    const oversized = 'x'.repeat(64 * 1024 + 1);
    expect(() =>
      parseAgentMessage(
        JSON.stringify({
          id: 'a6',
          type: 'terminal.input',
          params: { id: '00000000-0000-4000-8000-000000000001', data: oversized },
        })
      )
    ).toThrow(/invalid params/i);
  });

  it('rejects absolute file paths at the protocol boundary', () => {
    expect(() =>
      parseAgentMessage(
        JSON.stringify({ id: 'a7', type: 'files.read', params: { path: '/etc/passwd' } })
      )
    ).toThrow(/invalid params/i);
  });

  it('rejects parent traversal at the protocol boundary', () => {
    expect(() =>
      parseAgentMessage(
        JSON.stringify({ id: 'a8', type: 'files.read', params: { path: '../secret' } })
      )
    ).toThrow(/invalid params/i);
  });

  it('rejects unknown params keys (strict schemas)', () => {
    expect(() =>
      parseAgentMessage(
        JSON.stringify({ id: 'a9', type: 'system.info', params: { extra: 'nope' } })
      )
    ).toThrow(/invalid params/i);
  });

  it('accepts a valid terminal resize', () => {
    const request = parseAgentMessage(
      JSON.stringify({
        id: 'a10',
        type: 'terminal.resize',
        params: { id: '00000000-0000-4000-8000-000000000001', cols: 120, rows: 40 },
      })
    );
    expect(request.type).toBe('terminal.resize');
  });

  it('exposes the shared WS frame limit', () => {
    expect(LIMITS.WS_MESSAGE_MAX_BYTES).toBeGreaterThan(0);
  });
});

describe('replies', () => {
  it('builds ok and error replies', () => {
    expect(okReply('1', { a: 1 })).toEqual({ id: '1', ok: true, result: { a: 1 } });
    expect(errReply('1', 'NOT_FOUND', 'missing')).toEqual({
      id: '1',
      ok: false,
      error: { code: 'NOT_FOUND', message: 'missing' },
    });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentConfig } from './config.js';

// Each test gets a fresh module so the module-level `logger` singleton starts
// null, reproducing the real import-order: subsystem loggers are created at
// import time, createLogger() runs later in main().
beforeEach(() => {
  vi.resetModules();
});

function fakeConfig(level: AgentConfig['LOG_LEVEL']): AgentConfig {
  return {
    LOG_LEVEL: level,
    AETHER_AGENT_ID: '00000000-0000-0000-0000-000000000000',
  } as AgentConfig;
}

describe('subsystemLogger', () => {
  it('reflects the real logger created after the binding, not a frozen silent one', async () => {
    const { subsystemLogger, createLogger } = await import('./logger.js');

    // Bound before createLogger(), exactly like `const log = subsystemLogger(x)`
    // at the top of connection.ts.
    const log = subsystemLogger('connection');
    expect(log.level).toBe('silent');

    createLogger(fakeConfig('info'));

    // The SAME binding must now speak through the real logger. Before the fix
    // this stayed 'silent' forever, dropping every connection.ts log line
    // including "paired with backend".
    expect(log.level).toBe('info');
  });

  it('binds the subsystem name onto the real logger, not the silent fallback', async () => {
    const { subsystemLogger, createLogger } = await import('./logger.js');

    const log = subsystemLogger('connection');
    createLogger(fakeConfig('info'));

    // pino exposes its bound context on `bindings()`. After the fix this comes
    // from the real logger's child, carrying both the service base and the
    // subsystem — proof the proxy is speaking through the live logger.
    const bindings = log.bindings();
    expect(bindings['subsystem']).toBe('connection');
    expect(bindings['service']).toBe('aether-host-agent');
  });

  it('stays usable at import time when no logger exists yet', async () => {
    const { subsystemLogger } = await import('./logger.js');

    // Must not throw: connection.ts calls this at module top level.
    const log = subsystemLogger('connection');
    expect(() => log.info('dropped until createLogger runs')).not.toThrow();
    expect(log.level).toBe('silent');
  });
});

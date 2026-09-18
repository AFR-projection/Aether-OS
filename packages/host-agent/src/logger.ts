import { pino, type Logger } from 'pino';

import { describeConfig, type AgentConfig } from './config.js';
import { AETHER_VERSION } from './version.js';

const REDACT_PATHS = [
  'pairingToken',
  'token',
  'accessToken',
  'secret',
  'password',
  '*.pairingToken',
  '*.token',
  '*.accessToken',
  '*.secret',
  '*.AETHER_PAIRING_TOKEN',
];

let logger: Logger | null = null;

export function createLogger(cfg: AgentConfig): Logger {
  logger ??= pino({
    level: cfg.LOG_LEVEL,
    base: { service: 'aether-host-agent', version: AETHER_VERSION, agentId: cfg.AETHER_AGENT_ID },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
  return logger;
}

export function getLogger(): Logger {
  if (!logger) throw new Error('Logger used before createLogger()');
  return logger;
}

export function logStartupConfiguration(cfg: AgentConfig): void {
  getLogger().info({ config: describeConfig(cfg) }, 'agent configuration loaded');
}

/**
 * Creates a child logger bound to a subsystem name.
 *
 * The global logger does not exist until `createLogger()` runs in main(), but
 * module top-level code (e.g. `const log = subsystemLogger('connection')`) runs
 * at import time, long before that. Returning a concrete logger here would bind
 * `const log` to whatever existed at import — a *silent* logger — for the life
 * of the process, so every line that module ever logged was dropped, including
 * "paired with backend" and all connection errors. That made a healthy agent
 * look mute and broke the installer's both-sides connection check.
 *
 * Instead, resolve the real logger lazily on each use: proxy every access to
 * `logger.child({ subsystem })` once it exists, and fall back to a silent
 * logger only while it genuinely does not (import time, tests). The binding is
 * captured once but always points at the live logger after createLogger().
 */
export function subsystemLogger(subsystem: string): Logger {
  const silent = pino({ level: 'silent', base: { service: 'aether-host-agent', subsystem } });
  let child: Logger | null = null;

  const resolve = (): Logger => {
    if (logger) {
      // Bind the child once the real logger exists, then reuse it.
      child ??= logger.child({ subsystem });
      return child;
    }
    return silent;
  };

  return new Proxy(silent, {
    get(_target, prop) {
      const active = resolve();
      const value = (active as unknown as Record<PropertyKey, unknown>)[prop];
      // Bind methods to the resolved logger so `this` is not the proxy.
      if (typeof value === 'function') {
        return (value as (...args: unknown[]) => unknown).bind(active);
      }
      return value;
    },
  }) as Logger;
}

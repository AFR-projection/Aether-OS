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
 * Falls back to a silent logger when the global logger has not been created
 * yet. Module top-level code (e.g. `const log = subsystemLogger('x')`) runs at
 * import time, before `createLogger()` — crashing there would make the package
 * unimportable in tests and in any embedding host.
 */
export function subsystemLogger(subsystem: string): Logger {
  if (!logger) {
    return pino({ level: 'silent', base: { service: 'aether-host-agent', subsystem } });
  }
  return logger.child({ subsystem });
}

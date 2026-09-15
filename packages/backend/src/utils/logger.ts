import { pino, type Logger } from 'pino';

import { config, describeConfig } from '../config.js';

import { AETHER_VERSION } from './version.js';

/**
 * Structured logger for the backend.
 *
 * Redaction is configured defensively: the paths below cover the header names,
 * body fields, and query parameters that carry credentials. Redaction is a
 * safety net, not a licence to log secrets — code must not pass credentials to
 * the logger in the first place.
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-bootstrap-token"]',
  'request.headers.authorization',
  'request.headers.cookie',
  'res.headers["set-cookie"]',
  'password',
  'newPassword',
  'currentPassword',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'tokenHash',
  'secret',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  '*.passwordHash',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.secret',
  '*.JWT_SECRET',
  '*.ENCRYPTION_KEY',
  '*.DATABASE_URL',
  '*.REDIS_URL',
  'config.JWT_SECRET',
  'config.ENCRYPTION_KEY',
  'config.DATABASE_URL',
  'databaseUrl',
  'redisUrl',
  'env.JWT_SECRET',
  'env.DATABASE_URL',
];

export const logger = pino({
  level: config.LOG_LEVEL,
  base: {
    service: 'aether-backend',
    version: AETHER_VERSION,
    env: config.NODE_ENV,
  },
  redact: {
    paths: REDACT_PATHS,
    censor: '[REDACTED]',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(config.LOG_FORMAT === 'pretty'
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        },
      }
    : {}),
});

/**
 * Logs the effective (redacted) configuration. Called once at startup so a
 * support engineer can see how the process was configured without any secret
 * material appearing in the log.
 */
export function logStartupConfiguration(): void {
  logger.info({ config: describeConfig() }, 'configuration loaded');
}

/** Creates a child logger bound to a subsystem name. */
export function subsystemLogger(subsystem: string): Logger {
  return logger.child({ subsystem });
}

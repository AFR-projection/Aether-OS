import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

/**
 * Typed, validated environment configuration.
 *
 * Design rules:
 * - Every value is validated at boot. A misconfigured deployment fails
 *   immediately with a readable message instead of misbehaving later.
 * - Secrets never receive a default. There is no `?? 'changeme'` anywhere in
 *   this file; a missing secret is a fatal configuration error.
 * - `describeConfig()` returns a redacted summary that is safe to log.
 */

/**
 * Load `.env` for local development.
 *
 * Nothing else reads the file: `pnpm dev:backend` runs `tsx` directly, which
 * does not load it, so without this call `DATABASE_URL` and `JWT_SECRET` were
 * undefined and every development start failed validation. Production does not
 * depend on this — Docker Compose passes the environment directly and the file
 * is not present in the image.
 *
 * This runs before the schema below and never overrides variables that are
 * already set, so a value exported in the shell — or injected by the test
 * runner — always wins over the file.
 */
loadDotenv();

const booleanFromEnv = z.union([z.boolean(), z.string()]).transform((value) => {
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
});

const envSchema = z.object({
  // --- Runtime -------------------------------------------------------------
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // --- HTTP ----------------------------------------------------------------
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  BASE_URL: z.string().url().default('http://localhost:3000'),
  ALLOWED_ORIGINS: z
    .string()
    .default('http://localhost:5173,http://localhost:3000')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0)
    ),

  // --- Database ------------------------------------------------------------
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).default(15_000),

  // --- Cache / realtime fan-out (optional) ---------------------------------
  REDIS_URL: z.string().optional(),

  // --- Secrets (no defaults, ever) -----------------------------------------
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_ACCESS_TOKEN_EXPIRY: z.string().default('15m'),
  JWT_REFRESH_TOKEN_EXPIRY: z.string().default('30d'),
  ENCRYPTION_KEY: z.string().optional(),
  SESSION_SECRET: z.string().optional(),

  // --- Logging -------------------------------------------------------------
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_FORMAT: z.enum(['json', 'pretty']).default('json'),

  // --- Rate limiting -------------------------------------------------------
  RATE_LIMIT_ENABLED: booleanFromEnv.default(true),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(1).default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),

  // --- Filesystem sandbox --------------------------------------------------
  /**
   * The only directory tree the Files app and the terminal may touch.
   * Nothing outside this path is readable or writable, regardless of what the
   * process user can reach. Resolved with `fs.realpath` at startup.
   */
  AETHER_WORKSPACE_ROOT: z.string().min(1).default('./workspace'),
  MAX_FILE_SIZE: z.coerce.number().int().min(1).default(104_857_600),
  UPLOAD_DIR: z.string().min(1).default('./uploads'),

  // --- Terminal ------------------------------------------------------------
  TERMINAL_ENABLED: booleanFromEnv.default(true),
  TERMINAL_MAX_SESSIONS: z.coerce.number().int().min(1).max(200).default(10),
  TERMINAL_IDLE_TIMEOUT: z.coerce.number().int().min(60_000).default(1_800_000),
  TERMINAL_SCROLLBACK_LINES: z.coerce.number().int().min(100).default(10_000),
  /** Comma-separated allowlist of shells the terminal may spawn. */
  TERMINAL_ALLOWED_SHELLS: z
    .string()
    .default('/bin/bash,/bin/sh')
    .transform((value) =>
      value
        .split(',')
        .map((shell) => shell.trim())
        .filter((shell) => shell.length > 0)
    ),

  // --- First-run bootstrap -------------------------------------------------
  /**
   * When set, `POST /api/auth/bootstrap` additionally requires this value in
   * the `X-Bootstrap-Token` header — otherwise anyone who can reach a fresh
   * instance can claim the owner account. Bootstrap is refused unconditionally
   * once a user exists. Left unset in development so the first-run screen
   * needs no token; the installer always generates one.
   */
  AETHER_BOOTSTRAP_TOKEN: z.string().optional(),

  /**
   * Stable identifier for this installation, generated by the installer. Also
   * written into the generated configuration, so it survives an upgrade.
   */
  AETHER_INSTANCE_ID: z.string().min(1).max(128).optional(),

  // --- Process management --------------------------------------------------
  /**
   * Whether the Task Manager may send signals to processes.
   *
   * Defaults to **false**. Ending a process is the one action in the API that
   * can take the host down — a careless click on `sshd` or the firewall daemon
   * locks the operator out of their own machine — so the capability is opt-in
   * and the installer has to enable it deliberately. Even when enabled, Aether
   * refuses to signal pid 1, itself, or any of its own ancestors.
   */
  AETHER_PROCESS_SIGNAL_ENABLED: booleanFromEnv.default(false),

  // --- Static frontend -----------------------------------------------------
  /** Directory containing the built frontend. Served when it exists. */
  AETHER_STATIC_DIR: z.string().optional(),

  // --- Trusted proxy -------------------------------------------------------
  /** Number of reverse proxies in front of the backend (Caddy = 1). */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(1),
});

export type AppConfig = z.infer<typeof envSchema> & {
  isProduction: boolean;
  isDevelopment: boolean;
  isTest: boolean;
  isHttps: boolean;
};

function loadConfig(): AppConfig {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    // Report *which* variables are wrong, never their values — a malformed
    // secret must not end up in a log file or a CI transcript.
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    throw new Error(`Invalid environment configuration:\n${problems}`);
  }

  const config = parsed.data;

  if (config.NODE_ENV === 'production' && !config.ENCRYPTION_KEY) {
    throw new Error(
      'Invalid environment configuration:\n  - ENCRYPTION_KEY: required in production'
    );
  }

  if (
    config.NODE_ENV === 'production' &&
    (config.LOG_FORMAT === 'pretty' || config.LOG_LEVEL === 'debug' || config.LOG_LEVEL === 'trace')
  ) {
    // Verbose logging in production leaks request payloads into log storage.
    throw new Error(
      'Invalid environment configuration:\n  - LOG_LEVEL/LOG_FORMAT: debug, trace, and pretty output are not allowed in production'
    );
  }

  return Object.freeze({
    ...config,
    isProduction: config.NODE_ENV === 'production',
    isDevelopment: config.NODE_ENV === 'development',
    isTest: config.NODE_ENV === 'test',
    isHttps: config.BASE_URL.startsWith('https://'),
  });
}

export const config = loadConfig();

/**
 * A redacted view of the configuration, safe to write to logs.
 * Secrets are reported as present/absent, never as values.
 */
export function describeConfig(cfg: AppConfig = config): Record<string, string | number | boolean> {
  return {
    nodeEnv: cfg.NODE_ENV,
    host: cfg.HOST,
    port: cfg.PORT,
    baseUrl: cfg.BASE_URL,
    allowedOrigins: cfg.ALLOWED_ORIGINS.join(','),
    logLevel: cfg.LOG_LEVEL,
    logFormat: cfg.LOG_FORMAT,
    rateLimitEnabled: cfg.RATE_LIMIT_ENABLED,
    workspaceRoot: cfg.AETHER_WORKSPACE_ROOT,
    terminalEnabled: cfg.TERMINAL_ENABLED,
    redisConfigured: Boolean(cfg.REDIS_URL),
    jwtSecretConfigured: cfg.JWT_SECRET.length > 0,
    encryptionKeyConfigured: Boolean(cfg.ENCRYPTION_KEY),
  };
}

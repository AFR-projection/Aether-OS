import { z } from 'zod';

/**
 * Host Agent configuration.
 *
 * Every value comes from the environment. Secrets are never hardcoded. The
 * agent refuses to start if required values are missing.
 */

const booleanFromEnv = z
  .union([z.boolean(), z.string()])
  .transform((value) => {
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  // --- Backend connection ---
  /** WebSocket URL of the Aether backend, e.g. wss://aether.example.com */
  AETHER_BACKEND_URL: z.string().url(),
  /** Pre-shared token issued by the backend during pairing. */
  AETHER_PAIRING_TOKEN: z.string().min(16),
  /** Stable identity for this agent, generated during pairing. */
  AETHER_AGENT_ID: z.string().uuid(),

  // --- Workspace ---
  AETHER_WORKSPACE_ROOT: z.string().min(1).default('/opt/aether/workspace'),

  // --- Terminal ---
  TERMINAL_ENABLED: booleanFromEnv.default(true),
  TERMINAL_MAX_SESSIONS: z.coerce.number().int().min(1).max(200).default(10),
  TERMINAL_IDLE_TIMEOUT: z.coerce.number().int().min(60_000).default(1_800_000),
  TERMINAL_SCROLLBACK_LINES: z.coerce.number().int().min(100).default(10_000),
  TERMINAL_ALLOWED_SHELLS: z
    .string()
    .default('/bin/bash,/bin/sh')
    .transform((value) =>
      value
        .split(',')
        .map((shell) => shell.trim())
        .filter((shell) => shell.length > 0),
    ),

  // --- Process management ---
  PROCESS_SIGNAL_ENABLED: booleanFromEnv.default(false),

  // --- Reconnection ---
  RECONNECT_BASE_DELAY_MS: z.coerce.number().int().min(1000).default(1000),
  RECONNECT_MAX_DELAY_MS: z.coerce.number().int().min(5000).default(30_000),
  /** Heartbeat interval in ms; the agent sends pings at this rate. */
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(5000).default(25_000),
});

export type AgentConfig = z.infer<typeof envSchema> & {
  isProduction: boolean;
  isDevelopment: boolean;
  isTest: boolean;
};

export function loadConfig(): AgentConfig {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid agent configuration:\n${problems}`);
  }

  const config = parsed.data;

  return Object.freeze({
    ...config,
    isProduction: config.NODE_ENV === 'production',
    isDevelopment: config.NODE_ENV === 'development',
    isTest: config.NODE_ENV === 'test',
  });
}

/**
 * A redacted view of the configuration, safe to write to logs.
 */
export function describeConfig(cfg: AgentConfig): Record<string, string | number | boolean> {
  return {
    nodeEnv: cfg.NODE_ENV,
    backendUrl: cfg.AETHER_BACKEND_URL,
    agentId: cfg.AETHER_AGENT_ID,
    workspaceRoot: cfg.AETHER_WORKSPACE_ROOT,
    terminalEnabled: cfg.TERMINAL_ENABLED,
    processSignalEnabled: cfg.PROCESS_SIGNAL_ENABLED,
    pairingTokenConfigured: cfg.AETHER_PAIRING_TOKEN.length > 0,
  };
}

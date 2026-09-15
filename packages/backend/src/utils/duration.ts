/** Duration parsing and formatting helpers. */

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Parses a duration string such as `15m`, `30d`, or `500ms` into milliseconds.
 *
 * Throws on anything it does not understand — a silently-defaulted token
 * lifetime is a security bug waiting to happen.
 */
export function parseDurationMs(value: string): number {
  const match = /^(\d+)\s*(ms|s|m|h|d|w)$/.exec(value.trim());
  if (!match) {
    throw new Error(`Unsupported duration format: "${value}". Expected e.g. "15m", "30d".`);
  }

  const [, amount, unit] = match;
  const multiplier = unit ? UNIT_MS[unit] : undefined;
  if (amount === undefined || multiplier === undefined) {
    throw new Error(`Unsupported duration format: "${value}"`);
  }

  return Number.parseInt(amount, 10) * multiplier;
}

/** Formats a millisecond duration as a short human-readable string. */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

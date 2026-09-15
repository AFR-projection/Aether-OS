/**
 * Display formatting helpers.
 *
 * All of these are pure and produce short strings suitable for a taskbar or a
 * table cell. They deliberately do not localise beyond the browser's own
 * `Intl` defaults: the desktop chrome is dense and a locale-aware byte format
 * would produce inconsistent column widths.
 */

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;

/** Formats a byte count using binary units, e.g. `1.5 GiB`. */
export function formatBytes(bytes: number, fractionDigits = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes === 0) return '0 B';

  const exponent = Math.min(Math.floor(Math.log2(bytes) / 10), BYTE_UNITS.length - 1);
  const value = bytes / 1024 ** exponent;
  const unit = BYTE_UNITS[exponent] ?? 'B';

  // Whole bytes and whole kibibytes read better without a decimal point.
  const digits = exponent === 0 ? 0 : value >= 100 ? 0 : fractionDigits;
  return `${value.toFixed(digits)} ${unit}`;
}

/** Formats a duration in seconds as `3d 4h 12m`, omitting leading zero units. */
export function formatUptime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '—';

  const seconds = Math.floor(totalSeconds);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/** Formats a millisecond duration as `420ms`, `3.2s`, or `1m 4s`. */
export function formatMilliseconds(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  return formatUptime(Math.floor(ms / 1_000));
}

/** Formats a 0-100 percentage with one decimal place. */
export function formatPercent(value: number, fractionDigits = 1): string {
  if (!Number.isFinite(value)) return '—';
  return `${value.toFixed(fractionDigits)}%`;
}

function toDate(value: string | number | Date): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Formats an ISO timestamp for a table cell, e.g. `16 Sep, 14:03`. */
export function formatDateTime(value: string | number | Date): string {
  const date = toDate(value);
  if (date === null) return '—';
  return new Intl.DateTimeFormat(undefined, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/** Formats an ISO timestamp with seconds, for audit entries. */
export function formatTimestamp(value: string | number | Date): string {
  const date = toDate(value);
  if (date === null) return '—';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 31_536_000_000],
  ['month', 2_592_000_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
  ['second', 1_000],
];

/** Formats a timestamp relative to now, e.g. `4 minutes ago`. */
export function formatRelative(value: string | number | Date, now = Date.now()): string {
  const date = toDate(value);
  if (date === null) return '—';

  const deltaMs = date.getTime() - now;
  const absoluteMs = Math.abs(deltaMs);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

  for (const [unit, unitMs] of RELATIVE_UNITS) {
    if (absoluteMs >= unitMs || unit === 'second') {
      return formatter.format(Math.round(deltaMs / unitMs), unit);
    }
  }

  return 'just now';
}

/** Truncates a long string in the middle so both ends stay readable. */
export function truncateMiddle(value: string, maxLength = 48): string {
  if (value.length <= maxLength) return value;
  const half = Math.floor((maxLength - 1) / 2);
  return `${value.slice(0, half)}…${value.slice(-half)}`;
}

/** Returns the file extension without the dot, lowercased. */
export function fileExtension(name: string): string {
  const index = name.lastIndexOf('.');
  if (index <= 0 || index === name.length - 1) return '';
  return name.slice(index + 1).toLowerCase();
}

import { query, queryOne } from '../db/pool.js';

import type { DesktopLayout } from '@aether/shared';

/**
 * Per-user desktop window layout.
 *
 * Stored in the shared `settings` table under `desktop.layout.<userId>` — the
 * same substrate the App Catalog uses for `desktop.pinnedApps.<username>`, so no
 * new table is introduced. The key is always derived from the *authenticated*
 * user's id by the route, never from anything the client sends, which is what
 * makes the isolation real: there is no request shape that reads or writes
 * another user's layout.
 */

const KEY_PREFIX = 'desktop.layout.';

/** The settings key for one user's layout. Derived, never client-supplied. */
export function desktopLayoutKey(userId: string): string {
  return `${KEY_PREFIX}${userId}`;
}

export async function getDesktopLayout(userId: string): Promise<DesktopLayout | null> {
  const row = await queryOne<{ value: unknown }>(
    'SELECT value FROM aether.settings WHERE key = $1',
    [desktopLayoutKey(userId)]
  );
  // The value is validated on the way in (the route parses it against
  // `desktopLayoutSchema` before saving), so a stored row is trusted here.
  return (row?.value as DesktopLayout | undefined) ?? null;
}

export async function saveDesktopLayout(userId: string, layout: DesktopLayout): Promise<void> {
  await query(
    `INSERT INTO aether.settings (key, value, updated_by, updated_at)
     VALUES ($1, $2::jsonb, $3, now())
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [desktopLayoutKey(userId), JSON.stringify(layout), userId]
  );
}

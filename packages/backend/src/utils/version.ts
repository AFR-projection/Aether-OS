/**
 * Single source of truth for the version string.
 *
 * Kept in its own module so the logger can import it without importing the
 * whole config (which reads `process.env`).
 */
export const AETHER_VERSION = '0.1.0';

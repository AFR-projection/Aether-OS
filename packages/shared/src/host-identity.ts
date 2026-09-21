/**
 * Resolves the identity a spawned shell should run as, from the host itself.
 *
 * Node-only, and deliberately **not** re-exported from `src/index.ts`: it
 * imports `node:os`, and the frontend imports this package's root entry, so
 * keeping it behind the `@aether/shared/node` subpath is what stops a Node
 * builtin reaching the browser bundle.
 *
 * ## Why the passwd database and not the environment
 *
 * `HOME`, `USER` and `SHELL` in the agent's own environment are whatever systemd
 * gave the service, and the unit sets none of them
 * (`deploy/scripts/setup-host.sh`, `[Service]` block) — so they come from
 * systemd's defaults rather than from anyone's login. The previous code fell
 * back to the *working directory* when `HOME` was unset, which in the default
 * full-host install is `/`, because `deploy/lib/local-agent.sh` sets
 * `agent_service_user="root"` and `agent_workspace="/"`. A shell whose `HOME` is
 * `/` reads `/.bashrc`, and `cd ~` goes nowhere.
 *
 * `os.userInfo()` calls `getpwuid_r`, so it answers from the passwd database for
 * the process's effective uid. That is the authority on who this process is,
 * and it is right whether or not the daemon was handed a usable environment.
 */

import os from 'node:os';

import type { ShellIdentity } from './execution-environment.js';

/** The subset of a passwd entry this module needs. */
export interface PasswdEntry {
  username?: string | null | undefined;
  homedir?: string | null | undefined;
  shell?: string | null | undefined;
}

/** Values to fall back on when the passwd lookup is unavailable or incomplete. */
export interface IdentityFallbacks {
  home?: string | undefined;
  user?: string | undefined;
  shell?: string | undefined;
}

/**
 * True when a string is present and is not just the numeric uid.
 *
 * `os.userInfo()` reports the uid as the username, as a string, when the uid has
 * no passwd entry — a container running as a bare uid, for instance. Passing
 * that on as `USER` and `LOGNAME` would be a quiet lie about who the shell is,
 * so it is treated as "no answer" and the fallbacks apply instead.
 */
function isUsableName(value: string | null | undefined): value is string {
  return typeof value === 'string' && value !== '' && !/^\d+$/.test(value);
}

/** True when a string is present and non-empty. */
function isUsablePath(value: string | null | undefined): value is string {
  return typeof value === 'string' && value !== '';
}

/**
 * Builds an identity from a passwd entry, falling back where it is missing.
 *
 * Pure, so the precedence is testable without a passwd database or a mock of
 * `node:os`: the passwd value always wins, and a fallback is used only when
 * passwd has nothing usable to say. `user` falls back to `'aether'` as a last
 * resort rather than to an empty string, so `USER`/`LOGNAME` are never blank —
 * a blank name makes some tools misbehave in confusing ways.
 */
export function resolveIdentityFrom(
  passwd: PasswdEntry | null,
  fallbacks: IdentityFallbacks
): ShellIdentity {
  return {
    user:
      (isUsableName(passwd?.username) ? passwd.username : undefined) ?? fallbacks.user ?? 'aether',
    home: (isUsablePath(passwd?.homedir) ? passwd.homedir : undefined) ?? fallbacks.home ?? '/',
    shell: (isUsablePath(passwd?.shell) ? passwd.shell : undefined) ?? fallbacks.shell ?? '/bin/sh',
  };
}

/**
 * The identity of the process Aether is running as on this host.
 *
 * The home directory is resolved as passwd → `os.homedir()` → the daemon's
 * `HOME`. Note that `os.homedir()` itself prefers `$HOME` on POSIX, so it is
 * only reached when passwd had nothing — which is the case it exists for.
 *
 * The returned `shell` is the account's *login shell* as passwd records it, and
 * it is a preference, not a decision: callers must still pass it through the
 * `TERMINAL_ALLOWED_SHELLS` allowlist. That matters for service accounts, whose
 * passwd shell is often `/usr/sbin/nologin` — an entry that must never be
 * spawned, and which the allowlist correctly refuses.
 */
export function resolveHostIdentity(): ShellIdentity {
  let passwd: PasswdEntry | null = null;
  try {
    passwd = os.userInfo();
  } catch {
    // A uid with no passwd entry. Not an error: the fallbacks cover it, and a
    // terminal is still usable when the account is anonymous.
  }

  return resolveIdentityFrom(passwd, {
    home: os.homedir(),
    user: process.env.USER ?? process.env.USERNAME,
    shell: process.env.SHELL,
  });
}

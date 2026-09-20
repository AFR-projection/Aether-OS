/**
 * The single definition of how Aether starts a process on a host.
 *
 * Every shell Aether spawns — the interactive Terminal, Code Studio's Run panel,
 * and any future application runtime, background process or AI-agent execution —
 * must construct its environment and its argument vector here. Nothing else in
 * the codebase may build a child environment, and a test enforces that by
 * checking every `pty.spawn` call site.
 *
 * This module is pure and free of `node:` imports on purpose: it is imported by
 * the frontend as well as by the backend and the host agent, so it must not pull
 * a Node builtin into the browser bundle. Resolving *whose* environment this is
 * needs `node:os`, and that lives in the node-only sibling module
 * `@aether/shared/node`.
 *
 * ## Why a login shell
 *
 * A shell started without `-l` is an *interactive, non-login* shell. It reads
 * `~/.bashrc` and nothing else — not `/etc/profile`, not `~/.profile`. On
 * Ubuntu and Debian the standard line that puts `~/.local/bin` on `PATH` lives
 * in `~/.profile`, which only a login shell reads. Starting one therefore has a
 * single, precise consequence: the host's own configuration for user-installed
 * programs never runs, so a tool installed by `pipx`, `cargo install`, `nvm`,
 * `rustup`, a `curl | bash` installer (or anything else that writes to
 * `~/.local/bin`) is on `PATH` over SSH and missing in Aether.
 *
 * The fix is to be a login shell, not to append the directories ourselves. The
 * paths a user's tools live in are the host's business; Aether's job is to give
 * the host's own startup files the chance to say so. Hardcoding `~/.local/bin`
 * would paper over a host whose profile chain is broken, diverge from what the
 * same user sees over SSH, and need editing again for every tool that picks a
 * different directory. With `-l`, a tool becomes available for exactly the
 * reason it becomes available in a normal login, and no tool is named anywhere
 * in this file.
 */

/**
 * The stock system `PATH`, as `/etc/profile` itself uses.
 *
 * This is the *starting* value, not the final one. A login shell re-derives
 * `PATH` from `/etc/profile` and then extends it from `~/.profile` and
 * `~/.bashrc`, which is where distribution- and user-specific locations come
 * from. Handing over the daemon's own `PATH` instead would be worse than
 * useless: it is the systemd service path, it reflects the agent's unit rather
 * than the user's login, and it is overwritten by `/etc/profile` in any case.
 */
export const SYSTEM_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** The terminal type Aether's client renders. `xterm.js` is the emulator. */
export const DEFAULT_TERM = 'xterm-256color';

/**
 * Variables copied from the spawning process's environment, by name.
 *
 * The environment is **never** inherited wholesale. The agent process holds
 * `AETHER_PAIRING_TOKEN` — and the backend holds `DATABASE_URL`, `JWT_SECRET`
 * and `ENCRYPTION_KEY` — so a shell running as the same user could read every
 * one of them with a single `env` command.
 *
 * Everything else a shell needs is either derived from the host's own login
 * files (which know nothing about Aether and cannot leak a secret) or from the
 * arguments below. The names on this list are locale and timezone settings:
 * nothing here is a credential, and each is carried only when the daemon
 * actually has a value for it.
 *
 * A new entry is a security decision, not a convenience. Anything matching
 * `AETHER_*`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD` or `*_KEY` must never be
 * added.
 */
export const INHERITED_ENV_NAMES = ['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ'] as const;

/**
 * Who the shell runs as, as the host itself describes it.
 *
 * These values come from the passwd database for the spawning process's
 * effective uid — see `resolveHostIdentity` in `@aether/shared/node`. They are
 * deliberately not read from `HOME`/`USER`/`SHELL` in the daemon's environment,
 * which under systemd may be absent, stale, or (in the default full-host
 * install, where the workspace root is `/`) point somewhere that is not a home
 * directory at all.
 */
export interface ShellIdentity {
  /** Login name, from passwd. */
  user: string;
  /** Home directory, from passwd. */
  home: string;
  /** The account's login shell, from passwd. */
  shell: string;
}

/**
 * The argument vector for a shell session.
 *
 * `-l` is added unconditionally, so the profile chain runs in both cases:
 *
 * - No command: an interactive login shell, what a terminal window wants.
 * - With a command: a login shell executing one command, which is how Code
 *   Studio's Run panel executes a file. It shares the environment model on
 *   purpose — a "run" that cannot see the user's installed tools would be a
 *   second, quieter version of the same bug.
 *
 * The cost of `-l` on the command path is real and accepted: profile scripts
 * run before each invocation, so a run is marginally slower and any output a
 * profile prints appears in the run's terminal. That is the honest price of the
 * run seeing what the shell sees.
 */
export function buildShellArgv(command?: string): string[] {
  return command === undefined || command === '' ? ['-l'] : ['-l', '-c', command];
}

export interface BuildShellEnvironmentOptions {
  /** The directory the process starts in. Reported as `PWD`, so `pwd` agrees. */
  cwd: string;
  /**
   * The environment of the process doing the spawning, passed in rather than
   * read from `process.env` here. That keeps this function pure and lets a test
   * assert the allowlist rule directly instead of spawning something to find
   * out.
   */
  ambient: Record<string, string | undefined>;
  /** Overrides the rendered terminal type. */
  term?: string;
}

/**
 * Builds the environment for a spawned shell.
 *
 * Contains only: the identity the host reports, the directory the process is
 * starting in, the terminal type, a stock `PATH`, and the named non-sensitive
 * variables from `INHERITED_ENV_NAMES`. Nothing from `ambient` is copied except
 * those names.
 */
export function buildShellEnvironment(
  identity: ShellIdentity,
  options: BuildShellEnvironmentOptions
): Record<string, string> {
  const env: Record<string, string> = {
    TERM: options.term ?? DEFAULT_TERM,
    COLORTERM: 'truecolor',
    USER: identity.user,
    LOGNAME: identity.user,
    HOME: identity.home,
    // The shell's own idea of its working directory. Passing a directory other
    // than the one the process actually starts in makes `pwd` disagree with the
    // prompt until the first `cd`.
    PWD: options.cwd,
    SHELL: identity.shell,
    PATH: SYSTEM_PATH,
  };

  for (const name of INHERITED_ENV_NAMES) {
    const value = options.ambient[name];
    if (value !== undefined && value !== '') env[name] = value;
  }

  return env;
}

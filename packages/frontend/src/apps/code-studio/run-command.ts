/**
 * The command that runs a file, guessed from its name.
 *
 * This is a *default*, not a rule: the Run panel shows it in an editable field
 * before anything executes, so a project that needs a flag, a different
 * interpreter, or `npm run dev` instead of the file itself is one edit away.
 * Guessing silently and running would be the wrong trade — the point of the
 * panel is that the command is visible before it runs.
 *
 * Only interpreters that are actually present on a default VPS are suggested.
 * `python` rather than `python3` would fail on most images that have only the
 * latter, and `ts-node` is not installed by default either, so TypeScript is
 * suggested through `npx` — which will fetch a runner on first use rather than
 * fail with "command not found".
 */

const RUNNERS: Record<string, (quoted: string) => string> = {
  js: (f) => `node ${f}`,
  mjs: (f) => `node ${f}`,
  cjs: (f) => `node ${f}`,
  py: (f) => `python3 ${f}`,
  rb: (f) => `ruby ${f}`,
  php: (f) => `php ${f}`,
  pl: (f) => `perl ${f}`,
  lua: (f) => `lua ${f}`,
  r: (f) => `Rscript ${f}`,
  sh: (f) => `bash ${f}`,
  bash: (f) => `bash ${f}`,
  zsh: (f) => `zsh ${f}`,
  go: (f) => `go run ${f}`,
  ts: (f) => `npx --yes tsx ${f}`,
  tsx: (f) => `npx --yes tsx ${f}`,
  // A single-file Java source runs directly under the JDK's launcher.
  java: (f) => `java ${f}`,
  // Rust and C compile, so the output lands next to the source and is then run.
  rs: (f) => `rustc ${f} -o /tmp/aether-run && /tmp/aether-run`,
  c: (f) => `cc ${f} -o /tmp/aether-run && /tmp/aether-run`,
  cpp: (f) => `c++ ${f} -o /tmp/aether-run && /tmp/aether-run`,
};

/** Quotes a path for a POSIX shell, so a space or quote in a name cannot break it. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The interpreter default for a file, or an empty string when there is no guess. */
export function defaultRunCommand(path: string): string {
  const name = path.split('/').pop() ?? path;
  const dot = name.lastIndexOf('.');

  // A dotfile (`.env`) has no extension to key on; nothing sensible to run.
  if (dot <= 0) return '';

  const runner = RUNNERS[name.slice(dot + 1).toLowerCase()];
  if (runner === undefined) return '';

  return runner(shellQuote(name));
}

/** The directory a path lives in, or an empty string for the root. */
export function directoryOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash <= 0 ? '' : path.slice(0, slash);
}

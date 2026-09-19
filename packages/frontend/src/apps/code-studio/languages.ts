/**
 * Maps a file name to the Monaco language id used for syntax highlighting.
 *
 * Monaco ships grammars for these ids out of the box; anything not listed falls
 * back to `plaintext`, which still edits fine, just without colouring. The
 * lookup checks a few whole-name special cases first (Dockerfile, Makefile and
 * the like have no useful extension) and then the extension.
 */

const BY_EXTENSION: Record<string, string> = {
  // Web
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  json: 'json',
  jsonc: 'json',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  vue: 'html',
  svelte: 'html',
  // Backend / systems
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  swift: 'swift',
  scala: 'scala',
  dart: 'dart',
  lua: 'lua',
  r: 'r',
  pl: 'perl',
  // Shell / config
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  ps1: 'powershell',
  bat: 'bat',
  cmd: 'bat',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  env: 'ini',
  properties: 'ini',
  // Data / markup
  xml: 'xml',
  svg: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  proto: 'protobuf',
  // Misc
  dockerfile: 'dockerfile',
  makefile: 'makefile',
};

const BY_FULL_NAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  'docker-compose.yml': 'yaml',
  'docker-compose.yaml': 'yaml',
  '.gitignore': 'ini',
  '.dockerignore': 'ini',
  '.env': 'ini',
  '.bashrc': 'shell',
  '.zshrc': 'shell',
  '.profile': 'shell',
  caddyfile: 'ini',
};

export function languageForFile(pathOrName: string): string {
  const name = (pathOrName.split('/').pop() ?? pathOrName).toLowerCase();

  const whole = BY_FULL_NAME[name];
  if (whole !== undefined) return whole;

  // A dotfile with no further extension (e.g. `.gitignore`) has no useful
  // extension to key on, so treat the whole name as the extension too.
  const lastDot = name.lastIndexOf('.');
  const ext = lastDot > 0 ? name.slice(lastDot + 1) : name;

  return BY_EXTENSION[ext] ?? 'plaintext';
}

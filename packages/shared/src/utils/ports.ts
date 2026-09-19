/**
 * Recognising a dev server from how it was started.
 *
 * The list is deliberately short, and every entry is a flag or a config key
 * whose name is not in doubt. A confidently wrong flag in a hint is worse than
 * no hint: it costs the user a debugging session to discover that Aether made
 * the mistake, not their project. Frameworks absent from this list fall through
 * to `null`, and the Ports app then explains the symptom instead of guessing at
 * a cure.
 *
 * The symptom, for the record: the preview opens, the page is blank, and the
 * browser console shows 404s for assets requested from `/` instead of from the
 * preview's own path.
 */

import type { ListeningPort, PortBasePathHint } from '../types/ports.js';

/** The path a port is previewed at, as both the proxy and the hint need it. */
export function previewBasePath(port: number): string {
  return `/ports/${port}/`;
}

export function basePathHintFor(port: ListeningPort): PortBasePathHint | null {
  const command = port.command ?? '';
  const base = previewBasePath(port.port);

  // Ordered most specific first: a `next dev` command line also contains `node`,
  // and a Vite server started through a package script contains neither binary.
  if (/(^|[/\s])next([\s-]|$)/.test(command)) {
    return {
      framework: 'Next.js',
      guidance: `Add basePath: '${base.replace(/\/$/, '')}' to next.config.js, then restart the server.`,
    };
  }
  if (/\b(vite|vitepress)\b/.test(command)) {
    return {
      framework: 'Vite',
      guidance: 'Vite takes the base path as a flag or in vite.config.',
      command: `npm run dev -- --base=${base}`,
    };
  }
  if (/\bnuxt\b/.test(command)) {
    return {
      framework: 'Nuxt',
      guidance: `Set app.baseURL to '${base}' in nuxt.config.ts, then restart the server.`,
    };
  }
  if (/\bastro\b/.test(command)) {
    return {
      framework: 'Astro',
      guidance: 'Astro takes the base path as a flag or in astro.config.',
      command: `npx astro dev --port ${port.port} --base ${base}`,
    };
  }
  if (/\b(webpack|webpack-dev-server)\b/.test(command)) {
    return {
      framework: 'webpack',
      guidance: `Set devServer.devMiddleware.publicPath to '${base}' in webpack.config.js, then restart.`,
    };
  }

  // Everything else — `python3 -m http.server`, a hand-rolled `node server.js`,
  // nginx — serves relative links and needs nothing. Saying so is more useful
  // than guessing, so the caller renders no hint at all.
  return null;
}

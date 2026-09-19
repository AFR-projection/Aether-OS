/**
 * Wires Monaco to run fully self-hosted.
 *
 * The default `@monaco-editor/react` loads Monaco from a CDN at runtime, which
 * a strict `script-src 'self'` CSP (see the backend's helmet config) forbids,
 * and a VPS with no outbound internet could not reach anyway. So instead:
 *
 * 1. Vite `?worker` imports bundle Monaco's web workers as same-origin scripts,
 *    and `MonacoEnvironment.getWorker` hands the right one to Monaco. Same
 *    origin satisfies `worker-src` (which falls back to `default-src 'self'`).
 * 2. `loader.config({ monaco })` points the React wrapper at the locally
 *    imported `monaco-editor` package rather than fetching it.
 *
 * Importing this module once (from the editor component) is enough; the setup
 * runs at import time.
 */
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
// monaco-editor's `exports` map is `{ "./*.js": "./esm/vs/*.js", "./*": ... }`,
// so the subpath is written WITHOUT the `esm/vs/` prefix but WITH the `.js`
// extension — `monaco-editor/editor/editor.worker.js` matches `"./*.js"` and
// resolves to `./esm/vs/editor/editor.worker.js`. Writing the old
// `esm/vs/...` path would double the prefix and fail to resolve.
// Vite's `?worker` import convention rewrites the module to export a Worker
// constructor as the default export; the eslint resolver cannot follow the
// query suffix, so it cannot confirm the export exists.
// eslint-disable-next-line import/default
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker';
// eslint-disable-next-line import/default
import cssWorker from 'monaco-editor/language/css/css.worker.js?worker';
// eslint-disable-next-line import/default
import htmlWorker from 'monaco-editor/language/html/html.worker.js?worker';
// eslint-disable-next-line import/default
import jsonWorker from 'monaco-editor/language/json/json.worker.js?worker';
// eslint-disable-next-line import/default
import tsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';

let configured = false;

export function setupMonaco(): void {
  if (configured) return;
  configured = true;

  // Monaco asks the environment for a worker by language label.
  self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      switch (label) {
        case 'json':
          return new jsonWorker();
        case 'css':
        case 'scss':
        case 'less':
          return new cssWorker();
        case 'html':
        case 'handlebars':
        case 'razor':
          return new htmlWorker();
        case 'typescript':
        case 'javascript':
          return new tsWorker();
        default:
          return new editorWorker();
      }
    },
  };

  loader.config({ monaco });
}

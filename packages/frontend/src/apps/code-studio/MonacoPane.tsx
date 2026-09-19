// eslint-disable-next-line import/no-named-as-default -- `Editor` is the wrapper's documented default export
import Editor, { type OnMount } from '@monaco-editor/react';

import { AETHER_THEME_ID, defineEditorTheme } from './editor-theme.js';
import { setupMonaco } from '../../lib/monaco-setup.js';

import type * as monacoNs from 'monaco-editor';

/**
 * The Monaco editor surface, isolated in its own module.
 *
 * Monaco is large, so this component is loaded lazily by Code Studio (via
 * `React.lazy`) — importing it is what pulls the editor and its workers into
 * their own bundle chunk, keeping them out of the desktop's initial load. The
 * workers and the local (non-CDN) loader are wired up by `setupMonaco`, which
 * runs once when this chunk is first evaluated.
 *
 * The component is intentionally thin: it owns none of the app state. The parent
 * reads and writes content through the editor instance handed back by `onMount`,
 * which keeps all the tab/dirty/save logic in one place in `CodeStudioApp`.
 */

setupMonaco();

export interface MonacoPaneProps {
  /** Synthetic per-file model URI, so each tab keeps its own model and undo. */
  path: string;
  /** Initial content, used only when the model for `path` is first created. */
  value: string;
  language: string;
  readOnly: boolean;
  onMount: OnMount;
  onChange: (value: string) => void;
}

export default function MonacoPane({
  path,
  value,
  language,
  readOnly,
  onMount,
  onChange,
}: MonacoPaneProps) {
  return (
    <Editor
      path={path}
      defaultValue={value}
      language={language}
      theme={AETHER_THEME_ID}
      // Keep models alive across mounts so switching tabs never loses edits;
      // Code Studio disposes them explicitly when a tab is closed.
      keepCurrentModel
      beforeMount={(monaco: typeof monacoNs) => defineEditorTheme(monaco)}
      onMount={onMount}
      onChange={(next) => onChange(next ?? '')}
      loading={<span className="text-sm text-slate-500">Loading editor…</span>}
      options={{
        readOnly,
        fontSize: 13,
        fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
        minimap: { enabled: true },
        smoothScrolling: true,
        scrollBeyondLastLine: false,
        renderWhitespace: 'selection',
        tabSize: 2,
        automaticLayout: true,
        cursorBlinking: 'smooth',
        padding: { top: 10 },
        bracketPairColorization: { enabled: true },
      }}
    />
  );
}

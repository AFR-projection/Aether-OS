import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { RotateCw, Save, Undo2, X } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { FileTree } from './FileTree.js';
import { languageForFile } from './languages.js';
import { Button } from '../../components/ui/Button.js';
import { ConfirmDialog } from '../../components/ui/Dialog.js';
import { Banner, EmptyState, ErrorState, LoadingState } from '../../components/ui/Feedback.js';
import { formatBytes } from '../../lib/format.js';
import { queryKeys } from '../../lib/query-client.js';
import { useDesktopStore } from '../../stores/desktop.store.js';
import { fsScopeKey, readFile, writeFile, type FsScope } from '../files/files-api.js';

import type { AppProps } from '../registry.js';
import type { FileEntry, ReadFileResponse } from '@aether/shared';
import type * as monacoNs from 'monaco-editor';

const MonacoPane = lazy(() => import('./MonacoPane.js'));

/**
 * Code Studio — a real code editor over the filesystem.
 *
 * It is built on Monaco (the engine behind VS Code), bundled and served locally
 * so it works with no internet and within the app's strict CSP. It has an
 * expanding file tree, tabbed editing with one Monaco model per file (so each
 * tab keeps its own content, cursor, and undo history), syntax highlighting for
 * the common languages, and a colour theme derived from the active OS theme.
 *
 * One safety rule outweighs any feature: a file the backend truncated for
 * display must never be written back, because a save would silently discard
 * everything past the truncation point. Such a file opens read-only. Binary
 * files open read-only too — Code Studio edits text.
 */

/** Monaco identifies a model by URI; this gives each file a stable, unique one. */
function modelUri(path: string): string {
  return `inmemory://aether/${path}`;
}

interface Tab {
  path: string;
  name: string;
}

export function CodeStudioApp({ windowId, props }: AppProps) {
  const queryClient = useQueryClient();
  const setWindowTitle = useDesktopStore((state) => state.setWindowTitle);

  // Code Studio edits whatever scope opened it: the workspace by default, or a
  // host agent's filesystem when the Files app opened a host file in it.
  const fs: FsScope =
    props.scope === 'host' && typeof props.agentId === 'string'
      ? { scope: 'host', agentId: props.agentId }
      : { scope: 'workspace' };
  const scopeKey = fsScopeKey(fs);

  const initialPath = typeof props.path === 'string' ? props.path : '';
  const [tabs, setTabs] = useState<Tab[]>(
    initialPath === '' ? [] : [{ path: initialPath, name: basename(initialPath) }]
  );
  const [activePath, setActivePath] = useState<string>(initialPath);
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(() => new Set());
  const [saveError, setSaveError] = useState<string | null>(null);

  /** Tab the user asked to close while it still had unsaved edits. */
  const [closingPath, setClosingPath] = useState<string | null>(null);

  const editorRef = useRef<monacoNs.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof monacoNs | null>(null);
  /** Saved-on-disk content per open file, for dirty comparison and revert. */
  const baselinesRef = useRef<Map<string, string>>(new Map());

  // One content query per open tab. React Query dedupes and caches these, so
  // switching back to an already-read tab is instant and never refetches
  // (staleTime: Infinity) — which is what stops a refetch from clobbering edits.
  const contentQueries = useQueries({
    queries: tabs.map((tab) => ({
      queryKey: queryKeys.fileContent(scopeKey, tab.path),
      queryFn: () => readFile(tab.path, undefined, fs),
      staleTime: Infinity,
      refetchOnWindowFocus: false,
    })),
  });

  const activeIndex = tabs.findIndex((tab) => tab.path === activePath);
  const activeQuery = activeIndex >= 0 ? contentQueries[activeIndex] : undefined;
  const loaded: ReadFileResponse | undefined = activeQuery?.data;

  const isBinary = loaded !== undefined && loaded.encoding === 'base64';
  const isTruncated = loaded?.truncated === true;
  const canEdit = loaded !== undefined && !isBinary && !isTruncated;
  const isDirty = dirtyPaths.has(activePath);

  // Record each file's on-disk baseline the first time its content arrives, so
  // dirty tracking and revert have something to compare against.
  useEffect(() => {
    tabs.forEach((tab, index) => {
      const data = contentQueries[index]?.data;
      if (data === undefined) return;
      if (baselinesRef.current.has(tab.path)) return;
      baselinesRef.current.set(tab.path, data.encoding === 'utf8' ? data.content : '');
    });
  }, [tabs, contentQueries]);

  // Window title tracks the active file and its dirty mark.
  useEffect(() => {
    if (activePath === '') {
      setWindowTitle(windowId, 'Code Studio');
    } else {
      setWindowTitle(windowId, `Code Studio — ${isDirty ? '• ' : ''}${basename(activePath)}`);
    }
  }, [activePath, isDirty, setWindowTitle, windowId]);

  const openFile = useCallback((entry: FileEntry) => {
    if (entry.type === 'directory') return;
    if (entry.escapesWorkspace || !entry.readable) return;

    setTabs((current) =>
      current.some((tab) => tab.path === entry.path)
        ? current
        : [...current, { path: entry.path, name: entry.name }]
    );
    setActivePath(entry.path);
  }, []);

  const disposeModel = useCallback((path: string) => {
    const monaco = monacoRef.current;
    if (monaco === null) return;
    const model = monaco.editor.getModel(monaco.Uri.parse(modelUri(path)));
    model?.dispose();
  }, []);

  const closeTab = useCallback(
    (path: string) => {
      disposeModel(path);
      baselinesRef.current.delete(path);
      setDirtyPaths((current) => {
        if (!current.has(path)) return current;
        const next = new Set(current);
        next.delete(path);
        return next;
      });
      setTabs((current) => {
        const index = current.findIndex((tab) => tab.path === path);
        if (index < 0) return current;
        const next = current.filter((tab) => tab.path !== path);
        // Move focus to a neighbour so the editor never points at a closed tab.
        setActivePath((active) => {
          if (active !== path) return active;
          const neighbour = next[index] ?? next[index - 1];
          return neighbour?.path ?? '';
        });
        return next;
      });
    },
    [disposeModel]
  );

  const requestCloseTab = useCallback(
    (path: string) => {
      if (dirtyPaths.has(path)) {
        setClosingPath(path);
        return;
      }
      closeTab(path);
    },
    [closeTab, dirtyPaths]
  );

  // Dispose every model when the window closes, so nothing leaks between opens.
  useEffect(
    () => () => {
      const monaco = monacoRef.current;
      if (monaco === null) return;
      baselinesRef.current.forEach((_value, path) => {
        monaco.editor.getModel(monaco.Uri.parse(modelUri(path)))?.dispose();
      });
    },
    []
  );

  const handleChange = useCallback(
    (value: string) => {
      const baseline = baselinesRef.current.get(activePath);
      if (baseline === undefined) return;
      setDirtyPaths((current) => {
        const dirty = value !== baseline;
        if (dirty === current.has(activePath)) return current;
        const next = new Set(current);
        if (dirty) next.add(activePath);
        else next.delete(activePath);
        return next;
      });
    },
    [activePath]
  );

  // The wrapper types the second arg as `any`; annotate against `monaco-editor`
  // directly so the ref keeps its real type and nothing downstream is unchecked.
  const handleMount = useCallback(
    (editor: monacoNs.editor.IStandaloneCodeEditor, monaco: typeof monacoNs) => {
      editorRef.current = editor;
      monacoRef.current = monaco;
    },
    []
  );

  const saveMutation = useMutation({
    mutationFn: (params: { path: string; content: string }) =>
      writeFile({ path: params.path, content: params.content, encoding: 'utf8' }, fs),
    onSuccess: (_result, params) => {
      baselinesRef.current.set(params.path, params.content);
      setDirtyPaths((current) => {
        if (!current.has(params.path)) return current;
        const next = new Set(current);
        next.delete(params.path);
        return next;
      });
      setSaveError(null);
      void queryClient.invalidateQueries({ queryKey: ['files', 'list'] });
    },
    onError: (error: unknown) => {
      setSaveError(error instanceof Error ? error.message : 'Could not save the file.');
    },
  });

  const save = useCallback(() => {
    const editor = editorRef.current;
    if (!canEdit || editor === null || saveMutation.isPending) return;
    saveMutation.mutate({ path: activePath, content: editor.getValue() });
  }, [activePath, canEdit, saveMutation]);

  const revert = useCallback(() => {
    const baseline = baselinesRef.current.get(activePath);
    if (baseline === undefined || editorRef.current === null) return;
    editorRef.current.setValue(baseline);
    setDirtyPaths((current) => {
      if (!current.has(activePath)) return current;
      const next = new Set(current);
      next.delete(activePath);
      return next;
    });
  }, [activePath]);

  const reload = useCallback(async () => {
    if (activeQuery === undefined) return;
    const result = await activeQuery.refetch();
    const data = result.data;
    if (data === undefined || editorRef.current === null) return;
    const content = data.encoding === 'utf8' ? data.content : '';
    baselinesRef.current.set(activePath, content);
    editorRef.current.setValue(content);
    setDirtyPaths((current) => {
      if (!current.has(activePath)) return current;
      const next = new Set(current);
      next.delete(activePath);
      return next;
    });
  }, [activePath, activeQuery]);

  // Ctrl/Cmd+S saves the active file. Registered on the document so it fires
  // whether focus is in the editor or on the toolbar.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        save();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [save]);

  const language = useMemo(() => languageForFile(activePath), [activePath]);
  const editorValue = loaded?.encoding === 'utf8' ? loaded.content : '';

  return (
    <div className="flex h-full flex-col bg-surface-800">
      {/* Toolbar */}
      <div className="flex items-center gap-1 border-b border-white/10 px-2 py-1.5">
        <Button
          size="sm"
          variant="primary"
          onClick={save}
          disabled={!canEdit || !isDirty}
          loading={saveMutation.isPending}
        >
          <Save size={14} className="mr-1 inline" aria-hidden="true" />
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={revert} disabled={!isDirty}>
          <Undo2 size={14} className="mr-1 inline" aria-hidden="true" />
          Revert
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void reload()} disabled={activePath === ''}>
          <RotateCw size={14} className="mr-1 inline" aria-hidden="true" />
          Reload
        </Button>

        <div className="flex-1" />

        {loaded !== undefined ? (
          <span className="text-[11px] text-slate-500">
            {loaded.mimeType} · {formatBytes(loaded.size)}
          </span>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Explorer */}
        <aside className="flex w-60 shrink-0 flex-col border-r border-white/10 bg-surface-900/40">
          <div className="border-b border-white/10 px-3 py-1.5 text-[11px] uppercase tracking-wide text-slate-500">
            Explorer
          </div>
          <FileTree activePath={activePath} onOpenFile={openFile} fs={fs} />
        </aside>

        {/* Editor column */}
        <div className="flex min-w-0 flex-1 flex-col">
          {tabs.length === 0 ? (
            <EmptyState
              title="No file open"
              description="Pick a file in the explorer to start editing."
            />
          ) : (
            <>
              {/* Tab strip */}
              <div className="flex shrink-0 items-stretch overflow-x-auto border-b border-white/10 bg-surface-900/30">
                {tabs.map((tab) => {
                  const active = tab.path === activePath;
                  return (
                    <div
                      key={tab.path}
                      className={[
                        'group flex shrink-0 items-center gap-1.5 border-r border-white/10 pl-3 pr-1.5 text-[13px]',
                        active
                          ? 'bg-surface-800 text-slate-100'
                          : 'text-slate-400 hover:bg-white/5',
                      ].join(' ')}
                    >
                      <button
                        type="button"
                        className="flex items-center gap-1.5 py-2"
                        onClick={() => setActivePath(tab.path)}
                        title={tab.path}
                      >
                        {dirtyPaths.has(tab.path) ? (
                          <span
                            className="h-1.5 w-1.5 rounded-full bg-accent"
                            aria-label="Unsaved changes"
                          />
                        ) : null}
                        <span className="max-w-[12rem] truncate">{tab.name}</span>
                      </button>
                      <button
                        type="button"
                        aria-label={`Close ${tab.name}`}
                        onClick={() => requestCloseTab(tab.path)}
                        className="rounded p-0.5 text-slate-500 opacity-0 hover:bg-white/10 hover:text-slate-200 group-hover:opacity-100"
                      >
                        <X size={13} aria-hidden="true" />
                      </button>
                    </div>
                  );
                })}
              </div>

              {saveError !== null ? (
                <div className="px-2 pt-2">
                  <Banner tone="danger" onDismiss={() => setSaveError(null)}>
                    {saveError}
                  </Banner>
                </div>
              ) : null}

              {isTruncated ? (
                <div className="px-2 pt-2">
                  <Banner tone="warning">
                    This file is larger than the reader limit, so only its beginning was loaded.
                    Editing is disabled to keep a save from overwriting the rest.
                  </Banner>
                </div>
              ) : null}

              {/* Editor / states */}
              <div className="relative min-h-0 flex-1">
                {activeQuery?.isPending ? (
                  <LoadingState label="Reading file…" />
                ) : activeQuery?.isError ? (
                  <ErrorState error={activeQuery.error} onRetry={() => void activeQuery.refetch()} />
                ) : isBinary ? (
                  <EmptyState
                    title="Binary file"
                    description="Code Studio edits text. Use the Files app to preview or download this file."
                  />
                ) : loaded !== undefined ? (
                  <Suspense fallback={<LoadingState label="Loading editor…" />}>
                    <MonacoPane
                      path={modelUri(activePath)}
                      value={editorValue}
                      language={language}
                      readOnly={!canEdit}
                      onMount={handleMount}
                      onChange={handleChange}
                    />
                  </Suspense>
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Status bar */}
      <div className="flex items-center justify-between border-t border-white/10 px-3 py-1 text-[11px] text-slate-500">
        <span className="truncate">{activePath === '' ? 'No file open' : activePath}</span>
        <span className="shrink-0 pl-3">
          {loaded !== undefined ? `${language} · ` : ''}
          {isDirty ? 'unsaved · ' : ''}Ctrl+S to save
        </span>
      </div>

      <ConfirmDialog
        open={closingPath !== null}
        title="Discard unsaved changes?"
        destructive
        confirmLabel="Discard and close"
        message="This file has unsaved changes. Closing the tab will discard them."
        onCancel={() => setClosingPath(null)}
        onConfirm={() => {
          if (closingPath !== null) closeTab(closingPath);
          setClosingPath(null);
        }}
      />
    </div>
  );
}

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

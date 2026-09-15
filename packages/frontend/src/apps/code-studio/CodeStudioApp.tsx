import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import { ConfirmDialog } from '../../components/ui/Dialog.js';
import { Banner, EmptyState, ErrorState, LoadingState } from '../../components/ui/Feedback.js';
import { formatBytes } from '../../lib/format.js';
import { queryKeys } from '../../lib/query-client.js';
import { useDesktopStore } from '../../stores/desktop.store.js';
import { listDirectory, readFile, writeFile } from '../files/files-api.js';

import type { AppProps } from '../registry.js';
import type { DirectoryListing, ReadFileResponse } from '@aether/shared';

/**
 * Code Studio — a plain-text editor over the workspace.
 *
 * It is deliberately a textarea with a line-number gutter rather than a code
 * editor component: no editor library is a dependency of this package, and
 * shipping a half-configured one would be worse than an honest plain editor.
 * Syntax highlighting is therefore **not implemented**; see
 * KNOWN-LIMITATIONS.md.
 *
 * One safety rule matters more than any feature here: a file that the backend
 * truncated for display must never be written back, because saving it would
 * silently discard everything past the truncation point. Saving is disabled in
 * that case.
 */

const TAB = '  ';

export function CodeStudioApp({ windowId, props }: AppProps) {
  const queryClient = useQueryClient();
  const setWindowTitle = useDesktopStore((state) => state.setWindowTitle);

  const [path, setPath] = useState<string>(typeof props.path === 'string' ? props.path : '');
  const [draft, setDraft] = useState<string>('');
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  /** Path the user asked to open while the current file still had edits. */
  const [pendingPath, setPendingPath] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const [cursorLine, setCursorLine] = useState(1);

  /** The workspace root listing, used as a simple file picker. */
  const rootListing = useQuery({
    queryKey: queryKeys.directory('', true),
    queryFn: () => listDirectory('', true),
  });

  const fileQuery = useQuery({
    queryKey: queryKeys.fileContent(path),
    queryFn: () => readFile(path),
    enabled: path !== '',
    // Re-reading a file on every window focus would silently throw away the
    // user's unsaved edits, so this query is not refetched automatically.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const loaded: ReadFileResponse | undefined = fileQuery.data;
  const isBinary = loaded !== undefined && loaded.encoding === 'base64';
  const isTruncated = loaded?.truncated === true;
  const canEdit = loaded !== undefined && !isBinary && !isTruncated;

  // Adopt the loaded content as the baseline whenever a different file arrives.
  useEffect(() => {
    if (loaded === undefined) return;
    setDraft(loaded.encoding === 'utf8' ? loaded.content : '');
    setDirty(false);
    setSaveError(null);
  }, [loaded]);

  useEffect(() => {
    if (path === '') {
      setWindowTitle(windowId, 'Code Studio');
    } else {
      const name = path.split('/').pop() ?? path;
      setWindowTitle(windowId, `Code Studio — ${dirty ? '• ' : ''}${name}`);
    }
  }, [dirty, path, setWindowTitle, windowId]);

  const saveMutation = useMutation({
    mutationFn: (params: { path: string; content: string }) =>
      writeFile({ path: params.path, content: params.content, encoding: 'utf8' }),
    onSuccess: () => {
      setDirty(false);
      setSaveError(null);
      void queryClient.invalidateQueries({ queryKey: ['files'] });
    },
    onError: (error: unknown) => {
      setSaveError(error instanceof Error ? error.message : 'Could not save the file.');
    },
  });

  const save = useCallback(() => {
    if (!canEdit || saveMutation.isPending) return;
    saveMutation.mutate({ path, content: draft });
  }, [canEdit, draft, path, saveMutation]);

  // Ctrl/Cmd+S saves. Registered on the document because the focus may be in
  // the textarea or on the toolbar; the handler only applies to this window.
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

  const openPath = useCallback(
    (next: string) => {
      if (dirty) {
        // Ask before throwing the edits away, and remember what to open so the
        // confirmation actually goes somewhere.
        setPendingPath(next);
        setDiscardOpen(true);
        return;
      }
      setPath(next);
    },
    [dirty]
  );

  const lineCount = useMemo(() => draft.split('\n').length, [draft]);

  const lineNumbers = useMemo(
    () => Array.from({ length: lineCount }, (_, index) => index + 1).join('\n'),
    [lineCount]
  );

  const handleTextareaScroll = () => {
    if (gutterRef.current !== null && textareaRef.current !== null) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

  const updateCursorLine = () => {
    const element = textareaRef.current;
    if (element === null) return;
    setCursorLine(element.value.slice(0, element.selectionStart).split('\n').length);
  };

  const files: DirectoryListing['entries'] = rootListing.data?.entries ?? [];

  return (
    <div className="flex h-full flex-col bg-surface-800">
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-2 py-1.5">
        <Button
          size="sm"
          variant="primary"
          onClick={save}
          disabled={!canEdit || !dirty}
          loading={saveMutation.isPending}
        >
          Save
        </Button>

        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            if (loaded === undefined) return;
            setDraft(loaded.encoding === 'utf8' ? loaded.content : '');
            setDirty(false);
            setSaveError(null);
          }}
          disabled={!dirty}
        >
          Revert
        </Button>

        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            void fileQuery.refetch();
          }}
          disabled={path === ''}
        >
          Reload from disk
        </Button>

        <div className="mx-1 h-5 w-px bg-white/10" />

        <span className="font-mono text-[11px] text-slate-400">
          {path === '' ? 'No file open' : path}
        </span>

        <div className="flex-1" />

        {loaded !== undefined ? (
          <span className="text-[11px] text-slate-500">
            {loaded.mimeType} · {formatBytes(loaded.size)}
            {dirty ? ' · unsaved changes' : ''}
          </span>
        ) : null}
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
            This file is larger than the reader limit, so only its beginning was loaded. Editing is
            disabled to prevent the rest of the file being overwritten by a save.
          </Banner>
        </div>
      ) : null}

      {isBinary ? (
        <div className="px-2 pt-2">
          <Banner tone="info">
            This looks like a binary file. Code Studio only edits text; use the Files app to
            download it.
          </Banner>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {/* File picker */}
        <aside className="flex w-56 shrink-0 flex-col border-r border-white/10 bg-surface-900/40">
          <div className="border-b border-white/10 px-2 py-1.5 text-[11px] uppercase tracking-wide text-slate-500">
            Workspace
          </div>
          <div className="min-h-0 flex-1 overflow-auto py-1">
            {rootListing.isPending ? (
              <LoadingState label="Listing…" />
            ) : rootListing.isError ? (
              <ErrorState
                error={rootListing.error}
                compact
                onRetry={() => void rootListing.refetch()}
              />
            ) : files.length === 0 ? (
              <p className="px-2 py-3 text-xs text-slate-500">The workspace is empty.</p>
            ) : (
              files.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  onClick={() => {
                    if (entry.type === 'directory') {
                      openPath(entry.path);
                      return;
                    }
                    openPath(entry.path);
                  }}
                  className={[
                    'flex w-full items-center gap-2 px-2 py-1 text-left text-xs',
                    entry.path === path
                      ? 'bg-accent/20 text-slate-100'
                      : 'text-slate-300 hover:bg-white/5',
                  ].join(' ')}
                >
                  <span>{entry.type === 'directory' ? '📁' : '📄'}</span>
                  <span className="truncate">{entry.name}</span>
                </button>
              ))
            )}
          </div>
          <p className="border-t border-white/10 px-2 py-1.5 text-[10px] leading-tight text-slate-500">
            Only the top level is listed. Open a file from the Files app to edit something deeper.
          </p>
        </aside>

        {/* Editor */}
        <div className="flex min-w-0 flex-1 flex-col">
          {path === '' ? (
            <EmptyState
              title="No file open"
              description="Pick a file on the left, or open one from the Files app."
            />
          ) : fileQuery.isPending ? (
            <LoadingState label="Reading file…" />
          ) : fileQuery.isError ? (
            <ErrorState error={fileQuery.error} onRetry={() => void fileQuery.refetch()} />
          ) : (
            <div className="flex min-h-0 flex-1">
              <div
                ref={gutterRef}
                aria-hidden="true"
                className="w-12 shrink-0 select-none overflow-hidden border-r border-white/10 bg-surface-900/60 py-2 text-right font-mono text-[12px] leading-[1.5] text-slate-600"
              >
                <pre className="pr-2">{lineNumbers}</pre>
              </div>

              <textarea
                ref={textareaRef}
                value={draft}
                readOnly={!canEdit}
                spellCheck={false}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setDirty(true);
                }}
                onScroll={handleTextareaScroll}
                onKeyUp={updateCursorLine}
                onClick={updateCursorLine}
                onKeyDown={(event) => {
                  // Tab indents instead of moving focus out of the editor, which
                  // is what anyone editing a file expects.
                  if (event.key === 'Tab') {
                    event.preventDefault();
                    const element = event.currentTarget;
                    const start = element.selectionStart;
                    const end = element.selectionEnd;
                    const next = `${draft.slice(0, start)}${TAB}${draft.slice(end)}`;
                    setDraft(next);
                    setDirty(true);
                    window.requestAnimationFrame(() => {
                      element.selectionStart = start + TAB.length;
                      element.selectionEnd = start + TAB.length;
                    });
                  }
                }}
                className="min-w-0 flex-1 resize-none bg-transparent p-2 font-mono text-[12px] leading-[1.5] text-slate-100 outline-none disabled:opacity-70"
              />
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-white/10 px-3 py-1 text-[11px] text-slate-500">
        <span>
          {lineCount} {lineCount === 1 ? 'line' : 'lines'}
        </span>
        <span>Ln {cursorLine} · Ctrl+S to save</span>
      </div>

      <ConfirmDialog
        open={discardOpen}
        title="Discard unsaved changes?"
        destructive
        confirmLabel="Discard and open"
        message="The current file has unsaved changes. Opening another file will discard them."
        onCancel={() => {
          setDiscardOpen(false);
          setPendingPath(null);
        }}
        onConfirm={() => {
          setDiscardOpen(false);
          setDirty(false);
          if (pendingPath !== null) setPath(pendingPath);
          setPendingPath(null);
        }}
      />
    </div>
  );
}

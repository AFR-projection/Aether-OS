import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  createDirectory,
  deletePath,
  downloadPath,
  listDirectory,
  renamePath,
  searchFiles,
  uploadFile,
  writeFile,
} from './files-api.js';
import { Button, Spinner } from '../../components/ui/Button.js';
import { ConfirmDialog, Dialog } from '../../components/ui/Dialog.js';
import { Banner, EmptyState, ErrorState, LoadingState } from '../../components/ui/Feedback.js';
import { Field, TextInput } from '../../components/ui/Input.js';
import { fileExtension, formatBytes, formatRelative } from '../../lib/format.js';
import { queryKeys } from '../../lib/query-client.js';
import { useDesktopStore } from '../../stores/desktop.store.js';

import type { AppProps } from '../registry.js';
import type { FileEntry } from '@aether/shared';

/**
 * The Files app.
 *
 * Every path shown here is relative to the workspace root, and the backend
 * re-validates containment against the real filesystem on each request — the
 * navigation state in this component is a convenience, never the boundary.
 */

const ICONS: Record<string, string> = {
  directory: '📁',
  symlink: '🔗',
  socket: '🔌',
  other: '❔',
};

const EXTENSION_ICONS: Record<string, string> = {
  ts: '🟦',
  tsx: '🟦',
  js: '🟨',
  jsx: '🟨',
  json: '🟨',
  md: '📝',
  txt: '📄',
  log: '📄',
  yml: '⚙️',
  yaml: '⚙️',
  toml: '⚙️',
  sh: '🐚',
  sql: '🗃️',
  png: '🖼️',
  jpg: '🖼️',
  jpeg: '🖼️',
  gif: '🖼️',
  svg: '🖼️',
  webp: '🖼️',
  pdf: '📕',
  zip: '🗜️',
  gz: '🗜️',
  tar: '🗜️',
  mp4: '🎬',
  mp3: '🎵',
};

function iconFor(entry: FileEntry): string {
  if (entry.type !== 'file') return ICONS[entry.type] ?? ICONS.other ?? '📄';
  return EXTENSION_ICONS[fileExtension(entry.name)] ?? '📄';
}

/** Splits a workspace-relative path into breadcrumb segments. */
function segmentsOf(path: string): Array<{ label: string; path: string }> {
  if (path === '') return [];
  const parts = path.split('/');
  return parts.map((label, index) => ({ label, path: parts.slice(0, index + 1).join('/') }));
}

function joinRelative(directory: string, name: string): string {
  return directory === '' ? name : `${directory}/${name}`;
}

export function FilesApp({ windowId, props }: AppProps) {
  const queryClient = useQueryClient();
  const openWindow = useDesktopStore((state) => state.openWindow);
  const setWindowTitle = useDesktopStore((state) => state.setWindowTitle);

  const [path, setPath] = useState<string>(typeof props.path === 'string' ? props.path : '');
  const [showHidden, setShowHidden] = useState(true);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);

  const isSearching = searchQuery.trim().length > 0;

  const listing = useQuery({
    queryKey: queryKeys.directory(path, showHidden),
    queryFn: () => listDirectory(path, showHidden),
    enabled: !isSearching,
  });

  const searchResults = useQuery({
    queryKey: queryKeys.fileSearch(path, searchQuery.trim()),
    queryFn: () => searchFiles(path, searchQuery.trim()),
    enabled: isSearching,
  });

  useEffect(() => {
    setWindowTitle(windowId, path === '' ? 'Files — Workspace' : `Files — ${path}`);
  }, [path, setWindowTitle, windowId]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['files'] });
  };

  const reportError = (error: unknown) => {
    setActionError(error instanceof Error ? error.message : 'The operation failed.');
  };

  const selectedEntry: FileEntry | null = useMemo(() => {
    const entries = isSearching
      ? (searchResults.data?.results ?? [])
      : (listing.data?.entries ?? []);
    return entries.find((entry) => entry.path === selectedPath) ?? null;
  }, [isSearching, listing.data, searchResults.data, selectedPath]);

  const createFolderMutation = useMutation({
    mutationFn: (name: string) => createDirectory(joinRelative(path, name), false),
    onSuccess: () => {
      setNewFolderOpen(false);
      setNewFolderName('');
      setActionError(null);
      invalidate();
    },
    onError: reportError,
  });

  const createFileMutation = useMutation({
    mutationFn: (name: string) =>
      writeFile({ path: joinRelative(path, name), content: '', createOnly: true }),
    onSuccess: () => {
      setNewFileOpen(false);
      setNewFileName('');
      setActionError(null);
      invalidate();
    },
    onError: reportError,
  });

  const renameMutation = useMutation({
    mutationFn: (params: { from: string; to: string }) => renamePath(params.from, params.to),
    onSuccess: () => {
      setRenameOpen(false);
      setSelectedPath(null);
      setActionError(null);
      invalidate();
    },
    onError: reportError,
  });

  const deleteMutation = useMutation({
    mutationFn: (entry: FileEntry) => deletePath(entry.path, entry.type === 'directory'),
    onSuccess: () => {
      setConfirmDeleteOpen(false);
      setSelectedPath(null);
      setActionError(null);
      invalidate();
    },
    onError: reportError,
  });

  const openEntry = (entry: FileEntry) => {
    if (entry.type === 'directory') {
      setPath(entry.path);
      setSelectedPath(null);
      setSearchQuery('');
      return;
    }

    if (entry.type === 'symlink' && entry.escapesWorkspace) {
      setActionError(
        'This symbolic link points outside the workspace, so Aether will not follow it.'
      );
      return;
    }

    if (entry.type === 'file') {
      openWindow('code-studio', {
        title: `Code Studio — ${entry.name}`,
        props: { path: entry.path },
        width: 1000,
        height: 660,
        singleton: false,
      });
    }
  };

  const handleUpload = async (files: FileList | null) => {
    if (files === null || files.length === 0) return;

    setUploading(true);
    setActionError(null);

    try {
      // Sequential rather than parallel: the backend enforces one file per
      // request and a burst of large uploads would compete for the same disk.
      for (const file of Array.from(files)) {
        await uploadFile(path, file);
      }
      invalidate();
    } catch (error) {
      reportError(error);
    } finally {
      setUploading(false);
      if (uploadInputRef.current !== null) uploadInputRef.current.value = '';
    }
  };

  const entries = isSearching ? (searchResults.data?.results ?? []) : (listing.data?.entries ?? []);
  const activeQuery = isSearching ? searchResults : listing;

  const handleRefresh = () => {
    void activeQuery.refetch();
  };

  const openSelected = () => {
    if (selectedEntry !== null) openEntry(selectedEntry);
  };

  return (
    <div className="flex h-full flex-col bg-surface-800">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-2 py-1.5">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
            setPath(parent);
            setSelectedPath(null);
          }}
          disabled={path === ''}
          title="Go to the parent directory"
        >
          ↑ Up
        </Button>

        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setPath('');
            setSelectedPath(null);
          }}
          disabled={path === ''}
        >
          ⌂ Workspace
        </Button>

        <Button size="sm" variant="ghost" onClick={handleRefresh} loading={activeQuery.isFetching}>
          ⟳
        </Button>

        <div className="mx-1 h-5 w-px bg-white/10" />

        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setNewFolderName('');
            setNewFolderOpen(true);
          }}
        >
          + Folder
        </Button>

        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setNewFileName('');
            setNewFileOpen(true);
          }}
        >
          + File
        </Button>

        <Button
          size="sm"
          variant="ghost"
          onClick={() => uploadInputRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? <Spinner className="h-3.5 w-3.5" /> : '⬆'} Upload
        </Button>

        <input
          ref={uploadInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => void handleUpload(event.target.files)}
        />

        <div className="mx-1 h-5 w-px bg-white/10" />

        <Button size="sm" variant="ghost" onClick={openSelected} disabled={selectedEntry === null}>
          Open
        </Button>

        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            if (selectedEntry === null) return;
            setRenameValue(selectedEntry.name);
            setRenameOpen(true);
          }}
          disabled={selectedEntry === null}
        >
          Rename
        </Button>

        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            if (selectedEntry === null) return;
            void downloadPath(selectedEntry.path).catch(reportError);
          }}
          disabled={selectedEntry === null || selectedEntry.type !== 'file'}
        >
          Download
        </Button>

        <Button
          size="sm"
          variant="ghost"
          onClick={() => setConfirmDeleteOpen(true)}
          disabled={selectedEntry === null}
        >
          Delete
        </Button>

        <div className="flex-1" />

        <label className="flex items-center gap-1.5 text-xs text-slate-400">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-accent"
            checked={showHidden}
            onChange={(event) => setShowHidden(event.target.checked)}
          />
          Hidden
        </label>

        <input
          type="search"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="Search names…"
          className="h-7 w-44 rounded border border-white/10 bg-surface-900/70 px-2 text-xs text-slate-100 placeholder:text-slate-500 focus:border-accent focus:outline-none"
        />
      </div>

      {/* Breadcrumb */}
      <div className="flex items-center gap-1 overflow-x-auto border-b border-white/10 px-3 py-1.5 text-xs">
        <button
          type="button"
          onClick={() => {
            setPath('');
            setSelectedPath(null);
          }}
          className="rounded px-1.5 py-0.5 text-slate-300 hover:bg-white/5"
        >
          workspace
        </button>
        {segmentsOf(path).map((segment) => (
          <span key={segment.path} className="flex items-center gap-1">
            <span className="text-slate-600">/</span>
            <button
              type="button"
              onClick={() => {
                setPath(segment.path);
                setSelectedPath(null);
              }}
              className="rounded px-1.5 py-0.5 text-slate-300 hover:bg-white/5"
            >
              {segment.label}
            </button>
          </span>
        ))}
        {isSearching ? (
          <span className="ml-2 text-slate-500">
            searching for “{searchQuery.trim()}” in this folder and below
          </span>
        ) : null}
      </div>

      {actionError !== null ? (
        <div className="px-2 pt-2">
          <Banner tone="danger" onDismiss={() => setActionError(null)}>
            {actionError}
          </Banner>
        </div>
      ) : null}

      {listing.data?.truncated === true ? (
        <div className="px-2 pt-2">
          <Banner tone="warning">
            This directory has more entries than the listing limit, so the list is incomplete.
          </Banner>
        </div>
      ) : null}

      {/* Listing */}
      <div className="min-h-0 flex-1 overflow-auto">
        {activeQuery.isPending ? (
          <LoadingState label="Reading directory…" />
        ) : activeQuery.isError ? (
          <ErrorState error={activeQuery.error} onRetry={handleRefresh} />
        ) : entries.length === 0 ? (
          <EmptyState
            title={isSearching ? 'No matching names' : 'This folder is empty'}
            description={
              isSearching
                ? 'Search matches file and folder names, not their contents.'
                : 'Use “+ Folder”, “+ File”, or “Upload” to add something.'
            }
          />
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-surface-800/95 text-left text-[11px] uppercase tracking-wide text-slate-500 backdrop-blur">
              <tr>
                <th className="px-3 py-1.5 font-medium">Name</th>
                <th className="w-28 px-3 py-1.5 font-medium">Size</th>
                <th className="w-24 px-3 py-1.5 font-medium">Mode</th>
                <th className="w-40 px-3 py-1.5 font-medium">Modified</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const selected = entry.path === selectedPath;
                return (
                  <tr
                    key={entry.path}
                    tabIndex={0}
                    aria-selected={selected}
                    onClick={() => setSelectedPath(entry.path)}
                    onDoubleClick={() => openEntry(entry)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') openEntry(entry);
                    }}
                    className={[
                      'cursor-default border-b border-white/5 outline-none',
                      selected ? 'bg-accent/20' : 'hover:bg-white/5',
                      entry.escapesWorkspace ? 'opacity-60' : '',
                    ].join(' ')}
                  >
                    <td className="px-3 py-1.5">
                      <span className="mr-2">{iconFor(entry)}</span>
                      <span className="text-slate-200">{entry.name}</span>
                      {entry.type === 'symlink' ? (
                        <span className="ml-2 font-mono text-[11px] text-slate-500">
                          → {entry.symlinkTarget ?? '?'}
                          {entry.escapesWorkspace ? ' (outside workspace)' : ''}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-1.5 text-xs text-slate-400">
                      {entry.type === 'directory' ? '—' : formatBytes(entry.size)}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-xs text-slate-500">{entry.mode}</td>
                    <td className="px-3 py-1.5 text-xs text-slate-400">
                      {formatRelative(entry.modifiedAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Status bar */}
      <div className="flex items-center justify-between border-t border-white/10 px-3 py-1 text-[11px] text-slate-500">
        <span>
          {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
        </span>
        <span className="truncate">
          {selectedEntry !== null
            ? `${selectedEntry.path} · ${selectedEntry.type} · ${formatBytes(selectedEntry.size)}`
            : 'Nothing selected'}
        </span>
      </div>

      {/* New folder */}
      <Dialog
        open={newFolderOpen}
        onClose={() => setNewFolderOpen(false)}
        title="New folder"
        width="sm"
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => setNewFolderOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              loading={createFolderMutation.isPending}
              disabled={newFolderName.trim() === ''}
              onClick={() => createFolderMutation.mutate(newFolderName.trim())}
            >
              Create
            </Button>
          </>
        }
      >
        <Field label="Folder name" hint="Created in the folder you are currently viewing.">
          {() => (
            <TextInput
              autoFocus
              value={newFolderName}
              onChange={(event) => setNewFolderName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && newFolderName.trim() !== '') {
                  createFolderMutation.mutate(newFolderName.trim());
                }
              }}
            />
          )}
        </Field>
      </Dialog>

      {/* New file */}
      <Dialog
        open={newFileOpen}
        onClose={() => setNewFileOpen(false)}
        title="New file"
        width="sm"
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => setNewFileOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              loading={createFileMutation.isPending}
              disabled={newFileName.trim() === ''}
              onClick={() => createFileMutation.mutate(newFileName.trim())}
            >
              Create
            </Button>
          </>
        }
      >
        <Field
          label="File name"
          hint="An empty file is created; it will not overwrite an existing one."
        >
          {() => (
            <TextInput
              autoFocus
              value={newFileName}
              onChange={(event) => setNewFileName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && newFileName.trim() !== '') {
                  createFileMutation.mutate(newFileName.trim());
                }
              }}
            />
          )}
        </Field>
      </Dialog>

      {/* Rename */}
      <Dialog
        open={renameOpen}
        onClose={() => setRenameOpen(false)}
        title="Rename"
        width="sm"
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => setRenameOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              loading={renameMutation.isPending}
              disabled={renameValue.trim() === ''}
              onClick={() => {
                if (selectedEntry === null) return;
                const parent = selectedEntry.path.includes('/')
                  ? selectedEntry.path.slice(0, selectedEntry.path.lastIndexOf('/'))
                  : '';
                renameMutation.mutate({
                  from: selectedEntry.path,
                  to: joinRelative(parent, renameValue.trim()),
                });
              }}
            >
              Rename
            </Button>
          </>
        }
      >
        <Field
          label="New name"
          hint="Renaming cannot move an item to another folder; use the workspace path instead."
        >
          {() => (
            <TextInput
              autoFocus
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
            />
          )}
        </Field>
      </Dialog>

      <ConfirmDialog
        open={confirmDeleteOpen}
        title={selectedEntry?.type === 'directory' ? 'Delete folder' : 'Delete file'}
        destructive
        busy={deleteMutation.isPending}
        confirmLabel="Delete"
        message={
          selectedEntry === null ? null : (
            <>
              <p>
                Delete <span className="font-mono text-slate-100">{selectedEntry.path}</span>?
              </p>
              {selectedEntry.type === 'directory' ? (
                <p className="mt-2 text-xs text-amber-300">
                  This folder and everything inside it will be removed. The server refuses to delete
                  the workspace root itself.
                </p>
              ) : null}
            </>
          )
        }
        onCancel={() => setConfirmDeleteOpen(false)}
        onConfirm={() => {
          if (selectedEntry !== null) deleteMutation.mutate(selectedEntry);
        }}
      />
    </div>
  );
}

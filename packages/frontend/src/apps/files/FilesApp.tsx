import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, ArrowUp, HardDrive, Home, RefreshCw, ShieldAlert, Upload } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { iconForEntry } from './file-icons.js';
import {
  createDirectory,
  deletePath,
  downloadPath,
  fsScopeKey,
  isHostScope,
  listDirectory,
  renamePath,
  searchFiles,
  uploadFile,
  writeFile,
  type FsScope,
} from './files-api.js';
import { Button } from '../../components/ui/Button.js';
import { ConfirmDialog, Dialog } from '../../components/ui/Dialog.js';
import { Banner, EmptyState, ErrorState, LoadingState } from '../../components/ui/Feedback.js';
import { Field, TextInput } from '../../components/ui/Input.js';
import { fetchAgents } from '../../lib/agent-api.js';
import { formatBytes, formatRelative } from '../../lib/format.js';
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

/** Splits a workspace-relative path into breadcrumb segments. */
function segmentsOf(path: string): Array<{ label: string; path: string }> {
  if (path === '') return [];
  const parts = path.split('/');
  return parts.map((label, index) => ({ label, path: parts.slice(0, index + 1).join('/') }));
}

function joinRelative(directory: string, name: string): string {
  return directory === '' ? name : `${directory}/${name}`;
}

/**
 * Aether's own install tree on the host — the "cosmos". In host scope the path
 * is relative to the agent's root (`/`), so the install directory `/opt/aether`
 * is the relative path `opt/aether`. Editing or deleting anything under here
 * (secrets, the database volume, the compose file, the agent config) can break
 * the running instance, so the GUI flags it and asks for an extra confirmation.
 */
const AETHER_SYSTEM_ROOT = 'opt/aether';

function isAetherSystemPath(host: boolean, path: string): boolean {
  if (!host) return false;
  return path === AETHER_SYSTEM_ROOT || path.startsWith(`${AETHER_SYSTEM_ROOT}/`);
}

/** True when the given entry, in host scope, lives inside Aether's own system tree. */
function entryIsAetherSystem(host: boolean, entryPath: string): boolean {
  return isAetherSystemPath(host, entryPath);
}

export function FilesApp({ windowId, props }: AppProps) {
  const queryClient = useQueryClient();
  const openWindow = useDesktopStore((state) => state.openWindow);
  const setWindowTitle = useDesktopStore((state) => state.setWindowTitle);

  const [path, setPath] = useState<string>(typeof props.path === 'string' ? props.path : '');
  const [fs, setFs] = useState<FsScope>(() =>
    props.scope === 'host' && typeof props.agentId === 'string'
      ? { scope: 'host', agentId: props.agentId }
      : { scope: 'workspace' }
  );
  const host = isHostScope(fs);
  const scopeKey = fsScopeKey(fs);

  const agentsQuery = useQuery({ queryKey: queryKeys.agents, queryFn: fetchAgents });
  const connectedAgents = useMemo(
    () => (agentsQuery.data ?? []).filter((agent) => agent.connected),
    [agentsQuery.data]
  );
  const hostLabel = host
    ? (connectedAgents.find((agent) => agent.agentId === fs.agentId)?.label ?? 'the host agent')
    : '';

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

  // Name search is a workspace-only capability; the agent protocol has no
  // recursive search, so host scope never enters the searching branch.
  const isSearching = !host && searchQuery.trim().length > 0;

  const listing = useQuery({
    queryKey: queryKeys.directory(scopeKey, path, showHidden),
    queryFn: () => listDirectory(path, showHidden, fs),
    enabled: !isSearching,
  });

  const searchResults = useQuery({
    queryKey: queryKeys.fileSearch(scopeKey, path, searchQuery.trim()),
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
    mutationFn: (name: string) => createDirectory(joinRelative(path, name), false, fs),
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
      writeFile({ path: joinRelative(path, name), content: '', createOnly: true }, fs),
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
    mutationFn: (entry: FileEntry) => deletePath(entry.path, entry.type === 'directory', fs),
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
        // Carry the scope through so the editor reads and writes the same host.
        props: { path: entry.path, ...(host ? { scope: 'host', agentId: fs.agentId } : {}) },
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
        <select
          aria-label="Filesystem location"
          value={host ? `host:${fs.agentId}` : 'workspace'}
          onChange={(event) => {
            const value = event.target.value;
            setFs(
              value === 'workspace'
                ? { scope: 'workspace' }
                : { scope: 'host', agentId: value.slice('host:'.length) }
            );
            setPath('');
            setSelectedPath(null);
            setSearchQuery('');
            setActionError(null);
          }}
          className="h-7 rounded border border-white/10 bg-surface-900/70 px-2 text-xs text-slate-100 focus:border-accent focus:outline-none"
        >
          <option value="workspace">Workspace (backend)</option>
          {connectedAgents.map((agent) => (
            <option key={agent.agentId} value={`host:${agent.agentId}`}>
              {agent.label} (host)
            </option>
          ))}
          {host && !connectedAgents.some((agent) => agent.agentId === fs.agentId) ? (
            <option value={`host:${fs.agentId}`}>host (disconnected)</option>
          ) : null}
        </select>

        <div className="mx-1 h-5 w-px bg-white/10" />

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
          icon={<ArrowUp size={14} strokeWidth={1.75} aria-hidden="true" />}
        >
          Up
        </Button>

        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setPath('');
            setSelectedPath(null);
          }}
          disabled={path === ''}
          icon={<Home size={14} strokeWidth={1.75} aria-hidden="true" />}
        >
          Workspace
        </Button>

        <Button
          size="sm"
          variant="ghost"
          aria-label="Refresh"
          title="Refresh"
          onClick={handleRefresh}
          loading={activeQuery.isFetching}
          icon={<RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />}
        />

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
          loading={uploading}
          disabled={host}
          title={host ? 'Uploading to a host agent is not available yet' : undefined}
          icon={<Upload size={14} strokeWidth={1.75} aria-hidden="true" />}
        >
          Upload
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
          disabled={selectedEntry === null || host}
          title={host ? 'Renaming on a host agent is not available yet' : undefined}
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
          disabled={selectedEntry === null || selectedEntry.type !== 'file' || host}
          title={host ? 'Downloading from a host agent is not available yet' : undefined}
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
          disabled={host}
          placeholder={host ? 'Search (workspace only)' : 'Search names…'}
          title={host ? 'Search is not available on host agents yet' : undefined}
          className="h-7 w-44 rounded border border-white/10 bg-surface-900/70 px-2 text-xs text-slate-100 placeholder:text-slate-500 focus:border-accent focus:outline-none disabled:opacity-40"
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
          {host ? 'root' : 'workspace'}
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

      {host ? (
        <div className="px-2 pt-2">
          <Banner tone="warning">
            <span className="inline-flex items-center gap-1.5">
              <HardDrive size={14} aria-hidden="true" />
              Browsing the real filesystem on {hostLabel}. Changes here affect the live host, not a
              sandbox.
            </span>
          </Banner>
        </div>
      ) : null}

      {isAetherSystemPath(host, path) ? (
        <div className="px-2 pt-2">
          <Banner tone="danger">
            <span className="inline-flex items-center gap-1.5">
              <ShieldAlert size={14} aria-hidden="true" />
              This is Aether&rsquo;s own system directory. It holds the secrets, database, and
              configuration this instance runs on. Editing or deleting anything here can break the
              platform you are using right now.
            </span>
          </Banner>
        </div>
      ) : null}

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
                const EntryIcon = iconForEntry(entry);
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
                      <span className="flex items-center gap-2">
                        <EntryIcon
                          size={16}
                          strokeWidth={1.75}
                          className="shrink-0 text-slate-400"
                          aria-hidden="true"
                        />
                        <span className="text-slate-200">{entry.name}</span>
                        {entry.type === 'symlink' ? (
                          <span className="ml-1 flex items-center gap-1 font-mono text-[11px] text-slate-500">
                            <ArrowRight size={12} aria-hidden="true" />
                            {entry.symlinkTarget ?? '?'}
                            {entry.escapesWorkspace ? ' (outside workspace)' : ''}
                          </span>
                        ) : null}
                      </span>
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
              {entryIsAetherSystem(host, selectedEntry.path) ? (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-rose-300">
                  <ShieldAlert size={13} aria-hidden="true" />
                  This is part of Aether&rsquo;s own system files. Removing it can break this
                  running instance and require a reinstall.
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

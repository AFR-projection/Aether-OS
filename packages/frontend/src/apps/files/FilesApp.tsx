import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, ArrowUp, HardDrive, Home, RefreshCw, ShieldAlert, Upload } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';

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
import { classifyFile, isViewable } from '../../lib/file-kind.js';
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

/**
 * The verb the context menu offers for an entry.
 *
 * Naming the destination rather than saying "Open" is the difference between a
 * menu that describes what will happen and one that makes the user find out.
 */
function menuLabelFor(entry: FileEntry): string {
  if (entry.type === 'directory') return 'Open';
  return isViewable(classifyFile({ name: entry.name })) ? 'Open in Media Viewer' : 'Open';
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

  /**
   * The right-click menu, and what it was opened on.
   *
   * `entry` is null when the click landed on empty space, where the useful
   * actions are the ones that create something rather than act on a row. Delete
   * already existed but only as a toolbar button that stays disabled until a
   * row is selected, which reads as "there is no delete" to anyone who expects
   * the right-click every other file manager has had for thirty years.
   */
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    entry: FileEntry | null;
  } | null>(null);

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
    mutationFn: (params: { from: string; to: string }) =>
      renamePath(params.from, params.to, false, fs),
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

  /**
   * Opens a file in the application that suits it.
   *
   * A directory navigates. A file goes to the editor or to the Media Viewer
   * depending on what its name says it is. Anything neither tool can present is
   * still offered to the editor, which will say plainly that the file is not
   * text — rather than the wall of base64 a photograph used to open into.
   *
   * The decision is made from the name alone, and deliberately: the directory
   * listing does not carry a content type, and fetching each file's bytes just
   * to decide which window to open would cost a read per double-click. The
   * server classifies the bytes when the file is actually loaded, which is what
   * catches the extensionless cases — `/etc/hostname`, `.env`, `Dockerfile` —
   * that the name cannot.
   */
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

    if (entry.type !== 'file') return;

    // The scope travels with the window so both apps read and write the same
    // machine the Files app is showing.
    const scopeProps = host ? { scope: 'host', agentId: fs.agentId } : {};
    const kind = classifyFile({ name: entry.name });

    if (isViewable(kind)) {
      openWindow('media-viewer', {
        title: `${entry.name} — Media Viewer`,
        props: { path: entry.path, name: entry.name, ...scopeProps },
        width: 900,
        height: 640,
        singleton: false,
      });
      return;
    }

    openWindow('code-studio', {
      title: `Code Studio — ${entry.name}`,
      props: { path: entry.path, ...scopeProps },
      width: 1000,
      height: 660,
      singleton: false,
    });
  };

  const handleUpload = async (files: FileList | null) => {
    if (files === null || files.length === 0) return;

    setUploading(true);
    setActionError(null);

    try {
      // Sequential rather than parallel: the backend enforces one file per
      // request and a burst of large uploads would compete for the same disk.
      for (const file of Array.from(files)) {
        await uploadFile(path, file, fs);
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

  /** Opens the context menu at the pointer, selecting what it was opened on. */
  const showContextMenu = (event: MouseEvent, entry: FileEntry | null) => {
    event.preventDefault();
    if (entry !== null) setSelectedPath(entry.path);
    setContextMenu({ x: event.clientX, y: event.clientY, entry });
  };

  // A menu that survives a click elsewhere — or a listing that reloads
  // underneath it — would act on something the user is no longer looking at.
  useEffect(() => {
    if (contextMenu === null) return;

    const close = () => setContextMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };

    window.addEventListener('click', close);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [contextMenu]);

  // Read once into a const: TypeScript keeps a null check's narrowing inside
  // the handlers below for a const, but not for a property access.
  const menuEntry: FileEntry | null = contextMenu?.entry ?? null;

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
          disabled={selectedEntry === null}
        >
          Rename
        </Button>

        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            if (selectedEntry === null) return;
            void downloadPath(selectedEntry.path, fs).catch(reportError);
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
      <div
        className="min-h-0 flex-1 overflow-auto"
        onContextMenu={(event) => {
          // Rows handle their own. This is the menu for the space around them,
          // which is where a file manager puts its "new" and "refresh".
          if ((event.target as HTMLElement).closest('tr') !== null) return;
          showContextMenu(event, null);
        }}
      >
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
                    onContextMenu={(event) => showContextMenu(event, entry)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') openEntry(entry);
                      // Delete acts on the focused row, as it does in a file
                      // manager. It only fires for a row that already has focus,
                      // so a dialog's own inputs are never affected.
                      if (event.key === 'Delete') {
                        setSelectedPath(entry.path);
                        setConfirmDeleteOpen(true);
                      }
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

      {contextMenu !== null ? (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} emptySpace={menuEntry === null}>
          {menuEntry === null ? (
            <>
              <MenuItem
                label="New folder"
                onSelect={() => {
                  setNewFolderName('');
                  setNewFolderOpen(true);
                }}
              />
              <MenuItem
                label="New file"
                onSelect={() => {
                  setNewFileName('');
                  setNewFileOpen(true);
                }}
              />
              <MenuItem
                label="Upload files"
                disabled={uploading}
                onSelect={() => uploadInputRef.current?.click()}
              />
              <MenuItem label="Refresh" onSelect={handleRefresh} />
            </>
          ) : (
            <>
              <MenuItem
                label={menuLabelFor(menuEntry)}
                disabled={menuEntry.escapesWorkspace}
                title={
                  menuEntry.escapesWorkspace
                    ? 'This link points outside the workspace, so Aether will not follow it.'
                    : undefined
                }
                onSelect={() => openEntry(menuEntry)}
              />
              <MenuItem
                label="Open in Code Studio"
                disabled={menuEntry.type === 'directory' || menuEntry.escapesWorkspace}
                onSelect={() =>
                  openWindow('code-studio', {
                    title: `Code Studio — ${menuEntry.name}`,
                    props: {
                      path: menuEntry.path,
                      ...(host ? { scope: 'host', agentId: fs.agentId } : {}),
                    },
                    width: 1000,
                    height: 660,
                    singleton: false,
                  })
                }
              />
              <MenuItem
                label="Rename"
                onSelect={() => {
                  setRenameValue(menuEntry.name);
                  setRenameOpen(true);
                }}
              />
              <MenuItem
                label="Download"
                disabled={menuEntry.type !== 'file'}
                onSelect={() => void downloadPath(menuEntry.path, fs).catch(reportError)}
              />
              <div className="my-1 h-px bg-white/10" />
              <MenuItem label="Delete" danger onSelect={() => setConfirmDeleteOpen(true)} />
            </>
          )}
        </ContextMenu>
      ) : null}

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

/** The panel a context menu's items sit in, positioned at the pointer. */
function ContextMenu({
  x,
  y,
  emptySpace,
  children,
}: {
  x: number;
  y: number;
  /** True when the menu was opened on the space around the rows, not on one. */
  emptySpace: boolean;
  children: ReactNode;
}) {
  return (
    <div
      role="menu"
      aria-label={emptySpace ? 'Folder actions' : 'File actions'}
      style={{ left: x, top: y }}
      className="fixed z-50 min-w-44 overflow-hidden rounded-md border border-white/10 bg-surface-800 py-1 shadow-2xl"
    >
      {children}
    </div>
  );
}

/** One action in a context menu. */
function MenuItem({
  label,
  onSelect,
  disabled = false,
  danger = false,
  title,
}: {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      title={title}
      onClick={onSelect}
      className={[
        'block w-full px-3 py-1.5 text-left text-[13px]',
        disabled
          ? 'cursor-default text-slate-600'
          : danger
            ? 'text-red-300 hover:bg-red-500/15'
            : 'text-slate-200 hover:bg-white/10',
      ].join(' ')}
    >
      {label}
    </button>
  );
}

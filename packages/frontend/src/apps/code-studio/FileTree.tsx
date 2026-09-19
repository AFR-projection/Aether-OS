import { useQuery } from '@tanstack/react-query';
import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  FileCode2,
  FileJson,
  FileText,
  FileType,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  Settings2,
} from 'lucide-react';
import { useState } from 'react';

import { queryKeys } from '../../lib/query-client.js';
import { fsScopeKey, listDirectory, type FsScope } from '../files/files-api.js';

import type { FileEntry } from '@aether/shared';
import type { LucideIcon } from 'lucide-react';

/**
 * The Code Studio file explorer — a lazily-expanding tree over the filesystem.
 *
 * Each directory fetches its own children only when first expanded, so opening
 * the app never lists the whole tree at once. Expansion state lives per-node in
 * the component that renders it, which is enough for an explorer that is rebuilt
 * from the root each time the app opens.
 *
 * File-type icons are chosen from the extension purely for legibility; they are
 * lucide glyphs, never emoji.
 */

function iconForEntry(entry: FileEntry): LucideIcon {
  if (entry.type === 'directory') return Folder;

  const name = entry.name.toLowerCase();
  const ext = name.includes('.') ? (name.split('.').pop() ?? '') : '';

  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp'].includes(ext)) return ImageIcon;
  if (['json', 'jsonc'].includes(ext)) return FileJson;
  if (
    [
      'js',
      'jsx',
      'ts',
      'tsx',
      'mjs',
      'cjs',
      'py',
      'go',
      'rs',
      'rb',
      'java',
      'c',
      'cpp',
      'cs',
      'php',
      'sh',
    ].includes(ext)
  ) {
    return FileCode2;
  }
  if (['md', 'markdown', 'txt', 'log'].includes(ext)) return FileText;
  if (['yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'env'].includes(ext)) return Settings2;
  if (ext === '') return FileType;
  return FileIcon;
}

export function FileTree({
  activePath,
  onOpenFile,
  fs,
}: {
  activePath: string;
  onOpenFile: (entry: FileEntry) => void;
  fs?: FsScope;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-auto py-1 text-[13px]">
      <DirectoryNode path="" depth={0} activePath={activePath} onOpenFile={onOpenFile} fs={fs} />
    </div>
  );
}

function DirectoryNode({
  path,
  depth,
  activePath,
  onOpenFile,
  fs,
}: {
  path: string;
  depth: number;
  activePath: string;
  onOpenFile: (entry: FileEntry) => void;
  fs?: FsScope;
}) {
  // A DirectoryNode is only rendered once its parent is expanded (the root
  // mounts expanded), so it always fetches — there is no collapsed state here.
  // Per-folder collapse lives in ExpandableDirectory.
  const listing = useQuery({
    queryKey: queryKeys.directory(fsScopeKey(fs), path, false),
    queryFn: () => listDirectory(path, false, fs),
    staleTime: 30_000,
  });

  const entries = listing.data?.entries ?? [];
  // Directories first, then files, each alphabetically — the familiar order.
  const sorted = [...entries].sort((a, b) => {
    if (a.type === 'directory' && b.type !== 'directory') return -1;
    if (a.type !== 'directory' && b.type === 'directory') return 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div>
      {sorted.map((entry) =>
        entry.type === 'directory' ? (
          <ExpandableDirectory
            key={entry.path}
            entry={entry}
            depth={depth}
            activePath={activePath}
            onOpenFile={onOpenFile}
            fs={fs}
          />
        ) : (
          <FileRow
            key={entry.path}
            entry={entry}
            depth={depth}
            active={entry.path === activePath}
            onOpenFile={onOpenFile}
          />
        )
      )}

      {listing.isPending ? (
        <Row depth={depth} muted>
          Loading…
        </Row>
      ) : null}
      {listing.isError ? (
        <Row depth={depth} muted>
          Could not read this folder.
        </Row>
      ) : null}
      {!listing.isPending && !listing.isError && sorted.length === 0 && depth > 0 ? (
        <Row depth={depth} muted>
          Empty
        </Row>
      ) : null}
    </div>
  );
}

function ExpandableDirectory({
  entry,
  depth,
  activePath,
  onOpenFile,
  fs,
}: {
  entry: FileEntry;
  depth: number;
  activePath: string;
  onOpenFile: (entry: FileEntry) => void;
  fs?: FsScope;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1 py-1 pr-2 text-left text-slate-300 hover:bg-white/5"
        style={{ paddingLeft: depth * 12 + 6 }}
      >
        {open ? (
          <ChevronDown size={14} className="shrink-0 text-slate-500" aria-hidden="true" />
        ) : (
          <ChevronRight size={14} className="shrink-0 text-slate-500" aria-hidden="true" />
        )}
        {open ? (
          <FolderOpen size={15} className="shrink-0 text-accent" aria-hidden="true" />
        ) : (
          <Folder size={15} className="shrink-0 text-accent" aria-hidden="true" />
        )}
        <span className="truncate">{entry.name}</span>
      </button>

      {open ? (
        <DirectoryNode
          path={entry.path}
          depth={depth + 1}
          activePath={activePath}
          onOpenFile={onOpenFile}
          fs={fs}
        />
      ) : null}
    </div>
  );
}

function FileRow({
  entry,
  depth,
  active,
  onOpenFile,
}: {
  entry: FileEntry;
  depth: number;
  active: boolean;
  onOpenFile: (entry: FileEntry) => void;
}) {
  const Icon = iconForEntry(entry);
  const disabled = entry.escapesWorkspace || !entry.readable;

  return (
    <button
      type="button"
      disabled={disabled}
      title={disabled ? 'This entry cannot be opened.' : entry.path}
      onClick={() => onOpenFile(entry)}
      className={[
        'flex w-full items-center gap-1.5 py-1 pr-2 text-left',
        active ? 'bg-accent/20 text-slate-100' : 'text-slate-300 hover:bg-white/5',
        disabled ? 'cursor-not-allowed opacity-40' : '',
      ].join(' ')}
      style={{ paddingLeft: depth * 12 + 24 }}
    >
      <Icon size={15} className="shrink-0 text-slate-400" aria-hidden="true" />
      <span className="truncate">{entry.name}</span>
    </button>
  );
}

function Row({
  depth,
  muted,
  children,
}: {
  depth: number;
  muted?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={['py-1 pr-2 text-xs', muted ? 'text-slate-600' : 'text-slate-300'].join(' ')}
      style={{ paddingLeft: depth * 12 + 24 }}
    >
      {children}
    </div>
  );
}

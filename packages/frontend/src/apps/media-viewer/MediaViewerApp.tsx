import { useQuery } from '@tanstack/react-query';
import { AudioLines, Download, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import { EmptyState, ErrorState, LoadingState } from '../../components/ui/Feedback.js';
import { classifyFile } from '../../lib/file-kind.js';
import { useDesktopStore } from '../../stores/desktop.store.js';
import { downloadPath, mediaUrl, requestMediaTicket, type FsScope } from '../files/files-api.js';

import type { AppProps } from '../registry.js';

/**
 * The Media Viewer.
 *
 * Images, video, audio and PDFs open here instead of in Code Studio, because
 * the editor is the wrong tool for all four: it would show a base64 wall for a
 * photograph, and nothing at all for a film.
 *
 * The bytes are loaded by the element itself from `/api/files/raw` rather than
 * fetched through the API client. That is what makes a video seekable: an HTTP
 * range request becomes a range request on the agent, so scrubbing a two-hour
 * recording costs the frames being watched instead of the whole file buffered
 * in memory first. The URL carries a ticket because a media element cannot send
 * an Authorization header — see `security/media-ticket.ts`.
 */

const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4] as const;
const MIN_ZOOM = ZOOM_STEPS[0];
const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];

function readString(props: Record<string, unknown>, key: string): string | undefined {
  const value = props[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Rebuilds the filesystem scope a window was opened with. */
function scopeFromProps(props: Record<string, unknown>): FsScope | undefined {
  if (props.scope === 'host' && typeof props.agentId === 'string') {
    return { scope: 'host', agentId: props.agentId };
  }
  if (props.scope === 'workspace') return { scope: 'workspace' };
  return undefined;
}

export function MediaViewerApp({ windowId, props }: AppProps) {
  const setWindowTitle = useDesktopStore((state) => state.setWindowTitle);

  const path = readString(props, 'path') ?? '';
  const name = readString(props, 'name') ?? path.split('/').pop() ?? 'file';
  const mimeType = readString(props, 'mimeType');
  const fs = useMemo(() => scopeFromProps(props), [props]);

  const [zoom, setZoom] = useState(1);
  const [notice, setNotice] = useState<string | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    setWindowTitle(windowId, `${name} — Media Viewer`);
  }, [name, setWindowTitle, windowId]);

  /**
   * The ticket is fetched once per file and reused by every request the player
   * makes. Holding it in the query cache rather than in component state means a
   * reopened window for the same file does not mint another one.
   */
  const ticketQuery = useQuery({
    queryKey: ['media-ticket', path, fs?.scope ?? 'workspace', fs?.agentId ?? ''],
    queryFn: () => requestMediaTicket(path, fs),
    enabled: path !== '',
    // Valid for ten minutes on the server; refreshing at nine keeps a long
    // video playing past the point where a stale ticket would start failing.
    staleTime: 9 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const ticket = ticketQuery.data?.ticket;
  const src = ticket !== undefined ? mediaUrl(path, ticket, fs) : undefined;
  const kind = classifyFile({ name, mimeType });

  const handleDownload = async () => {
    try {
      await downloadPath(path, fs);
    } catch {
      setNotice('The download could not be started.');
    }
  };

  const zoomBy = (direction: 1 | -1) => {
    const index = ZOOM_STEPS.findIndex((step) => step >= zoom);
    const current = index === -1 ? ZOOM_STEPS.length - 1 : index;
    const next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, current + direction))];
    if (next !== undefined) setZoom(next);
  };

  if (path === '') {
    return (
      <EmptyState
        title="Nothing to show"
        description="This window was opened without a file. Use Files to pick an image, a video, or an audio track."
      />
    );
  }

  if (ticketQuery.isError) {
    return <ErrorState error={ticketQuery.error} onRetry={() => void ticketQuery.refetch()} />;
  }

  return (
    <div className="flex h-full flex-col bg-surface-900">
      <div className="flex items-center gap-2 border-b border-white/10 px-2 py-1.5">
        <span className="truncate text-xs text-slate-200" title={path}>
          {name}
        </span>

        <div className="flex-1" />

        {kind === 'image' ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => zoomBy(-1)}
              disabled={zoom <= MIN_ZOOM}
              title="Zoom out"
            >
              <ZoomOut className="h-3.5 w-3.5" />
            </Button>
            <button
              type="button"
              onClick={() => setZoom(1)}
              title="Reset to 100%"
              className="min-w-14 rounded px-2 py-1 text-[11px] text-slate-300 hover:bg-white/5"
            >
              {Math.round(zoom * 100)}%
            </button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => zoomBy(1)}
              disabled={zoom >= MAX_ZOOM}
              title="Zoom in"
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </Button>

            {naturalSize !== null ? (
              <span className="px-1 text-[11px] text-slate-500">
                {naturalSize.width} x {naturalSize.height}
              </span>
            ) : null}
          </>
        ) : null}

        <Button size="sm" variant="ghost" onClick={() => void handleDownload()} title="Save a copy">
          <Download className="h-3.5 w-3.5" />
          <span className="ml-1">Download</span>
        </Button>
      </div>

      {notice !== null ? (
        <div className="border-b border-amber-500/30 bg-amber-950/40 px-3 py-1 text-[11px] text-amber-100">
          {notice}
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1 overflow-auto">
        {src === undefined ? (
          <LoadingState label="Preparing the file…" />
        ) : kind === 'image' ? (
          <div className="flex min-h-full items-center justify-center p-4">
            <img
              src={src}
              alt={name}
              onLoad={(event) => {
                setNaturalSize({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                });
              }}
              onError={() =>
                setNotice(
                  'The browser could not decode this image. The bytes are intact, so the format is simply not one it supports.'
                )
              }
              style={{ width: `${zoom * 100}%`, maxWidth: zoom <= 1 ? '100%' : 'none' }}
              className="object-contain"
            />
          </div>
        ) : kind === 'video' ? (
          <div className="flex h-full items-center justify-center bg-black p-2">
            <video
              src={src}
              controls
              playsInline
              preload="metadata"
              className="max-h-full max-w-full"
              onError={() =>
                setNotice(
                  'This video did not play. The container or codec may not be one the browser supports; downloading it and playing it locally will still work.'
                )
              }
            />
          </div>
        ) : kind === 'audio' ? (
          <div className="flex h-full flex-col items-center justify-center gap-5 p-6">
            <AudioLines className="h-12 w-12 text-slate-600" strokeWidth={1.25} />
            <audio
              src={src}
              controls
              className="w-full max-w-md"
              onError={() => setNotice('This audio track did not play in the browser.')}
            />
          </div>
        ) : kind === 'pdf' ? (
          /* The browser's own PDF viewer pages, searches and prints better than
             anything worth reimplementing here, so it is embedded directly. */
          <iframe src={src} title={name} className="h-full w-full border-0 bg-white" />
        ) : (
          <EmptyState
            title="No preview for this file type"
            description={`${name} is ${mimeType ?? 'an unrecognised format'}. Download it to open it in an application that handles it.`}
            action={
              <Button size="sm" onClick={() => void handleDownload()}>
                <Download className="mr-1 h-3.5 w-3.5" />
                Download
              </Button>
            }
          />
        )}
      </div>

      <div className="flex items-center gap-3 border-t border-white/10 px-3 py-1 text-[11px] text-slate-500">
        <span>{mimeType ?? 'unknown type'}</span>
        <span className="flex-1" />
        <span>{fs?.scope === 'host' ? 'host' : 'workspace'}</span>
        <button
          type="button"
          onClick={() => void ticketQuery.refetch()}
          title="Request access to the file again"
          className="flex items-center gap-1 rounded px-1 hover:bg-white/5"
        >
          <RotateCcw className="h-3 w-3" />
          Reload
        </button>
      </div>
    </div>
  );
}

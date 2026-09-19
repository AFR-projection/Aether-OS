import { ExternalLink, RotateCw } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import { EmptyState } from '../../components/ui/Feedback.js';
import { useDesktopStore } from '../../stores/desktop.store.js';

import type { AppProps } from '../registry.js';

/**
 * A server running on the host, framed.
 *
 * The page is not fetched through this app and its bytes are not touched here:
 * the iframe points straight at the preview address, so the browser treats it as
 * what it is — a different origin. That matters for two reasons. The project
 * sees itself at `/` of its own origin, so the absolute asset URLs every
 * framework emits resolve normally; and nothing it runs can reach this desktop's
 * storage or session, which an app relayed *through* the desktop's own origin
 * would be able to do.
 *
 * Reloading remounts the frame rather than re-fetching through the API, so a dev
 * server's own hot-reload behaviour is what the user gets.
 */
export function PortPreviewApp({ windowId, props }: AppProps) {
  const setWindowTitle = useDesktopStore((state) => state.setWindowTitle);
  const [generation, setGeneration] = useState(0);

  const port = typeof props.port === 'number' ? props.port : null;
  const url = typeof props.url === 'string' ? props.url : null;

  // The title is set from the port the window was opened for. It does not
  // follow `url`, because the URL never changes for a given window: a preview
  // that is stopped and started again is a new preview, on a new address.
  useEffect(() => {
    if (port !== null) setWindowTitle(windowId, `Port ${port}`);
  }, [port, setWindowTitle, windowId]);

  if (url === null) {
    return (
      <div className="flex h-full flex-col bg-surface-800">
        <EmptyState
          title="No preview address"
          description="This window was opened without one. Open a port from the Ports app instead."
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-surface-800">
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-2 py-1.5">
        <Button
          size="sm"
          variant="ghost"
          icon={<RotateCw size={13} aria-hidden="true" />}
          onClick={() => setGeneration((current) => current + 1)}
        >
          Reload
        </Button>

        <Button
          size="sm"
          variant="ghost"
          icon={<ExternalLink size={12} aria-hidden="true" />}
          onClick={() => window.open(url, '_blank', 'noopener')}
        >
          Open in a tab
        </Button>

        <div className="flex-1" />

        <span className="truncate font-mono text-[11px] text-slate-500">{url}</span>
      </div>

      <div className="min-h-0 flex-1 bg-white">
        {/*
          `allow-same-origin` is kept deliberately. Dropping it would give the
          framed app an opaque origin, which breaks localStorage, cookies and
          anything else a single-page app expects — and it would buy nothing,
          because the frame is already a different origin from this desktop and
          so cannot reach into it either way. `allow-top-navigation` is not
          granted: the framed page must not be able to navigate the desktop away.
        */}
        <iframe
          key={generation}
          src={url}
          title={port === null ? 'Port preview' : `Preview of port ${port}`}
          className="h-full w-full border-0"
          referrerPolicy="no-referrer"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
        />
      </div>
    </div>
  );
}

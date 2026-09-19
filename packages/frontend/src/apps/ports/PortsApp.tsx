import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, RotateCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import { Banner, EmptyState, ErrorState, LoadingState } from '../../components/ui/Feedback.js';
import { useFsScope } from '../../lib/fs-scope.js';
import { closePreview, fetchPorts, openPreview } from '../../lib/ports-api.js';
import { queryKeys } from '../../lib/query-client.js';
import { useDesktopStore } from '../../stores/desktop.store.js';
import { isHostScope } from '../files/files-api.js';

import type { AppProps } from '../registry.js';
import type { PortPreview } from '@aether/shared';

/**
 * Ports — the servers running on the host, and the way one becomes a window.
 *
 * This is the missing half of "start a project in the terminal". A dev server
 * binds to loopback by default, which means it is reachable from the machine and
 * from nowhere else; a browser pointed at the VPS cannot see it at all. The host
 * agent can, so it opens the connection and the backend relays it, and the result
 * is addressed like any other site.
 *
 * A port is only ever reached through the host agent, so this app is host-only
 * and says so rather than quietly listing an empty table when no agent is paired.
 */

const REFRESH_MS = 5_000;

export function PortsApp({ windowId, props }: AppProps) {
  const queryClient = useQueryClient();
  const setWindowTitle = useDesktopStore((state) => state.setWindowTitle);
  const openWindow = useDesktopStore((state) => state.openWindow);

  const scope = useFsScope(props);
  const { fs, setFs, connectedAgents } = scope;

  const [actionError, setActionError] = useState<string | null>(null);
  const [busyPort, setBusyPort] = useState<number | null>(null);

  /**
   * The agent to ask. The settled scope is a host agent by default, but a
   * workspace scope is a legitimate answer when nothing is paired — in which
   * case there is nothing to ask and the empty state explains why.
   */
  const agentId = isHostScope(fs) ? fs.agentId : (connectedAgents[0]?.agentId ?? null);

  const ports = useQuery({
    queryKey: queryKeys.ports(agentId ?? 'none'),
    queryFn: () => fetchPorts(agentId ?? ''),
    enabled: agentId !== null,
    refetchInterval: REFRESH_MS,
  });

  // Keyed by agent as well as port: the list answers with every preview this
  // user holds, on any host, and 3000 on one machine is not 3000 on another.
  const previewsByPort = useMemo(() => {
    const map = new Map<string, PortPreview>();
    for (const preview of ports.data?.previews ?? []) {
      map.set(`${preview.agentId}:${preview.port}`, preview);
    }
    return map;
  }, [ports.data?.previews]);

  const openMutation = useMutation({
    mutationFn: (port: number) => openPreview(agentId ?? '', port),
    onSuccess: (preview) => {
      setActionError(null);
      setBusyPort(null);
      void queryClient.invalidateQueries({ queryKey: ['ports'] });
      openPreviewWindow(preview);
    },
    onError: (error: unknown) => {
      setActionError(describe(error));
      setBusyPort(null);
    },
  });

  const closeMutation = useMutation({
    mutationFn: (port: number) => closePreview(agentId ?? '', port),
    onSuccess: () => {
      setActionError(null);
      setBusyPort(null);
      void queryClient.invalidateQueries({ queryKey: ['ports'] });
    },
    onError: (error: unknown) => {
      setActionError(describe(error));
      setBusyPort(null);
    },
  });

  const rows = ports.data?.ports ?? [];
  const openHere = (ports.data?.previews ?? []).filter((preview) => preview.agentId === agentId);
  const openCount = openHere.length;

  useEffect(() => {
    setWindowTitle(
      windowId,
      rows.length === 0 ? 'Ports' : `Ports — ${rows.length} listening, ${openCount} open`
    );
  }, [rows.length, openCount, setWindowTitle, windowId]);

  /** Opens the previewed page in a window of its own. */
  function openPreviewWindow(preview: PortPreview): void {
    openWindow('port-preview', {
      title: `Port ${preview.port}`,
      // The preview's own agent, not the one on screen: the window reloads the
      // URL in the props, and the two only differ if the user switches host
      // between opening the preview and opening its window.
      props: { port: preview.port, url: preview.url, agentId: preview.agentId },
      width: 1024,
      height: 700,
      singleton: false,
    });
  }

  if (agentId === null) {
    return (
      <div className="flex h-full flex-col bg-surface-800">
        <EmptyState
          title="No host agent is connected"
          description="Ports belong to the machine itself, so they can only be listed through a host agent. Pair one from Settings and it will appear here."
        />
      </div>
    );
  }

  const preview = ports.data?.preview;
  const forwardEnabled = ports.data?.forwardEnabled ?? true;

  return (
    <div className="flex h-full flex-col bg-surface-800">
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-2 py-1.5">
        <select
          value={agentId}
          onChange={(event) => {
            setFs({ scope: 'host', agentId: event.target.value });
          }}
          title="Which host to list"
          aria-label="Select host"
          className="h-7 rounded border border-white/10 bg-surface-800 px-2 text-xs text-slate-100 focus:border-accent focus:outline-none"
        >
          {connectedAgents.map((agent) => (
            <option key={agent.agentId} value={agent.agentId}>
              {agent.label} (host)
            </option>
          ))}
        </select>

        <Button
          size="sm"
          variant="ghost"
          icon={<RotateCw size={13} aria-hidden="true" />}
          onClick={() => void ports.refetch()}
          loading={ports.isFetching && !ports.isPending}
        >
          Refresh
        </Button>

        <div className="flex-1" />

        <span className="text-[11px] text-slate-500">
          {ports.data === undefined
            ? ''
            : `${rows.length} listening · ${openCount} open to the desktop`}
        </span>
      </div>

      {ports.data !== undefined && !forwardEnabled ? (
        <div className="px-2 pt-2">
          <Banner tone="warning">
            This host agent does not open connections to ports. Set{' '}
            <code className="font-mono">PORT_FORWARD_ENABLED=true</code> in its configuration and
            restart it — without that, a port can be listed here but never opened.
          </Banner>
        </div>
      ) : null}

      {preview !== undefined && !preview.enabled ? (
        <div className="px-2 pt-2">
          <Banner tone="warning">
            {preview.reason ??
              'Previews are switched off on this instance, so a port cannot be opened in the desktop.'}
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

      <div className="min-h-0 flex-1 overflow-auto">
        {ports.isPending ? (
          <LoadingState label="Ask the host what it is listening on…" />
        ) : ports.isError ? (
          <ErrorState error={ports.error} onRetry={() => void ports.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="Nothing is listening"
            description="No process on this host has an open listening socket. Start a server in the Terminal — npm run dev, python -m http.server, anything — and it will appear here."
          />
        ) : (
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 bg-surface-900/95 text-left text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-2 py-1.5 font-medium">Port</th>
                <th className="px-2 py-1.5 font-medium">Bound to</th>
                <th className="px-2 py-1.5 font-medium">Process</th>
                <th className="px-2 py-1.5 font-medium">PID</th>
                <th className="px-2 py-1.5 font-medium">Command</th>
                <th className="px-2 py-1.5 font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const open = previewsByPort.get(`${agentId}:${row.port}`);
                const busy = busyPort === row.port;

                return (
                  <tr
                    key={`${row.family}:${row.address}:${row.port}`}
                    className="border-t border-white/5 hover:bg-white/5"
                  >
                    <td className="px-2 py-1 font-mono text-slate-200">{row.port}</td>
                    <td className="px-2 py-1">
                      <span className="font-mono text-slate-400">
                        {row.address}
                        {row.family === 'ipv6' ? ' (v6)' : ''}
                      </span>
                      {row.loopbackOnly ? (
                        <span
                          className="ml-1.5 rounded bg-white/5 px-1 py-0.5 text-[10px] uppercase tracking-wide text-slate-500"
                          title="Only reachable from this machine. Aether can open it because the agent runs there too; nothing outside the host can."
                        >
                          loopback
                        </span>
                      ) : null}
                    </td>
                    <td className="px-2 py-1 text-slate-300">{row.process ?? '—'}</td>
                    <td className="px-2 py-1 font-mono text-slate-500">{row.pid ?? '—'}</td>
                    <td
                      className="max-w-0 truncate px-2 py-1 font-mono text-slate-400"
                      title={row.command ?? ''}
                    >
                      {row.command ?? '—'}
                    </td>
                    <td className="px-2 py-1">
                      <div className="flex items-center gap-1">
                        {open === undefined ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={!forwardEnabled || preview?.enabled === false}
                            loading={busy && openMutation.isPending}
                            onClick={() => {
                              setBusyPort(row.port);
                              openMutation.mutate(row.port);
                            }}
                          >
                            Preview
                          </Button>
                        ) : (
                          <>
                            <Button
                              size="sm"
                              variant="primary"
                              onClick={() => openPreviewWindow(open)}
                            >
                              Open
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              icon={<ExternalLink size={12} aria-hidden="true" />}
                              title={`${open.origin} — open in this browser's own tab`}
                              onClick={() => window.open(open.url, '_blank', 'noopener')}
                            >
                              Tab
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-red-300 hover:bg-red-950/50"
                              loading={busy && closeMutation.isPending}
                              onClick={() => {
                                setBusyPort(row.port);
                                closeMutation.mutate(row.port);
                              }}
                            >
                              Stop
                            </Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="flex items-center justify-between gap-4 border-t border-white/10 px-3 py-1 text-[11px] text-slate-500">
        <span>
          {ports.data?.truncated === true
            ? 'More sockets are listening than are shown.'
            : 'Sockets read from the host kernel through the agent.'}
        </span>
        <span className="truncate">
          {openCount > 0 && preview !== undefined && preview.enabled
            ? `Previews are served from ${preview.origins.join(', ')}`
            : ''}
        </span>
      </div>
    </div>
  );
}

/** A server's refusal in its own words; a transport failure has none to give. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'The request failed.';
}

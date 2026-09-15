import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import { Dialog } from '../../components/ui/Dialog.js';
import { Banner, EmptyState, ErrorState, LoadingState } from '../../components/ui/Feedback.js';
import { Select, TextInput } from '../../components/ui/Input.js';
import { formatBytes, formatPercent, formatRelative } from '../../lib/format.js';
import { queryKeys } from '../../lib/query-client.js';
import {
  fetchProcesses,
  signalProcess,
  type ProcessSignal,
  type ProcessSort,
} from '../../lib/system-api.js';
import { useDesktopStore } from '../../stores/desktop.store.js';

import type { AppProps } from '../registry.js';
import type { ProcessInfo } from '@aether/shared';

/**
 * Task Manager — the host's process table.
 *
 * Every row's action button is rendered from the server's `signalable` flag,
 * never from a client-side guess about which pids are safe. The server refuses
 * pid 1, its own process, and its own ancestors regardless of what the client
 * sends, so this table cannot be used to take the host down.
 *
 * Signalling is opt-in and off by default (`AETHER_PROCESS_SIGNAL_ENABLED`);
 * when it is off the table is read-only and says so.
 */

const REFRESH_MS = 4_000;

const SIGNALS: ReadonlyArray<{ value: ProcessSignal; label: string }> = [
  { value: 'SIGTERM', label: 'Terminate (SIGTERM)' },
  { value: 'SIGINT', label: 'Interrupt (SIGINT)' },
  { value: 'SIGHUP', label: 'Hang up (SIGHUP)' },
  { value: 'SIGKILL', label: 'Force kill (SIGKILL)' },
];

const ROW_LIMIT = 200;

export function TaskManagerApp({ windowId }: AppProps) {
  const queryClient = useQueryClient();
  const setWindowTitle = useDesktopStore((state) => state.setWindowTitle);

  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<ProcessSort>('memory');
  const [pendingKill, setPendingKill] = useState<ProcessInfo | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const processes = useQuery({
    queryKey: queryKeys.processes(search, sortBy),
    queryFn: () => fetchProcesses({ sortBy, search, limit: ROW_LIMIT }),
    refetchInterval: REFRESH_MS,
  });

  const killMutation = useMutation({
    mutationFn: (params: { pid: number; signal: ProcessSignal }) =>
      signalProcess(params.pid, params.signal),
    onSuccess: () => {
      setActionError(null);
      setPendingKill(null);
      void queryClient.invalidateQueries({ queryKey: ['system', 'processes'] });
    },
    onError: (error: unknown) => {
      // A refusal from the server is the interesting case, so it is shown
      // verbatim instead of being reduced to "failed".
      setActionError(error instanceof Error ? error.message : 'The signal was not delivered.');
      setPendingKill(null);
    },
  });

  const rows = processes.data?.processes ?? [];

  useEffect(() => {
    const count = processes.data?.total;
    setWindowTitle(
      windowId,
      count === undefined ? 'Task Manager' : `Task Manager — ${count} processes`
    );
  }, [processes.data?.total, setWindowTitle, windowId]);

  /** Total resident memory of the visible rows, not of the machine. */
  const visibleMemory = useMemo(() => rows.reduce((sum, row) => sum + row.memoryBytes, 0), [rows]);

  const signalEnabled = processes.data?.signalEnabled ?? false;

  return (
    <div className="flex h-full flex-col bg-surface-800">
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-2 py-1.5">
        <TextInput
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Filter by name or exact pid"
          className="h-7 w-56 text-xs"
          aria-label="Filter processes"
        />

        <Select
          value={sortBy}
          onChange={(event) => setSortBy(event.target.value as ProcessSort)}
          className="h-7 text-xs"
          aria-label="Sort processes"
        >
          <option value="memory">Sort: memory</option>
          <option value="pid">Sort: pid</option>
          <option value="name">Sort: name</option>
        </Select>

        <Button
          size="sm"
          variant="ghost"
          onClick={() => void processes.refetch()}
          loading={processes.isFetching && !processes.isPending}
        >
          Refresh
        </Button>

        <div className="flex-1" />

        <span className="text-[11px] text-slate-500">
          {processes.data === undefined
            ? ''
            : `${rows.length} of ${processes.data.total} shown · ${processes.data.running} running · refreshing every ${
                REFRESH_MS / 1000
              }s`}
        </span>
      </div>

      {!signalEnabled && !processes.isPending ? (
        <div className="px-2 pt-2">
          <Banner tone="info">
            Sending signals is disabled on this instance. Set{' '}
            <code className="font-mono">AETHER_PROCESS_SIGNAL_ENABLED=true</code> on the server to
            allow it.
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
        {processes.isPending ? (
          <LoadingState label="Reading the process table…" />
        ) : processes.isError ? (
          <ErrorState error={processes.error} onRetry={() => void processes.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No processes match"
            description={
              search === ''
                ? 'The host reported no processes. On a non-Linux host the process table is unavailable.'
                : 'Try a shorter filter.'
            }
          />
        ) : (
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 bg-surface-900/95 text-left text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-2 py-1.5 font-medium">PID</th>
                <th className="px-2 py-1.5 font-medium">User</th>
                <th className="px-2 py-1.5 font-medium">State</th>
                <th className="px-2 py-1.5 font-medium">CPU</th>
                <th className="px-2 py-1.5 text-right font-medium">Memory</th>
                <th className="px-2 py-1.5 font-medium">Started</th>
                <th className="px-2 py-1.5 font-medium">Command</th>
                <th className="px-2 py-1.5 font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.pid} className="border-t border-white/5 hover:bg-white/5">
                  <td className="px-2 py-1 font-mono text-slate-300">{row.pid}</td>
                  <td className="px-2 py-1 text-slate-400">{row.user}</td>
                  <td className="px-2 py-1">
                    <span
                      className={row.state === 'R' ? 'text-emerald-400' : 'text-slate-400'}
                      title={stateDescription(row.state)}
                    >
                      {row.state}
                    </span>
                  </td>
                  <td className="px-2 py-1 text-slate-400">{formatPercent(row.cpuPercent)}</td>
                  <td className="px-2 py-1 text-right text-slate-300">
                    {formatBytes(row.memoryBytes, 0)}
                  </td>
                  <td className="px-2 py-1 text-slate-500">
                    {row.startedAt === null ? '—' : formatRelative(row.startedAt)}
                  </td>
                  <td
                    className="max-w-0 truncate px-2 py-1 font-mono text-slate-400"
                    title={row.command}
                  >
                    {row.command}
                  </td>
                  <td className="px-2 py-1">
                    {row.signalable ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-red-300 hover:bg-red-950/50"
                        onClick={() => setPendingKill(row)}
                      >
                        End
                      </Button>
                    ) : (
                      <span className="text-[11px] text-slate-600">
                        {signalEnabled ? 'protected' : '—'}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-white/10 px-3 py-1 text-[11px] text-slate-500">
        <span>
          {processes.data?.truncated === true
            ? `Showing the first ${ROW_LIMIT} processes; refine the filter to see the rest.`
            : 'Whole process table shown.'}
        </span>
        <span>{rows.length > 0 ? `${formatBytes(visibleMemory, 0)} resident in view` : ''}</span>
      </div>

      <Dialog
        open={pendingKill !== null}
        onClose={() => {
          if (!killMutation.isPending) setPendingKill(null);
        }}
        title={`Signal process ${pendingKill?.pid ?? ''}`}
        description="Pick the signal to send. The server re-checks every request and will refuse pids it protects."
        width="sm"
        footer={
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={killMutation.isPending}
              onClick={() => setPendingKill(null)}
            >
              Cancel
            </Button>

            {SIGNALS.map((signal) => (
              <Button
                key={signal.value}
                size="sm"
                variant={
                  signal.value === 'SIGKILL'
                    ? 'danger'
                    : signal.value === 'SIGTERM'
                      ? 'primary'
                      : 'secondary'
                }
                title={signal.label}
                loading={killMutation.isPending}
                onClick={() => {
                  if (pendingKill !== null) {
                    killMutation.mutate({ pid: pendingKill.pid, signal: signal.value });
                  }
                }}
              >
                {signal.value.replace('SIG', '')}
              </Button>
            ))}
          </>
        }
      >
        <div className="flex flex-col gap-2 text-sm text-slate-300">
          <p className="max-w-full break-all font-mono text-xs text-slate-400">
            {pendingKill?.command}
          </p>
          <p className="text-xs text-slate-400">
            SIGTERM asks the process to exit cleanly and is the right first choice. SIGKILL cannot
            be caught: the process gets no chance to save state or release locks.
          </p>
        </div>
      </Dialog>
    </div>
  );
}

/** Single-letter `state` from `/proc/<pid>/stat` expanded for the tooltip. */
function stateDescription(state: string): string {
  const descriptions: Record<string, string> = {
    R: 'Running',
    S: 'Sleeping',
    D: 'Uninterruptible sleep',
    Z: 'Zombie',
    T: 'Stopped',
    I: 'Idle kernel thread',
  };
  return descriptions[state] ?? state;
}

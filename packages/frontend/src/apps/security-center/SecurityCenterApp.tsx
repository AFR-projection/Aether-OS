import { AUDIT_ACTIONS, type AuditEvent } from '@aether/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import { Banner, EmptyState, ErrorState, LoadingState } from '../../components/ui/Feedback.js';
import { Select, TextInput } from '../../components/ui/Input.js';
import { formatRelative, formatTimestamp } from '../../lib/format.js';
import { queryKeys } from '../../lib/query-client.js';
import { fetchAuditEvents } from '../../lib/system-api.js';
import { useDesktopStore } from '../../stores/desktop.store.js';

import type { AppProps } from '../registry.js';

/**
 * Security Center — the audit log.
 *
 * This view exists so an operator can answer "who did that, from where, and did
 * it work?" without shelling into the database. The audit table is
 * append-only: nothing here edits or deletes an entry, and the backend exposes
 * no endpoint that could.
 *
 * The filter is applied server-side. Filtering a single page in the browser
 * would quietly hide older matching events, which is worse than showing none.
 */

const PAGE_SIZE = 200;
const REFRESH_MS = 10_000;

export function SecurityCenterApp({ windowId }: AppProps) {
  const setWindowTitle = useDesktopStore((state) => state.setWindowTitle);

  const [action, setAction] = useState('');
  const [actorFilter, setActorFilter] = useState('');
  const [selected, setSelected] = useState<AuditEvent | null>(null);

  const events = useQuery({
    queryKey: queryKeys.audit(action === '' ? undefined : action, PAGE_SIZE),
    queryFn: () => fetchAuditEvents({ limit: PAGE_SIZE, ...(action !== '' ? { action } : {}) }),
    refetchInterval: REFRESH_MS,
  });

  useEffect(() => {
    setWindowTitle(windowId, 'Security Center');
  }, [setWindowTitle, windowId]);

  const all = events.data?.events ?? [];

  // Filtering by actor is done here because the API has no actor-username
  // filter; the label says so rather than implying a server-side search.
  const rows =
    actorFilter === ''
      ? all
      : all.filter((event) =>
          (event.actorUsername ?? '').toLowerCase().includes(actorFilter.toLowerCase())
        );

  const failures = all.filter((event) => event.outcome === 'failure').length;

  return (
    <div className="flex h-full flex-col bg-surface-800">
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-2 py-1.5">
        <TextInput
          value={actorFilter}
          onChange={(event) => setActorFilter(event.target.value)}
          placeholder="Filter by actor (this page)"
          className="h-7 w-52 text-xs"
          aria-label="Filter audit events by actor"
        />

        <Select
          value={action}
          onChange={(event) => setAction(event.target.value)}
          className="h-7 text-xs"
          aria-label="Filter audit events by action"
        >
          <option value="">All actions</option>
          {AUDIT_ACTIONS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </Select>

        <Button
          size="sm"
          variant="ghost"
          onClick={() => void events.refetch()}
          loading={events.isFetching}
        >
          Refresh
        </Button>

        <div className="flex-1" />

        <span className="text-[11px] text-slate-500">
          {all.length} newest events
          {failures > 0 ? ` · ${failures} failed` : ''}
        </span>
      </div>

      <div className="px-2 pt-2">
        <Banner tone="info">
          Showing the {PAGE_SIZE} most recent entries. Filtering by actor applies to the page in
          view; use the action filter to narrow the server-side query.
        </Banner>
      </div>

      <div className="mt-2 min-h-0 flex-1 overflow-auto">
        {events.isPending ? (
          <LoadingState label="Reading the audit log…" />
        ) : events.isError ? (
          <ErrorState error={events.error} onRetry={() => void events.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No audit events"
            description={
              action !== ''
                ? 'Nothing has been recorded for this action yet.'
                : 'Nothing has been recorded yet.'
            }
          />
        ) : (
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 bg-surface-900/95 text-left text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-2 py-1.5 font-medium">When</th>
                <th className="px-2 py-1.5 font-medium">Action</th>
                <th className="px-2 py-1.5 font-medium">Outcome</th>
                <th className="px-2 py-1.5 font-medium">Actor</th>
                <th className="px-2 py-1.5 font-medium">Source</th>
                <th className="px-2 py-1.5 font-medium">Target</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((event) => (
                <tr
                  key={event.id}
                  onClick={() => setSelected(event)}
                  className="cursor-pointer border-t border-white/5 hover:bg-white/5"
                >
                  <td
                    className="whitespace-nowrap px-2 py-1 text-slate-400"
                    title={formatTimestamp(event.at)}
                  >
                    {formatRelative(event.at)}
                  </td>
                  <td className="px-2 py-1 font-mono text-slate-300">{event.action}</td>
                  <td className="px-2 py-1">
                    <span
                      className={event.outcome === 'success' ? 'text-emerald-400' : 'text-red-400'}
                    >
                      {event.outcome}
                    </span>
                  </td>
                  <td className="px-2 py-1 text-slate-300">{event.actorUsername ?? '—'}</td>
                  <td className="px-2 py-1 font-mono text-slate-500">{event.ipAddress ?? '—'}</td>
                  <td
                    className="max-w-0 truncate px-2 py-1 font-mono text-slate-500"
                    title={event.target ?? ''}
                  >
                    {event.target ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Detail is shown inline rather than in a dialog so an operator can read
          two entries side by side by scrolling. */}
      {selected !== null ? (
        <div className="max-h-56 shrink-0 overflow-auto border-t border-white/10 bg-surface-900/60 p-3">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-300">
              {selected.action} · {selected.outcome}
            </h2>
            <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>
              Close
            </Button>
          </div>

          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
            <Detail label="Timestamp" value={formatTimestamp(selected.at)} />
            <Detail label="Event id" value={selected.id} />
            <Detail label="Actor" value={selected.actorUsername ?? '—'} />
            <Detail label="Actor user id" value={selected.actorUserId ?? '—'} />
            <Detail label="Session" value={selected.sessionId ?? '—'} />
            <Detail label="Source IP" value={selected.ipAddress ?? '—'} />
            <Detail label="Target" value={selected.target ?? '—'} />
            <Detail label="User agent" value={selected.userAgent ?? '—'} />
          </dl>

          <div className="mt-2">
            <p className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">Metadata</p>
            <pre className="overflow-auto rounded border border-white/10 bg-surface-900 p-2 font-mono text-[11px] text-slate-300">
              {selected.metadata === null ? 'none' : JSON.stringify(selected.metadata, null, 2)}
            </pre>
            <p className="mt-1 text-[10px] text-slate-500">
              Metadata is written by the server and holds no credentials or tokens.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-white/5 py-1">
      <dt className="shrink-0 text-slate-500">{label}</dt>
      <dd className="truncate text-right font-mono text-slate-300" title={value}>
        {value}
      </dd>
    </div>
  );
}

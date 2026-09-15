import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { Button } from '../../components/ui/Button.js';
import { EmptyState, ErrorState, LoadingState, UsageBar } from '../../components/ui/Feedback.js';
import { formatBytes, formatPercent, formatUptime } from '../../lib/format.js';
import { queryKeys } from '../../lib/query-client.js';
import { fetchSystemInfo } from '../../lib/system-api.js';
import { useDesktopStore } from '../../stores/desktop.store.js';

import type { AppProps } from '../registry.js';

/**
 * System Monitor — host facts and live resource usage.
 *
 * The CPU series is built from the polls this window has actually made, so the
 * graph shows real samples rather than a smoothed or invented curve. Polling
 * stops when the window is not mounted, which is when the user has closed it —
 * this app is deliberately a singleton, so there is at most one poller.
 */

const REFRESH_MS = 3_000;
const HISTORY_POINTS = 60;

export function SystemMonitorApp({ windowId }: AppProps) {
  const setWindowTitle = useDesktopStore((state) => state.setWindowTitle);

  const [cpuHistory, setCpuHistory] = useState<number[]>([]);
  const [memoryHistory, setMemoryHistory] = useState<number[]>([]);

  const info = useQuery({
    queryKey: queryKeys.systemInfo,
    queryFn: fetchSystemInfo,
    refetchInterval: REFRESH_MS,
  });

  const cpuPercent = info.data?.cpu.usagePercent;
  const memoryPercent = info.data?.memory.usagePercent;

  useEffect(() => {
    if (cpuPercent === undefined || memoryPercent === undefined) return;

    setCpuHistory((previous) => [...previous, cpuPercent].slice(-HISTORY_POINTS));
    setMemoryHistory((previous) => [...previous, memoryPercent].slice(-HISTORY_POINTS));
  }, [cpuPercent, memoryPercent]);

  useEffect(() => {
    setWindowTitle(
      windowId,
      info.data === undefined ? 'System Monitor' : `System Monitor — ${info.data.hostname}`
    );
  }, [info.data, setWindowTitle, windowId]);

  if (info.isPending) return <LoadingState label="Reading host metrics…" />;
  if (info.isError) {
    return <ErrorState error={info.error} onRetry={() => void info.refetch()} />;
  }

  const system = info.data;

  return (
    <div className="flex h-full flex-col bg-surface-800">
      <div className="flex items-center gap-2 border-b border-white/10 px-2 py-1.5">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void info.refetch()}
          loading={info.isFetching}
        >
          Refresh
        </Button>
        <div className="flex-1" />
        <span className="text-[11px] text-slate-500">
          Sampling every {REFRESH_MS / 1000}s · up {formatUptime(system.uptimeSeconds)}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <Panel title="CPU" subtitle={system.cpu.model}>
            <UsageBar
              percent={system.cpu.usagePercent}
              label={`${formatPercent(system.cpu.usagePercent)} across ${system.cpu.cores} cores`}
            />
            <Sparkline values={cpuHistory} label="CPU history since this window opened" />
            <dl className="mt-2 grid grid-cols-3 gap-2 text-[11px] text-slate-400">
              <Stat label="1 min" value={system.cpu.loadAverage[0].toFixed(2)} />
              <Stat label="5 min" value={system.cpu.loadAverage[1].toFixed(2)} />
              <Stat label="15 min" value={system.cpu.loadAverage[2].toFixed(2)} />
            </dl>
          </Panel>

          <Panel
            title="Memory"
            subtitle={`${formatBytes(system.memory.usedBytes, 0)} of ${formatBytes(system.memory.totalBytes, 0)}`}
          >
            <UsageBar
              percent={system.memory.usagePercent}
              label={formatPercent(system.memory.usagePercent)}
            />
            <Sparkline values={memoryHistory} label="Memory history since this window opened" />
            <dl className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-slate-400">
              <Stat label="Used" value={formatBytes(system.memory.usedBytes, 0)} />
              <Stat label="Available" value={formatBytes(system.memory.freeBytes, 0)} />
            </dl>
          </Panel>
        </div>

        <Panel title="Disks" className="mt-3">
          {system.disks.length === 0 ? (
            <EmptyState
              title="No filesystem readings"
              description="The workspace and root filesystems could not be measured on this host."
            />
          ) : (
            <div className="flex flex-col gap-3">
              {system.disks.map((disk) => (
                <div key={`${disk.filesystem}:${disk.mountPoint}`}>
                  <UsageBar
                    percent={disk.usagePercent}
                    label={`${disk.mountPoint} — ${formatBytes(disk.usedBytes, 0)} of ${formatBytes(disk.totalBytes, 0)}`}
                  />
                  <p className="mt-1 text-[11px] text-slate-500">
                    {formatBytes(disk.freeBytes, 0)} free
                  </p>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Network interfaces" className="mt-3">
          {system.network.length === 0 ? (
            <p className="text-xs text-slate-500">No interfaces reported.</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-left text-[11px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-1 font-medium">Interface</th>
                  <th className="py-1 font-medium">Address</th>
                  <th className="py-1 font-medium">Family</th>
                  <th className="py-1 font-medium">MAC</th>
                </tr>
              </thead>
              <tbody>
                {system.network.map((entry) => (
                  <tr key={`${entry.name}:${entry.address}`} className="border-t border-white/5">
                    <td className="py-1 text-slate-300">{entry.name}</td>
                    <td className="py-1 font-mono text-slate-300">{entry.address}</td>
                    <td className="py-1 text-slate-400">
                      {entry.family}
                      {entry.internal ? (
                        <span className="ml-1 text-slate-600">(internal)</span>
                      ) : null}
                    </td>
                    <td className="py-1 font-mono text-slate-500">
                      {entry.mac === '00:00:00:00:00:00' ? '—' : entry.mac}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="Host" className="mt-3">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
            <Row label="Hostname" value={system.hostname} />
            <Row label="Distribution" value={`${system.distro} (${system.release})`} />
            <Row label="Kernel" value={system.kernel} />
            <Row label="Architecture" value={system.arch} />
            <Row label="Booted" value={new Date(system.bootTime).toLocaleString()} />
            <Row label="Node.js" value={system.nodeVersion} />
            <Row label="Aether" value={system.aetherVersion} />
            <Row label="Instance" value={system.instanceId} />
            <Row
              label="Backend uptime"
              value={formatUptime(Math.floor(system.processUptimeMs / 1000))}
            />
          </dl>
        </Panel>
      </div>
    </div>
  );
}

function Panel({
  title,
  subtitle,
  children,
  className = '',
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-lg border border-white/10 bg-surface-900/40 p-3 ${className}`}>
      <header className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-300">{title}</h2>
        {subtitle !== undefined ? (
          <span className="truncate text-[11px] text-slate-500" title={subtitle}>
            {subtitle}
          </span>
        ) : null}
      </header>
      {children}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-slate-300">{value}</dd>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-white/5 py-1">
      <dt className="text-slate-500">{label}</dt>
      <dd className="truncate text-right text-slate-300" title={value}>
        {value}
      </dd>
    </div>
  );
}

/**
 * A minimal sparkline drawn as an SVG polyline.
 *
 * No charting dependency: the shape is a straight reading of the samples, and
 * the axis is fixed at 0-100% so two windows opened at different times are
 * still comparable.
 */
function Sparkline({ values, label }: { values: number[]; label: string }) {
  const path = useMemo(() => {
    if (values.length < 2) return '';

    const step = 100 / (HISTORY_POINTS - 1);
    const points = values.map((value, index) => {
      const x = index * step;
      const y = 30 - (Math.max(0, Math.min(100, value)) / 100) * 30;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    });

    // Anchor the series to the right edge so a new reading appears at the right,
    // the way every other monitor draws a live trace.
    const offset = (HISTORY_POINTS - values.length) * step;
    return points
      .map((point) => {
        const [x, y] = point.split(',');
        return `${(Number(x) + offset).toFixed(2)},${y}`;
      })
      .join(' ');
  }, [values]);

  if (path === '') {
    return (
      <div className="mt-2 flex h-[30px] items-center text-[11px] text-slate-600">
        Collecting samples…
      </div>
    );
  }

  return (
    <svg
      className="mt-2 h-[30px] w-full"
      viewBox="0 0 100 30"
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      <polyline
        points={path}
        fill="none"
        stroke="currentColor"
        strokeWidth="0.6"
        vectorEffect="non-scaling-stroke"
        className="text-accent"
      />
    </svg>
  );
}

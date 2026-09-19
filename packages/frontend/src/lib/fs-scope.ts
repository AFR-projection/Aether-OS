/**
 * Which filesystem a window is working on.
 *
 * There are two, and they are not interchangeable. *Workspace* is a directory
 * inside the backend container: it is fast, it is sandboxed, and it disappears
 * when the stack is rebuilt. *Host* is the machine the host agent runs on — the
 * real VPS — reached over RPC, and it is where the shell, `apt`, `git`,
 * `docker` and the `aether` CLI actually live.
 *
 * The desktop exists to manage the real machine, so host scope is the default:
 * a window with no explicit scope settles on the first connected host agent once
 * the agent list arrives. Falling back to workspace scope silently was worse
 * than useless — it produced a shell inside the backend container, where
 * `aether` is not installed, which reads as the product being broken rather than
 * as the user being in the wrong place.
 *
 * Workspace remains available and remains the fallback when no agent is
 * connected; it is a real scope, just not the interesting one.
 */

import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { fetchAgents } from './agent-api.js';
import { queryKeys } from './query-client.js';
import { isHostScope, type FsScope } from '../apps/files/files-api.js';

import type { HostAgent } from '@aether/shared';

/** The scope to use while no better answer has arrived yet. */
export const WORKSPACE_SCOPE: FsScope = { scope: 'workspace' };

/**
 * Reads the scope an opener asked for, if it named one.
 *
 * Windows opened from Files carry the scope they were opened in, so a file
 * opened from the host tree is edited on the host and not on a same-named path
 * in the container.
 */
export function scopeFromProps(props: Record<string, unknown>): FsScope | undefined {
  if (props.scope === 'host' && typeof props.agentId === 'string' && props.agentId.length > 0) {
    return { scope: 'host', agentId: props.agentId };
  }
  if (props.scope === 'workspace') return { scope: 'workspace' };
  return undefined;
}

export interface FsScopeState {
  /**
   * The settled scope, or `undefined` while the choice is still pending. Callers
   * that can wait should wait: fetching the workspace and then discarding it for
   * the host is a wasted round trip and a visible flicker.
   */
  fs: FsScope | undefined;
  setFs: (scope: FsScope) => void;
  /** Every agent, for the scope picker. */
  agents: HostAgent[];
  /** Agents with a live socket, which are the only ones that can be used. */
  connectedAgents: HostAgent[];
}

/**
 * Resolves the scope for a window.
 *
 * `pinned` opts out of settling: the scope is then whatever the opener named, or
 * the workspace if it named nothing. The Terminal passes it when it is
 * reattaching to a session that already exists, because a shell cannot be moved
 * to another machine after it has started.
 */
export function useFsScope(
  props: Record<string, unknown>,
  options: { pinned?: boolean } = {}
): FsScopeState {
  const [fs, setFs] = useState<FsScope | undefined>(
    () => scopeFromProps(props) ?? (options.pinned === true ? WORKSPACE_SCOPE : undefined)
  );

  const agentsQuery = useQuery({ queryKey: queryKeys.agents, queryFn: fetchAgents });
  const agents = agentsQuery.data ?? [];
  const connectedAgents = useMemo(() => agents.filter((agent) => agent.connected), [agents]);

  useEffect(() => {
    if (fs !== undefined || !agentsQuery.isFetched) return;
    const first = connectedAgents[0];
    setFs(first ? { scope: 'host', agentId: first.agentId } : WORKSPACE_SCOPE);
  }, [fs, agentsQuery.isFetched, connectedAgents]);

  return { fs, setFs, agents, connectedAgents };
}

/** The scope to render with, substituting the workspace while the choice pends. */
export function effectiveScope(state: FsScopeState): FsScope {
  return state.fs ?? WORKSPACE_SCOPE;
}

/** A human label for a scope, for window titles and status bars. */
export function scopeLabel(fs: FsScope, connectedAgents: HostAgent[]): string {
  if (!isHostScope(fs)) return 'Workspace';
  return connectedAgents.find((agent) => agent.agentId === fs.agentId)?.label ?? 'Host agent';
}

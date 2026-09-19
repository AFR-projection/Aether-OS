/**
 * Ports — the servers listening on a host.
 *
 * This is how a project started in the Terminal becomes reachable from the
 * desktop. The backend cannot find that out alone: it runs in a container, so a
 * dev server bound to `127.0.0.1` on the machine — the default for most
 * frameworks — is not on any network the container can reach. The host agent
 * runs on the machine itself, so it can both report what is listening and open a
 * connection to it.
 */

/** One listening socket, joined to the process that owns it. */
export interface ListeningPort {
  port: number;
  /**
   * The address the socket is bound to, as the kernel reports it: `0.0.0.0` for
   * every interface, `127.0.0.1` or `::1` for loopback only.
   */
  address: string;
  family: 'ipv4' | 'ipv6';
  /** Owning process, when it could be resolved. */
  pid: number | null;
  /** Process name from `/proc/<pid>/status`. */
  process: string | null;
  /** Full command line, so the UI can name the framework rather than the binary. */
  command: string | null;
  /**
   * True when the socket is bound only to a loopback address.
   *
   * Worth surfacing rather than hiding: such a server is reachable through the
   * agent on the same machine but from nowhere else, and the distinction
   * explains why the same URL works in one place and not another.
   */
  loopbackOnly: boolean;
}

export interface PortListResponse {
  ports: ListeningPort[];
  total: number;
  /** True when more sockets were listening than the returned page. */
  truncated: boolean;
  /** True when this instance permits opening a connection to a port at all. */
  forwardEnabled: boolean;
}

/** What `GET /api/ports` answers: the host's sockets, plus what this instance can do with them. */
export interface PortsResponse extends PortListResponse {
  preview: PreviewCapability;
  /** Ports this user has open in a preview, so the UI can show them as running. */
  previews: PortPreview[];
}

/**
 * A server listening on the host, made reachable from the desktop.
 *
 * A preview is served from its own origin — the same host on a different port
 * (`https://example.com:8443`) — rather than under a path on the desktop's own
 * origin. That choice is what makes a real project work: an app served at `/` of
 * its own origin emits absolute asset URLs that resolve, whereas the same app
 * served under `/ports/5173/` requests `/assets/app.js` from the desktop's own
 * root and comes up blank. It also keeps the previewed app off the desktop's
 * origin, so nothing it runs can read the desktop's stored session.
 */
export interface PortPreview {
  port: number;
  /**
   * The host the previewed port is on.
   *
   * A port number means nothing on its own — `3000` is a different server on
   * every machine — and a user may hold previews on more than one agent, so the
   * agent is part of what identifies a preview. Without it the Ports app cannot
   * tell which host is already showing a port, and would offer to open one that
   * is running on the other.
   */
  agentId: string;
  /** Origin the preview is served from, without a trailing slash. */
  origin: string;
  /** The URL to open. */
  url: string;
  /** When the preview's credential stops being accepted. */
  expiresAt: string;
}

/** How this instance can (or cannot) expose a port. */
export interface PreviewCapability {
  enabled: boolean;
  /**
   * Origins a preview can be served from.
   *
   * Sent to the frontend so the desktop's own content security policy can allow
   * exactly these origins to be framed, and so the Ports app can tell the user
   * where a preview will appear before it opens.
   */
  origins: string[];
  /**
   * What is missing, in one sentence, when previews are unavailable.
   *
   * Null when they work. A preview needs a published port outside the one the
   * desktop is served on, and a host or network firewall that refuses it is the
   * likeliest reason for a failure that looks like the server being down.
   */
  reason: string | null;
}

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

/**
 * How to serve a dev server under a path prefix.
 *
 * A preview opened at `/ports/5173/` is not at `/`, so a server that emits
 * absolute asset URLs (`/assets/app.js`) will not resolve them and the page comes
 * up blank with a console full of 404s. Aether cannot fix that from the outside —
 * the server has to be told its base path. Rather than hide the problem, the
 * Ports app names what to change for the framework it recognised.
 */
export interface PortBasePathHint {
  framework: string;
  /** What to change, in one sentence, safe to show verbatim. */
  guidance: string;
  /** A command that applies it, when the framework takes a flag for it. */
  command?: string;
}

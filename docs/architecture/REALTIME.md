# Realtime protocols

Two WebSocket endpoints, with different authentication because they have different clients.

| Endpoint           | Client         | Authenticates with               | Defined in                          |
| ------------------ | -------------- | -------------------------------- | ----------------------------------- |
| `/ws/terminal/:id` | Browser        | One-time ticket (`?ticket=…`)    | `packages/backend/src/ws/terminal.ws.ts` |
| `/ws/agent`        | Host agent     | Pairing token (`?agentId=&token=`) | `packages/backend/src/ws/agent.ws.ts` |

Both enforce, per connection:

- **200 frames per second.** Generous on purpose — a shell can legitimately produce a burst from a
  paste or a held arrow key. The ceiling exists to stop one runaway client saturating the event
  loop, not to shape normal use.
- **1 MiB per frame** (`LIMITS.WS_MESSAGE_MAX_BYTES`). Exceeding it closes the socket.
- **200 frames per second** applies from the first frame, before any parsing.

---

## Terminal: browser ↔ backend

### Why a ticket and not the access token

A WebSocket handshake from a browser **cannot set an `Authorization` header**. The two usual
workarounds are both bad:

- put the access token in the query string — it then lands in proxy logs, browser history, and
  `Referer` headers;
- put it in the first message after connecting — the socket is already open and unauthenticated.

So the browser first mints a short-lived, single-use **ticket** over authenticated HTTP:

```
POST /api/terminal/sessions/:id/ticket      (permission: terminal:attach)
→ { data: { ticket: "…" } }
```

and redeems it on the socket: `wss://…/ws/terminal/<sessionId>?ticket=<ticket>`.

The ticket is bound to the session id, so a ticket for one terminal cannot be used to attach to
another.

### The ticket is redeemed *after* the handshake

`@fastify/websocket` offers no pre-upgrade hook here, so the handshake completes first and the
ticket is redeemed immediately after. If it fails, the socket is closed with `4001` and **no frame
is ever sent** — an unauthenticated client learns nothing and can write nothing.

### Messages: client → server

```ts
{ type: 'input',  data: string }                                  // keystrokes
{ type: 'resize', cols: number, rows: number }
{ type: 'signal', signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL' }
{ type: 'ping' }
```

Validated by `terminalClientMessageSchema`. A frame that fails validation gets an `error` reply and
is **never forwarded to the PTY**; a frame that is not JSON at all is dropped silently.

### Messages: server → client

```ts
{ type: 'ready',  sessionId: string, pid: number, shell: string, cwd: string }
{ type: 'output', data: string }
{ type: 'exit',   exitCode: number, signal: number | null }
{ type: 'error',  code: string, message: string }
{ type: 'pong',   at: string }
```

On attach the server sends `ready`, then **replays** the output produced before this client
connected, so a page reload rebuilds the screen rather than showing an empty terminal.

The server also sends a `pong` every 30 seconds unsolicited, as a heartbeat — the client does not
have to keep asking whether the socket is alive.

### Detaching does not kill the shell

Closing the socket detaches the client; the PTY keeps running. That is what makes "reload the page
and your session is still there" work. Abandoned sessions are reclaimed by
`TERMINAL_IDLE_TIMEOUT`, not by the socket closing.

### Close codes

| Code   | Name                | Meaning                                            |
| ------ | ------------------- | -------------------------------------------------- |
| `1000` | NORMAL              | Session ended cleanly                               |
| `1003` | UNSUPPORTED_DATA    | Unsupported frame                                   |
| `1008` | POLICY_VIOLATION    | Missing session id, or frame over the size limit    |
| `1011` | INTERNAL_ERROR      | Terminal subsystem unavailable on this host         |
| `4001` | UNAUTHENTICATED     | Missing or invalid ticket                           |
| `4003` | FORBIDDEN           | Authenticated but not permitted                     |
| `4004` | SESSION_NOT_FOUND   | Session does not exist or has already exited        |
| `4029` | RATE_LIMITED        | More than 200 frames in one second                  |

`4000–4999` is the application-defined range; the rest are standard.

---

## Agent: host agent ↔ backend

### Handshake

The agent connects **out** to the backend — no inbound port is opened on the managed host, which
matters when that host is on a network you do not control.

```
GET wss://<backend>/ws/agent?agentId=<uuid>&token=<pairing token>
```

The backend verifies the token against the SHA-256 hash in `aether.host_agents`. The plaintext
token is never stored, so it cannot be re-read from the database.

Then the agent sends a `hello` frame carrying its identity and capability list:

```json
{
  "id": "__hello__",
  "type": "hello",
  "agentId": "…",
  "token": "…",
  "version": "0.1.0",
  "platform": "linux",
  "hostname": "web-01",
  "capabilities": ["system.info", "files.list", "terminal.create", "…"]
}
```

The backend replies `hello_ack` with the owning user, and the agent considers itself paired. The
agent waits **15 seconds** for that acknowledgement; without it, it treats the connection as failed
and retries.

### Request / reply

After `hello_ack`, every exchange is a correlated request:

```json
{ "id": "a-unique-correlation-id", "type": "files.list", "params": { "path": "docs" } }
```

```json
{ "id": "a-unique-correlation-id", "ok": true,  "result": { "…": "…" } }
{ "id": "a-unique-correlation-id", "ok": false, "error": { "code": "…", "message": "…" } }
```

The `id` is echoed so replies can be matched to requests — several may be in flight at once.

### Capabilities

The complete set an agent may advertise and serve:

| Group          | Capabilities                                                    |
| -------------- | ---------------------------------------------------------------- |
| System         | `system.info`                                                     |
| Processes      | `processes.list`, `processes.signal`                              |
| Files          | `files.list`, `files.read`, `files.write`, `files.delete`, `files.mkdir` |
| Terminal       | `terminal.create`, `terminal.input`, `terminal.resize`, `terminal.signal`, `terminal.kill`, `terminal.list` |

This is the **entire** vocabulary. There is no `exec`, no `shell`, no arbitrary command. A
compromised agent cannot be asked to do anything outside this list, and there is nothing on the list
that runs a caller-supplied command line: `terminal.create` spawns a shell from
`TERMINAL_ALLOWED_SHELLS`, and everything else is a named operation with typed parameters.

### Parameter validation

Every capability has a Zod schema in `packages/host-agent/src/protocol.ts`, and
`parseAgentMessage` validates the envelope and the params **before** the request reaches a
capability handler. An unknown `type` is rejected outright.

Path parameters use `relativePathSchema`, and the same workspace sandbox is enforced on the agent
side — the agent does not assume the backend already checked.

### Terminal output streaming

Terminal output is not request/reply; the backend subscribes to a session and the agent streams:

```
backend → agent   { "id": "…", "type": "terminal.subscribe", "params": { "id": "<session>" } }
agent → backend   { "type": "output", "id": "<session>", "data": "…" }
agent → backend   { "type": "exit",   "id": "<session>", "exitCode": 0, "signal": null }
```

### Reconnection

The agent reconnects on its own with backoff and re-sends `hello`. On the backend side,
`agent-connections.ts` **counts sockets per agent** rather than using a boolean. That detail
matters: during a reconnect the old socket may not have fired its `close` event before the new one
opens, so a naive `connected = true/false` would let the dying socket's `close` mark a live agent
offline. Counting means the agent is offline only when its last socket is gone.

This is what `GET /api/agents` reports as `connected` and `connectedAt`.

---

## Rate limiting and the cache

Frame budgets are per-connection and in-process; that is correct at any replica count because a
socket lives on exactly one replica.

WebSocket **tickets** are different — they are stored in the cache, so they are per-process unless
`REDIS_URL` is set. Without Redis, a ticket minted by one replica cannot be redeemed on another. See
[Known limitations](../status/KNOWN-LIMITATIONS.md#3-rate-limiting-is-per-process-unless-redis-is-configured).

Note also that terminal output is **not** fanned out between replicas: a session is owned by the
replica that created it, so sticky sessions at the proxy are still required for terminals in a
multi-replica deployment.

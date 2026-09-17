# Architecture overview

## The shape of the thing

```
   ┌──────────────┐   ┌──────────────────────┐
   │   Browser    │   │  Electron desktop    │
   │  (React SPA) │   │  client (same SPA)   │
   └───────┬──────┘   └──────────┬───────────┘
           │                     │
           └──────────┬──────────┘
                      │  HTTPS  +  WSS
                      ▼
        ┌─────────────────────────────────┐
        │      Backend  (Fastify 4)       │
        │                                 │
        │  routes/     HTTP API           │
        │  ws/         terminal + agent   │
        │  services/   domain logic       │
        │  security/   path + command     │
        │  cache/      memory | redis     │
        └───┬─────────────────────┬───────┘
            │                     │
     ┌──────▼──────┐              │  WSS  /ws/agent
     │ PostgreSQL  │              ▼
     │ (all state) │   ┌──────────────────────┐
     └─────────────┘   │     Host Agent       │
     ┌─────────────┐   │  capabilities/       │
     │   Redis     │   │   terminal (PTY)     │
     │  (optional) │   │   filesystem         │
     └─────────────┘   │   processes          │
                       │   system             │
                       └──────────┬───────────┘
                                  ▼
                          the managed host
```

## The one decision that explains everything else

**The backend never touches the managed host directly.** It does not open `/proc`, it does not spawn
a shell, it does not read a file from disk on the host's behalf. It sends a request over a WebSocket
to a **host agent**, and the agent does the work and returns the result.

That single split is why:

- one backend can manage **several machines** — add an agent per host;
- the backend can run **in a container** (`packages/backend/Dockerfile`) while the agent runs on the
  host it manages, where `/proc` and the user's real filesystem actually are;
- the agent can be given **less privilege** than the backend, and revoked from the UI;
- a compromised backend does not automatically mean code execution on every managed host, because
  the agent independently validates every message it receives (`packages/host-agent/src/router.ts`).

The cost is a protocol to maintain and a connection to keep alive. That is the trade.

## Components

### `packages/shared`

Types, Zod schemas, permission constants, WebSocket close codes, and limits — imported by
everything. Zod schemas are defined **once** here and used by both the backend (to validate
requests) and the frontend (to validate form input), so the two cannot disagree about what a valid
payload is.

### `packages/backend`

| Directory     | Responsibility                                                                                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `routes/`     | HTTP surface. One module per area: auth, files, terminal, system, agents, audit, health.                                                                                     |
| `services/`   | Domain logic, independent of HTTP. `agent-gateway` tracks live agent connections; `agent-pairing` owns the token registry; `files`, `system`, `terminal` dispatch to agents. |
| `ws/`         | Two WebSocket endpoints — `terminal.ws` (browser ↔ backend) and `agent.ws` (agent ↔ backend).                                                                                |
| `security/`   | The sandbox: path canonicalization and the process-signal guard.                                                                                                             |
| `middleware/` | `authenticate` (JWT + session check) and `requirePermission`.                                                                                                                |
| `cache/`      | The `Cache` interface with two implementations, selected at startup.                                                                                                         |
| `db/`         | Connection pool and the forward-only migration runner.                                                                                                                       |

Layering rule: **routes never contain business logic and services never touch `request`/`reply`.** A
route parses and validates input, calls a service, and shapes the response. This is what makes the
services unit-testable without an HTTP server.

### `packages/frontend`

A React SPA: a desktop shell (`desktop/`), a set of first-party apps (`apps/`), auth (`auth/`),
Zustand stores (`stores/`), and the API client (`lib/`).

Apps are React components in a **static registry** (`apps/registry.ts`). There is no dynamic app
loading and no third-party app sandbox — see
[Known limitations](../status/KNOWN-LIMITATIONS.md#9-applications-are-compiled-in--there-is-no-third-party-app-installation).

Each app declares the `requiredPermission` it needs. The launcher hides apps the user cannot use,
**but that is convenience, not access control** — the server enforces the same permission on every
request. Hiding an icon has never stopped anyone from calling an endpoint.

### `packages/host-agent`

Runs on the managed host. Owns `capabilities/`: `terminal` (PTY via `node-pty`), `filesystem`,
`processes`, `system`. Connects out to the backend over `/ws/agent` and authenticates with a pairing
token. It reaches _out_ rather than the backend reaching _in_, which means no inbound port has to be
opened on the managed host — worth a great deal when that host is on someone else's network.

### `packages/desktop-client`

An Electron wrapper around the same frontend bundle. It adds no server-side behaviour.

---

## Request flows

### An HTTP API call

```
Browser
  └─ GET /api/files/list?path=docs
       │  Authorization: Bearer <access token>
       ▼
  middleware/authenticate      verifies JWT signature + expiry
       │                       then checks the session row is not revoked
       ▼
  middleware/requirePermission('files:read')
       │
       ▼
  routes/files.routes.ts       validates query with a Zod schema
       ▼
  services/files.service.ts    resolves the path, enforces the workspace sandbox
       ▼
  services/agent-gateway       picks the target agent's live socket
       ▼
  ── WSS /ws/agent ──▶  Host Agent  ──▶  filesystem
       ▼
  { data: [...] }              every success is wrapped in `data`
```

### A terminal session

```
POST /api/terminal/sessions          → backend asks the agent to spawn a PTY
  { data: { sessionId } }

POST /api/terminal/sessions/:id/ticket
  { data: { ticket } }               short-lived, single-use

ws://…/ws/terminal/:id?ticket=…      the ticket — never the access token
                                     — because a URL ends up in logs and history
```

### An agent connecting

```
POST /api/agents/pair                owner mints a one-time token
  { data: { agentId, token } }

on the target host:
  aether-agent start                 token in agent.env, mode 600

agent ── WSS /ws/agent ──▶ backend    token verified against its SHA-256 hash
  markAgentConnected(agentId)         the registry counts sockets, so a reconnect
                                      race cannot mark a live agent offline
```

---

## Data

**PostgreSQL owns all durable state.** One migration file, `001_init.sql`, applied by a forward-only
runner at startup. See [DATA-MODEL.md](DATA-MODEL.md).

**Redis is a cache and only a cache.** Nothing durable lives there. Every read falls back to
PostgreSQL on a miss, so an empty Redis is a slow Aether, never a broken one.

**The host filesystem is the third store**, reachable only through a host agent and only within
`AETHER_WORKSPACE_ROOT`.

---

## Trust boundaries

| Boundary             | Crossing it means                                                                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser → backend    | Untrusted input. Every request is authenticated, authorized, and schema-validated.                                                                                |
| Backend → host agent | Authenticated by pairing token. The agent re-validates every message rather than trusting the backend.                                                            |
| Agent → host OS      | **The real boundary.** The agent runs with whatever privilege its service user has; `AETHER_PROCESS_SIGNAL_ENABLED` and the workspace root exist to constrain it. |

Detail: [SECURITY-MODEL.md](../security/SECURITY-MODEL.md).

---

## What is deliberately absent

No ORM — `pg` with parameterized SQL, and one migration file under version control. No message queue
— the agent WebSocket is the transport. No Kubernetes, no service mesh, no microservices: this is a
management plane for one or a few hosts, and three containers is the right size for it.

Some of that will need revisiting if Aether is ever asked to manage thousands of hosts. None of it
is wrong for the scale it targets today.

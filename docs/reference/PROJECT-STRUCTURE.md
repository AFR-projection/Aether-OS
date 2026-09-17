# Project structure

What lives where, and the rule that decides it.

```
Aether-cloud-os/
├── install.sh                  # Alternate entry point: re-execs deploy/lib/install.sh (clones if piped)
├── scripts/deploy/setup.sh     # The advertised one-command entry (the curl | bash URL)
├── docker-compose.yml          # Dev: PostgreSQL + Redis only
├── docker-compose.prod.yml     # The production stack (copied to /opt/aether/docker-compose.yml)
├── .env.example                # Mirrors packages/backend/src/config.ts exactly
│
├── packages/                   # pnpm workspace
│   ├── shared/                 # Types, Zod schemas, permissions, constants, path utils
│   │   └── src/{constants.ts, schemas/, types/, utils/}
│   ├── backend/                # Fastify API + WebSocket server
│   │   ├── src/
│   │   │   ├── config.ts       # Zod-validated environment (the source of truth for every var)
│   │   │   ├── server.ts       # Fastify assembly: helmet, CORS, rate limit, static, error handler
│   │   │   ├── routes/         # HTTP handlers — thin: validate, delegate, respond
│   │   │   ├── services/       # Business logic — never touches request/reply
│   │   │   ├── ws/             # terminal.ws.ts, agent.ws.ts — the two WebSocket endpoints
│   │   │   ├── security/       # workspace.ts (sandbox), ws-ticket.ts (30 s single-use tickets)
│   │   │   ├── middleware/     # authenticate, requirePermission
│   │   │   ├── cache/          # index.ts (MemoryCache/RedisCache switch), redis.ts
│   │   │   ├── db/             # pool.ts, migrate.ts — forward-only checksummed migrations
│   │   │   ├── scripts/            # CLI entry points (migrations, local-agent pairing)
│   │   │   └── utils/          # errors, logger (with secret redaction), duration
│   │   └── migrations/         # 001_init.sql (schema), 002_local_agent.sql (instance-scoped agents)
│   ├── frontend/               # React 18 + Vite
│   │   └── src/
│   │       ├── apps/           # The 8 compiled-in apps + registry.ts (the static APP_REGISTRY)
│   │       ├── desktop/        # Window manager, taskbar, launcher — the shell
│   │       ├── auth/           # Login, bootstrap, token refresh
│   │       ├── lib/            # api-client (token handling), terminal-connection, agent-api
│   │       ├── stores/         # Zustand stores (theme, windows, session)
│   │       └── components/     # Shared UI primitives
│   ├── host-agent/             # Runs on managed hosts; connects OUT to the backend
│   │   └── src/
│   │       ├── connection.ts   # WebSocket client with backoff and hello handshake
│   │       ├── protocol.ts     # Message types, shared with backend via @aether/shared
│   │       ├── router.ts       # Capability dispatch
│   │       ├── capabilities/   # system, processes, filesystem, terminal
│   │       └── security/       # Workspace validation (independent of the backend's)
│   └── desktop-client/         # Electron wrapper around the same frontend
│
├── deploy/
│   ├── Caddyfile               # Template; the installer rewrites it per instance
│   ├── lib/                    # core.sh, utils.sh, preflight.sh, dependencies.sh,
│   │                           # secrets.sh, configure.sh, deploy.sh, local-agent.sh,
│   │                           # finalize.sh, install.sh
│   ├── scripts/                # Post-install: the `aether` CLI itself, backup.sh,
│   │                           # restore.sh, update.sh, uninstall.sh, setup-host.sh
│   └── tests/vps-harness.sh    # Real install harness (exits 77 = BLOCKED_BY_ENVIRONMENT off-host)
│
├── docs/                       # ALL documentation — see docs/README.md
├── scripts/init-db.sql         # Dev-only: creates the aether schema for docker compose postgres
└── .github/workflows/ci.yml    # typecheck, lint, test, build on every push
```

## The installed layout

`curl … | bash` does not run from a checkout; it ends up as this, under `/opt/aether` (see
[DEPLOYMENT.md](../operations/DEPLOYMENT.md)):

```
/opt/aether/
├── src/            # full source tree, with .git — this is what `aether update` fast-forwards
├── static/         # built frontend, served by Caddy
├── docker-compose.yml, caddy/
├── scripts/aether  # the CLI, symlinked to /usr/local/bin/aether
├── .env, secrets/  # mode 600
├── local-agent.json, local-agent/  # the auto-paired host agent's identity + its agent.env
├── data/{workspace,uploads}/       # bind-mounted into the backend at /opt/aether/...
├── backups/, state/, logs/
└── install.state   # the orchestrator's resume checkpoints
```

## The rule

Placement follows the layering rule from [OVERVIEW.md](../architecture/OVERVIEW.md):

- **`routes/`** validate input and shape responses. No business logic, no SQL.
- **`services/`** contain business logic and SQL. No `request`/`reply`.
- **`ws/`** do the same job as routes for WebSocket connections.
- Anything used by more than one package belongs in **`shared/`** — message types, permission
  constants, path validation.
- Tests sit beside the file they test (`foo.test.ts` next to `foo.ts`).

## What is deliberately absent

- **No ORM directory, no entities** — SQL strings live in the services; see
  [DATA-MODEL.md](../architecture/DATA-MODEL.md).
- **No `.env` in git** — `.env.example` is the template; `config.ts` is the authority on what exists
  and what is required.
- **No app plugin folder** — apps are compiled in; see KNOWN-LIMITATIONS #9.
- **No root-level scripts beyond `install.sh`** — everything operational is in `deploy/` (and the
  advertised entry point is `scripts/deploy/setup.sh`, which bootstraps a checkout then runs
  `deploy/lib/install.sh`).

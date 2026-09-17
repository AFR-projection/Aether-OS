# Development

## Prerequisites

| Tool            | Version    | Notes                                                                                            |
| --------------- | ---------- | ------------------------------------------------------------------------------------------------ |
| Node.js         | 20+        | Matches the runtime in the production image.                                                     |
| pnpm            | 8+         | The workspace is pnpm-only; npm and yarn will not resolve `workspace:*`.                         |
| Docker          | any recent | Runs PostgreSQL (and Redis, if you want it) for local development.                               |
| Build toolchain | —          | `node-pty` is a native addon. Linux: `build-essential python3`. macOS: `xcode-select --install`. |

---

## First run

```bash
git clone <your-fork> && cd Aether-cloud-os
pnpm install
docker compose up -d              # PostgreSQL + Redis
cp .env.example .env
```

Then set `JWT_SECRET` in `.env`. It must be **at least 32 characters**, and the backend will refuse
to start without it:

```bash
# Linux / macOS
sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -base64 48)|" .env
```

```powershell
# Windows PowerShell
$bytes = [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(48)
(Get-Content .env) -replace '^JWT_SECRET=.*', "JWT_SECRET=$([Convert]::ToBase64String($bytes))" |
  Set-Content .env
```

`ENCRYPTION_KEY` is only _required_ when `NODE_ENV=production`, so the development value from
`.env.example` is fine locally.

```bash
pnpm dev
```

| Service  | URL                            |
| -------- | ------------------------------ |
| Frontend | <http://localhost:5173>        |
| Backend  | <http://localhost:3000>        |
| Health   | <http://localhost:3000/health> |

Open <http://localhost:5173>. The first-run screen asks you to create the owner account. In
development `AETHER_BOOTSTRAP_TOKEN` is unset, so no token is required — see
[FIRST-RUN.md](FIRST-RUN.md).

> **There is no seeded user.** Earlier documentation claimed a `dev` / `dev123` account and an
> `init-db.sql` that created it. Both are gone: `scripts/init-db.sql` now creates no tables at all,
> and the only way to get an account is the bootstrap flow. Seeding a password into a file that
> ships in the repository is how development credentials end up in production.

---

## Verifying the install

```bash
curl -s localhost:3000/health
# {"status":"ok","version":"0.1.0","uptimeSeconds":1,...}

curl -s localhost:3000/api/health | jq
# checks.database.ok, checks.cache.backend, checks.terminal.ok
```

The database schema is created by the backend at startup. Check it landed:

```bash
docker compose exec postgres psql -U aether -d aether_dev -c '\dt aether.*'
```

You should see `users`, `sessions`, `audit_events`, `settings`, `host_agents`, and
`schema_migrations`.

---

## Workspace commands

| Command             | Does                                                 |
| ------------------- | ---------------------------------------------------- |
| `pnpm dev`          | Every package in parallel (backend + frontend)       |
| `pnpm dev:backend`  | Backend only, `tsx watch`                            |
| `pnpm dev:frontend` | Frontend only, Vite                                  |
| `pnpm build`        | Build every package, in dependency order             |
| `pnpm test`         | Vitest across the workspace                          |
| `pnpm test:backend` | Backend tests only                                   |
| `pnpm lint`         | ESLint                                               |
| `pnpm lint:fix`     | ESLint with `--fix`                                  |
| `pnpm typecheck`    | `tsc` across the workspace                           |
| `pnpm format`       | Prettier, write                                      |
| `pnpm format:check` | Prettier, check only — what CI runs                  |
| `pnpm db:migrate`   | Apply pending migrations without starting the server |
| `pnpm clean`        | Remove `dist/`, `coverage/`, `*.tsbuildinfo`         |

**`pnpm build` matters even in development.** The frontend and host-agent import `@aether/shared` as
`workspace:*`, which resolves to its `dist/`. If `shared` has not been built, typecheck and lint
fail with unresolved-module errors that look like something else entirely. CI builds it first for
exactly this reason.

---

## Layout

```
packages/
  shared/          types, Zod schemas, permissions, constants
  backend/         Fastify API + WebSockets + migrations
  frontend/        React SPA
  host-agent/      runs on the managed host
  desktop-client/  Electron wrapper
deploy/
  install.sh       entry point
  lib/             installer stages (preflight → secrets → configure → deploy → finalize)
  scripts/         post-install helpers: backup, restore, update, uninstall, setup-host
docker-compose.yml        development: PostgreSQL + Redis
docker-compose.prod.yml   production: + backend, Caddy
```

Directory-by-directory detail: [PROJECT-STRUCTURE.md](../reference/PROJECT-STRUCTURE.md).

---

## Common tasks

### Reset the development database

```bash
docker compose down -v && docker compose up -d
```

The migrations reapply on the next backend start. You will bootstrap a new owner account, since the
old one went with the volume.

### Run a single test file

```bash
pnpm --filter @aether/backend test src/cache/redis.test.ts
```

### Add a migration

See [DATA-MODEL.md](../architecture/DATA-MODEL.md#adding-a-migration). Never edit an applied
migration — the runner checksums them and will refuse to start.

### Test with Redis instead of the in-process cache

`REDIS_URL` is already set in `.env.example` and the Compose file runs Redis. To confirm which
backend is live:

```bash
curl -s localhost:3000/api/health | jq .checks.cache
```

To develop against the memory backend, comment `REDIS_URL` out and restart.

### Work on the host agent

The agent connects _out_ to the backend, so it needs a pairing token:

1. Run the backend and frontend.
2. Settings → **Host agents** → **Pair agent**.
3. Copy the token and agent id into a local `packages/host-agent/.env` as `AETHER_AGENT_ID` /
   `AETHER_PAIRING_TOKEN`, with `AETHER_BACKEND_URL=ws://localhost:3000`.
4. `pnpm --filter @aether/host-agent dev`

It appears as connected on the same screen. See [HOST-AGENTS.md](../operations/HOST-AGENTS.md).

---

## Troubleshooting

### `Invalid environment configuration: JWT_SECRET must be at least 32 characters`

`.env` is missing or the value is short. `config.ts` loads `.env` via dotenv at import time — but
**an exported shell variable wins over the file**, so a stale `export JWT_SECRET=short` in your
shell will override a correct `.env`. Check with `echo ${JWT_SECRET:-unset}`.

### `Cannot find module '@aether/shared'` during typecheck or lint

`shared` has not been built. Run `pnpm --filter @aether/shared build`, or just `pnpm build`.

### `node-pty` fails to build

A native addon that compiles at install time.

```bash
# Debian / Ubuntu
sudo apt-get install build-essential python3
# Fedora
sudo dnf install make gcc-c++ python3
# macOS
xcode-select --install
```

Then `pnpm rebuild node-pty`.

### Port already in use

```bash
lsof -i :3000            # macOS / Linux
netstat -ano | findstr :3000   # Windows
```

Change `PORT` in `.env`, and update `ALLOWED_ORIGINS` if you also move the frontend.

### `EADDRINUSE` on 5432

Another PostgreSQL is already listening. Either stop it, or point `DATABASE_URL` at it and create
the `aether_dev` database yourself.

### Frontend loads but every request fails CORS

`ALLOWED_ORIGINS` in `.env` must include the origin the browser is actually on —
`http://localhost:5173` for the Vite dev server, not just `http://localhost:3000`.

### Terminal app says the terminal is unavailable

`node-pty` did not load. `GET /api/terminal/available` reports the same thing the UI does. Usually a
failed native build — see above. On Windows, `node-pty` needs the build tools too.

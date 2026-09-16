# Decision log

Why the stack is what it is. Every entry describes code that exists in this repository; where a
choice has a cost, the cost is stated alongside it.

---

| #   | Decision                             | Chose                                  | Over                                        |
| --- | ------------------------------------ | -------------------------------------- | ------------------------------------------- |
| 1   | Backend framework                    | Fastify 4                              | Express, NestJS                             |
| 2   | Database access                      | Hand-written SQL (`pg`)                | Prisma, TypeORM, any ORM                    |
| 3   | Password hashing                     | bcrypt (cost 12)                       | Argon2                                      |
| 4   | Architecture                          | Separate host agent, outbound-only     | Backend SSHes into hosts, or agent accepts inbound connections |
| 5   | WebSocket auth                       | Short-lived single-use tickets         | Token in query string, cookies              |
| 6   | Session revocability                 | `sessions` table checked per request   | Pure stateless JWTs                         |
| 7   | Refresh tokens                       | Opaque random values, SHA-256 at rest  | JWTs for refresh                            |
| 8   | Cache                                | `MemoryCache` default, `RedisCache` when `REDIS_URL` is set | Redis as a hard dependency |
| 9   | Installer scope                      | Ubuntu 22.04/24.04 x86_64 only, hard fatal | Best-effort multi-distro                 |
| 10  | Reverse proxy                        | Caddy                                  | nginx, Traefik                              |
| 11  | Frontend state                       | TanStack Query (server) + Zustand (client) | Redux, single library for both          |
| 12  | Apps                                 | Compiled-in static registry            | Plugin system, runtime app loading          |
| 13  | Editor                               | Plain `textarea`                       | Monaco/CodeMirror                           |
| 14  | Monorepo                             | pnpm workspaces                        | Nx, Turborepo                               |
| 15  | Validation                           | Zod schemas shared between packages    | Per-package hand-rolled validation          |

---

## The reasoning

### 1–3. Fastify, raw SQL, bcrypt

Fastify for first-class schema support and a plugin model that keeps WebSocket routes in the same
server as HTTP. Express was rejected for the version churn in its middleware ecosystem; NestJS for
the amount of framework you must learn to debug a 401.

No ORM. The schema has six tables; an ORM would add a migration toolchain, a query planner to
second-guess, and a type layer to fight, in exchange for writing less SQL against a schema small
enough to hold in your head. `psql` output is the ground truth, and there is no translation layer
between what the code says and what the database does.

bcrypt over Argon2 because `bcryptjs` is pure JS and installs everywhere `node-pty` compiles, while
Argon2 needs a native build chain on every host — including every managed host the setup script
touches. Cost 12 keeps a hash around 250 ms. If the dependency cost ever stops mattering, Argon2id is
the better algorithm; the hashing is isolated in `auth.service.ts` behind two functions.

### 4. The agent split

The single decision that shapes everything else. The backend never touches a managed host directly;
it asks an agent over WebSocket, and the agent does the work. Consequences, all deliberate:

- one backend manages many hosts;
- the backend stays in a container with no host access, so compromising it does not directly grant a
  shell on any managed machine;
- the agent connects **out**, so no inbound port on managed hosts — the common case where the host
  sits behind a firewall you do not control just works;
- pairing is a first-class operation with revocable credentials, because the agent *is* a root-level
  credential for its host.

The cost: every feature that touches "the machine" must be designed twice (backend route + agent
capability), and the protocol needs version discipline. Worth it.

### 5–7. Tickets, sessions, opaque refresh tokens

A browser cannot set an `Authorization` header on a WebSocket handshake. The ticket flow (30 s,
single-use, session-bound) avoids both standard workarounds: the access token in the query string
(lands in every proxy log) and cookies (CSRF against the socket).

A stateless JWT cannot be revoked, which would make logout cosmetic. The `sessions` table is checked
on every request, cached for 5 s — an explicit trade-off documented in
[KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md).

Refresh tokens are opaque 256-bit values stored as SHA-256 digests: a database dump yields no usable
tokens, and rotation with reuse detection catches theft. JWTs for refresh were rejected — a JWT is a
credential *format*, not a credential *store*, and the signature adds nothing the session row does
not already provide.

### 8. Redis optional

The cache interface has two implementations. In-process by default; Redis-backed when `REDIS_URL` is
set. Dev runs with zero infrastructure beyond PostgreSQL; production at any real scale sets
`REDIS_URL`. The rule it enforces: one replica works without Redis, more than one replica requires
it — and the backend logs loudly rather than silently misbehaving.

### 9–10. Installer scope, Caddy

The installer hard-fails on anything but Ubuntu 22.04/24.04 x86_64 with systemd. Supporting "most
distros, probably" means an untested matrix where every failure is a bug report with no reproducer.
Narrow scope, honest failure, documented manual path for everyone else.

Caddy for automatic HTTPS — the ACME ceremony that nginx needs certbot and three moving parts for is
Caddy's default behaviour. The one supported deployment has no certificate expiry failures by
construction.

### 11–13. Frontend choices

TanStack Query owns server state (caching, invalidation, retries) and Zustand owns client state
(theme, window layout). One library for both means reimplementing a cache; Redux means writing
slices for data that is already a cache.

Apps are compiled into the bundle — a static registry of React components. No plugin system means no
sandbox problem, no third-party code review burden, no plugin API to keep stable while pre-1.0. A
future third-party runtime is a design problem of its own and is not hand-waved into existence.

Code Studio is a `textarea` with line numbers. Monaco would be a half-configured dependency for a
feature nobody asked for yet; an honest plain editor with a disabled save on truncated reads is
better than a broken editor pretending otherwise.

### 14–15. Monorepo, Zod

pnpm workspaces, nothing else — five packages do not need a build orchestrator. Zod schemas live in
`@aether/shared` so the same definition validates an agent message at both ends of the socket and an
API payload at the route.

---

## Decisions explicitly *not* made

- **License** — `"license": "PENDING"` in `package.json`. Blocked on the maintainer, and it blocks
  any public release.
- **Multi-tenancy** — the data model is single-instance, multi-*user* (roles within one workspace).
  True multi-tenant SaaS is out of scope and would require reworking the workspace model end to end.
- **2FA** — agreed to be needed eventually; not designed. Adding it later is additive (new table,
  new login step) rather than a breaking change.

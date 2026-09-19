# Host agents

An Aether instance does not touch a managed machine directly. It talks to a **host agent** running
on that machine, over a WebSocket. Everything the UI shows about a host — its files, processes, CPU,
terminals — comes through an agent.

This means:

- one backend can manage **several hosts**;
- the machine Aether itself runs on needs an agent too (the backend is not an agent, and never acts
  as one) — the installer pairs that one automatically, see
  [The local host agent](#the-local-host-agent);
- the agent connects **out** to the backend, so **no inbound port is opened on the managed host** —
  which matters when that host is on a network you do not control.

---

## The local host agent

A fresh install manages its own machine with no pairing step. The installer:

1. creates the `aether-agent` system user, with the same numeric uid/gid as the backend container
   (1001) so both can write the workspace bind mount;
2. generates a UUID and a 256-bit token, and stores **only the SHA-256 hash** in
   `aether.host_agents` (`scope = 'local'`, no owner);
3. writes `local-agent/agent.env` (mode 600, owned by `aether-agent`) with the URL, the agent id,
   and the token — the plaintext token is never printed and never stored anywhere else;
4. builds and installs the agent, then starts `aether-host-agent.service`;
5. waits for the connection to be confirmed **on both sides** before reporting success.

That last point is the one to know about: the installer reads the agent's own journal for
`paired with backend` **and** the backend log for `agent connected` with that agent id. Either one
alone can be true of a socket that is already dead. If both do not arrive, the install fails —
`aether status` and `aether doctor` use the same rule.

Its unit is hardened, because the local agent only ever touches its workspace:

```
User=aether-agent
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
ReadWritePaths=<install>/data/workspace
```

The agent talks to the backend through Caddy (`wss://your-domain`), never to a container port: the
backend publishes none.

```bash
systemctl status aether-host-agent
journalctl -u aether-host-agent -f
```

Remote hosts are unaffected by any of this. They use `setup-host.sh` below, run as `root` by default
because an operator managing a machine they own expects the agent to reach the whole filesystem.
Pass `--service-user <name>` to run it unprivileged instead, which adds the same hardening.

---

## Pairing a remote host

### 1. Mint a token — in the UI

**Settings → Host agents → Pair agent.** Give the agent a label (`web-01`).

The dialog shows three values, **once**:

| Value                  | Goes into                                               |
| ---------------------- | ------------------------------------------------------- |
| `AETHER_BACKEND_URL`   | `wss://your-instance` (derived from the URL you are on) |
| `AETHER_AGENT_ID`      | The id of the agent row the backend just created        |
| `AETHER_PAIRING_TOKEN` | The shared secret                                       |

**Copy all three now.** Only the SHA-256 hash of the token is stored, and the agent id is the
primary key of a row that already exists. Neither can be shown again. If you lose them, revoke the
agent and pair a new one.

### 2. Run the setup script — on the managed host

```bash
curl -fsSL https://raw.githubusercontent.com/AFR-projection/Aether-OS/main/deploy/scripts/setup-host.sh \
  -o setup-host.sh

sudo bash setup-host.sh \
  --backend-url wss://your-instance \
  --agent-id  <AETHER_AGENT_ID> \
  --token     <AETHER_PAIRING_TOKEN>
```

All three are **required**. The script re-executes itself under `sudo` if needed, because the
install directory, the config file, and the systemd unit are all root-owned.

> Run it from a checkout and it uses the local source; run it standalone and it fetches the
> repository. Either way it builds `@aether/shared` and then `@aether/host-agent`.

What it does:

1. Verifies the backend URL uses `ws://` or `wss://` — `http://` is a common mistake and is rejected
   with a message explaining why.
2. Installs Node 20 from NodeSource if absent or too old.
3. Installs a C++ toolchain (`build-essential`, `python3`) if absent — `node-pty` is a native module
   and fails with an opaque gyp error without one.
4. Copies and builds the agent, defaulting to `/opt/aether-host-agent`.
5. Writes `agent.env` in that directory with `umask 077` (mode 600), containing the backend URL, the
   agent id, the pairing token, the workspace root, and the capability flags.
6. Installs and starts `aether-host-agent.service`.
7. Prints a summary with the service name and how to follow the logs.

### 3. Confirm

The row on **Settings → Host agents** turns green within a few seconds, and shows a connected
timestamp.

---

## Options

| Flag                  | Effect                                                                               |
| --------------------- | ------------------------------------------------------------------------------------ |
| `--backend-url URL`   | **Required.** `ws://` or `wss://`                                                    |
| `--token TOKEN`       | **Required.** Minimum 16 characters                                                  |
| `--agent-id UUID`     | **Required.** From the same dialog                                                   |
| `--workspace DIR`     | Directory the agent may touch (default `/opt/aether/workspace`)                      |
| `--install-dir DIR`   | Where to install (default `/opt/aether-host-agent`)                                  |
| `--repo-dir DIR`      | Source checkout to install from (default: this checkout)                             |
| `--service-user USER` | Run the agent as this user (default `root`). A non-root user gets the hardened unit. |
| `--no-service`        | Write the config and build, but do not install or start the unit                     |
| `--uninstall`         | Stop the agent and remove its unit, install directory, and config                    |
| `-h`, `--help`        | Usage                                                                                |

Re-running the script is safe: the source copy never deletes `agent.env`, so an agent keeps its
identity and token across a repair.

### Uninstalling

```bash
sudo bash setup-host.sh --uninstall
```

Then revoke it in the UI, so the backend stops listing a host that no longer exists.

---

## How pairing actually works

```
UI: POST /api/agents/pair
    → backend generates agentId (uuid) and a random token
    → stores (agentId, sha256(token), label, owner)
    → returns the plaintext token ONCE

agent: wss://backend/ws/agent?agentId=…&token=…
    → backend: SELECT … FROM aether.host_agents WHERE id = $1
    → rejects if the row is missing, revoked, or the token hash differs
    → logs "agent connected"

agent: { type: "hello", id: "__hello__", capabilities: [...] }
    → backend replies { type: "hello_ack", agentId, ownerUserId }
    → agent logs "paired with backend" and starts dispatching requests
```

The agent dispatches **nothing** until it has seen that acknowledgement: before it arrives every
request is answered `UNAUTHENTICATED`, and if it never arrives the agent drops the socket after 15
seconds and reconnects. That is why a backend that accepts the socket but never answers the
handshake looks like an agent that keeps reconnecting.

For a local agent — which has no owning user — `ownerUserId` is the agent's own id. The gateway keys
that agent's terminal sessions on `agent:<id>` internally; the agent is never sent that string,
because it validates the field as a UUID.

Two consequences worth knowing:

**The agent id is not yours to choose.** It is the primary key of a row the backend created. An id
generated on the managed host would be looked up, not found, and rejected as "Unknown agent" — which
is why `setup-host.sh` requires it rather than inventing one.

**Token comparison is constant-time** (`safeEqualHex`), so a wrong token cannot be discovered a byte
at a time by timing the response.

---

## The workspace

`AETHER_WORKSPACE_ROOT` is the **only** tree the agent will touch, for both the Files app and the
terminal. It is resolved with `fs.realpath` at startup, and nothing outside it is reachable —
including through a symlink that points out of it.

This is a real boundary, not a convention: the path is validated on the **agent** side as well as
the backend side, because the agent does not assume the backend already checked.

---

## Capabilities

An agent advertises what it can do at handshake time:

| Group     | Capabilities                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| System    | `system.info`                                                                                                                   |
| Processes | `processes.list`, `processes.signal`                                                                                            |
| Files     | `files.list`, `files.read`, `files.readChunk`, `files.write`, `files.writeChunk`, `files.delete`, `files.mkdir`, `files.rename` |
| Ports     | `ports.list`, `ports.open`, `ports.read`, `ports.write`, `ports.close`                                                          |
| Terminal  | `terminal.create`, `terminal.input`, `terminal.resize`, `terminal.signal`, `terminal.kill`, `terminal.list`                     |

That list is the entire vocabulary. There is **no `exec` and no arbitrary command**: every
capability is a named operation with a typed parameter schema validated before it reaches a handler.
A compromised agent cannot be asked to do anything outside this set.

The four `files.*Chunk` and `ports.*` capabilities are each half of a stream rather than a
request/response pair. A file is read and written in chunks so a large one never has to fit in a
single message, and a port tunnel is pulled a chunk at a time — the agent holds the socket back
while no read is outstanding, so the kernel's own buffer is the only place bytes wait.

### Process signalling

`AETHER_PROCESS_SIGNAL_ENABLED` defaults to **false**. Ending a process is the one action that can
take a host down — a careless click on `sshd` locks you out — so it is opt-in. The setup script
writes it as `false` explicitly.

Even when enabled, the agent refuses to signal PID 1, itself, or any of its own ancestors, and the
API reports `signalable: false` for those so the UI can grey them out.

### Terminal

`TERMINAL_ENABLED` defaults to true. Terminal sessions spawn a shell from the backend's
`TERMINAL_ALLOWED_SHELLS`; the agent does not accept a caller-supplied command line.

A terminal on a host is **not a sandbox**. It is a shell running as the agent's service user, with
that user's full access to the machine. Grant `terminal:create` accordingly — that is what the
`operator` role is for, and why `viewer` does not have it.

---

## Port previews

This is how a project started in the Terminal becomes a window in the desktop.

The problem is a network boundary, not a missing feature. A dev server binds to `127.0.0.1` by
default — Vite, webpack, `flask run`, `rails server`, all of them — and that address means _this
machine only_. The backend runs in a container and is not on this machine, so it cannot reach that
port, and a browser pointed at the VPS cannot either. The host agent runs on the machine itself, so
it is the only thing that can both see the socket and connect to it.

**What the Ports app shows.** `ports.list` reads `/proc/net/tcp` and `/proc/net/tcp6` — the kernel's
own table of listening sockets — and joins each socket to the process that owns it through
`/proc/<pid>/fd`, so a row can name the framework rather than an inode. Rows bound only to loopback
are labelled as such: such a server is reachable through Aether and from nowhere else, and saying so
is more useful than hiding the distinction.

**How a preview is addressed.** A preview is served from _this same hostname on a spare port_
(`https://example.com:8443`), not from a path under the desktop. Three things follow from that, and
each of them is the reason for the choice:

- The project sees itself at `/` of its own origin, so the absolute asset URLs every framework emits
  resolve. Served under `/ports/5173/`, the same app requests `/assets/app.js` from the desktop's
  root and comes up blank.
- The previewed app is on a different origin, so nothing it runs can read the desktop's stored
  session. A path under the desktop's origin would put a project's code — a dependency, a
  postinstall script — inside reach of the token in `localStorage`.
- It needs no DNS record and no certificate of its own: the hostname is unchanged, so the existing
  certificate covers it, and only the port range has to be published and allowed through the
  firewall.

**What authorises a preview.** Not the session token: a page in an iframe fetches its own images,
scripts and stylesheets, and none of those requests can carry an `Authorization` header. So opening
a preview reserves one address for the user and sets an `HttpOnly` cookie named for that address,
signed with a key derived from `SESSION_SECRET`. Every request on a preview address is checked
against both halves — the cookie's owner and the reservation on that address — so a valid cookie
cannot be pointed at somebody else's preview by editing a URL. Cookies ignore ports, which is what
makes a cookie set by the desktop on `example.com` arrive at `example.com:8443`; that is also why
the cookie is named per address rather than shared, since one name would have each new preview
overwrite the last one's credential.

A policy header from the project is kept rather than overridden. `X-Frame-Options` is removed —
there is no value of it that permits a frame while still refusing a real cross-site one — and a
`frame-ancestors` directive is rewritten to name the desktop, which keeps every other directive the
app declared. So the project's own clickjacking protection survives, minus being framed by Aether
itself.

**What is relayed.** Requests and responses, byte for byte, including the request body, a project's
own `Set-Cookie` headers, and WebSocket upgrades — a dev server's hot reload is a socket, and
without it every edit would need a manual reload. Each browser connection gets its own tunnel to the
project, so a slow response does not stall its siblings, and the tunnel is retired the moment its
connection closes rather than waiting for an idle timer.

**When it does not work.** In order of likelihood:

| Symptom                               | Cause                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| The window stays empty, nothing loads | The preview port range is not published by Docker, or not open in the firewall.                  |
| `Aether could not connect to port N`  | Nothing is listening on that port any more — the dev server exited after the list was read.      |
| The page loads but assets 404         | The project is configured with a base path; set it to `/`.                                       |
| Hot reload does not connect           | The dev server is not listening for a WebSocket on the same port, or it is bound to another one. |

Preview addresses come from `AETHER_PREVIEW_PORT_START` and `AETHER_PREVIEW_PORT_COUNT`; see
[Configuration](../reference/CONFIGURATION.md#port-previews) for what the installer does with them.

---

## Operations

```bash
sudo systemctl status aether-host-agent
sudo journalctl -u aether-host-agent -f

# After editing /opt/aether-host-agent/agent.env:
sudo systemctl restart aether-host-agent
```

The agent reconnects on its own with backoff if the backend restarts or the network drops, and
re-sends its `hello` frame. You do not need to restart it after a backend upgrade.

---

## Revoking

**Settings → Host agents → Revoke.** This is a **soft** revoke: `revoked_at` is set, and the agent
stops being listed and stops being able to authenticate — but the row survives, so the record of
what was once paired is not erased from the database.

Revoking does not stop the agent process on the managed host. It will fail to authenticate on its
next reconnect and retry forever. To stop it:

```bash
sudo bash setup-host.sh --uninstall
```

---

## Troubleshooting

**The row stays grey / "connected: false"**

On the managed host, follow the log:

```bash
sudo journalctl -u aether-host-agent -n 50 --no-pager
```

| Log line                                                               | Cause                                                                                                               |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `Invalid agent credentials`                                            | The agent id or token does not match the row in the database.                                                       |
| `Unknown agent`                                                        | The id is not one the backend created — usually a hand-typed id.                                                    |
| `Agent has been revoked`                                               | It was revoked in the UI. Pair a new one.                                                                           |
| `Invalid hello acknowledgement`                                        | The backend answered the handshake with a payload the agent rejects. A mismatch between backend and agent versions. |
| `ECONNREFUSED` / `getaddrinfo`                                         | The backend URL is wrong or unreachable from that host.                                                             |
| `websocket error` repeatedly                                           | A proxy in front of the backend is not passing the upgrade.                                                         |
| `websocket open, sending hello` with no `paired with backend` after it | The socket opened but the backend never answered. Check the backend log for a rejected handshake.                   |

**`Use wss:// or ws:// for the agent socket, not http(s)://`**

Exactly what it says. The agent URL is a WebSocket URL.

**`node-pty` fails to build**

`sudo apt-get install build-essential python3`, then re-run the script.

**Everything says "Terminal support is not available on this host"**

`node-pty` did not load on the **backend**, not the agent. Check
`curl -s localhost:3000/api/terminal/available` on the backend host.

**The agent connects but Files shows nothing**

Check `AETHER_WORKSPACE_ROOT` in both `agent.env` **and** the backend's `.env`. Both are enforced,
and if the backend's root is not inside the agent's, every path is rejected.

**After a backend upgrade, agents do not reconnect**

They should. If they do not, check that `AETHER_PAIRING_TOKEN` is still in `agent.env` and that the
`host_agents` row survived — `aether restore` from a backup taken before the agents were paired will
not contain their rows, and every agent will need re-pairing.

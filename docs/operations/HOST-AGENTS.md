# Host agents

An Aether instance does not touch a managed machine directly. It talks to a **host agent** running
on that machine, over a WebSocket. Everything the UI shows about a host — its files, processes, CPU,
terminals — comes through an agent.

This means:

- one backend can manage **several hosts**;
- you pair an agent even for the machine Aether itself is installed on (the backend is not an
  agent, and never acts as one);
- the agent connects **out** to the backend, so **no inbound port is opened on the managed host** —
  which matters when that host is on a network you do not control.

---

## Pairing

### 1. Mint a token — in the UI

**Settings → Host agents → Pair agent.** Give the agent a label (`web-01`).

The dialog shows three values, **once**:

| Value                  | Goes into                                       |
| ---------------------- | ----------------------------------------------- |
| `AETHER_BACKEND_URL`   | `wss://your-instance` (derived from the URL you are on) |
| `AETHER_AGENT_ID`      | The id of the agent row the backend just created |
| `AETHER_PAIRING_TOKEN` | The shared secret                                |

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

| Flag                 | Effect                                                                 |
| -------------------- | ---------------------------------------------------------------------- |
| `--backend-url URL`  | **Required.** `ws://` or `wss://`                                       |
| `--token TOKEN`      | **Required.** Minimum 16 characters                                     |
| `--agent-id UUID`    | **Required.** From the same dialog                                      |
| `--workspace DIR`    | Directory the agent may touch (default `/opt/aether/workspace`)          |
| `--install-dir DIR`  | Where to install (default `/opt/aether-host-agent`)                      |
| `--repo-dir DIR`     | Source checkout to install from (default: this checkout)                 |
| `--no-service`       | Write the config and build, but do not install or start the unit          |
| `--uninstall`        | Stop the agent and remove its unit, install directory, and config        |
| `-h`, `--help`       | Usage                                                                    |

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
    → replies hello_ack

agent: { type: "hello", … capabilities: [...] }
```

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

| Group     | Capabilities                                                                     |
| --------- | -------------------------------------------------------------------------------- |
| System    | `system.info`                                                                      |
| Processes | `processes.list`, `processes.signal`                                               |
| Files     | `files.list`, `files.read`, `files.write`, `files.delete`, `files.mkdir`           |
| Terminal  | `terminal.create`, `terminal.input`, `terminal.resize`, `terminal.signal`, `terminal.kill`, `terminal.list` |

That list is the entire vocabulary. There is **no `exec` and no arbitrary command**: every capability
is a named operation with a typed parameter schema validated before it reaches a handler. A
compromised agent cannot be asked to do anything outside this set.

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

| Log line                          | Cause                                                            |
| --------------------------------- | ---------------------------------------------------------------- |
| `Invalid agent credentials`       | The agent id or token does not match the row in the database.      |
| `Unknown agent`                   | The id is not one the backend created — usually a hand-typed id.   |
| `Agent has been revoked`          | It was revoked in the UI. Pair a new one.                          |
| `Timed out waiting for hello`     | The socket opened but the backend never acknowledged. Check the backend log for a rejected handshake. |
| `ECONNREFUSED` / `getaddrinfo`    | The backend URL is wrong or unreachable from that host.             |
| `websocket error` repeatedly      | A proxy in front of the backend is not passing the upgrade.         |

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

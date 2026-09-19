# First run

You have a running instance and no accounts. Here is what to do.

---

## 1. Create the owner account

Open the instance URL. With zero users in the database, the app shows the first-run screen instead
of a login form.

Pick a username — 3–32 characters, lowercase letters, digits, `_` and `-`, and it must start and end
with a letter or digit — and a password. That account becomes the **owner**: it holds every
permission, including `users:manage`, and it is the only account that can create other users.

### The bootstrap token

If `AETHER_BOOTSTRAP_TOKEN` is set, the screen also asks for it and the request must carry it in an
`X-Bootstrap-Token` header. **The installer always sets it**, so on a deployed instance you need it.
Find it with:

```bash
sudo grep AETHER_BOOTSTRAP_TOKEN /opt/aether/.env
```

In a development checkout the variable is normally unset and the screen asks for nothing.

**Why it exists.** Bootstrap is necessarily unauthenticated — there is no account yet to
authenticate with. Without a token, anyone who happens to reach a freshly installed instance before
you do can claim the owner account, and there is no way to take it back except by wiping the
database. The token is the only thing standing between "I just installed this" and "someone else
owns it". It works exactly once: `POST /api/auth/bootstrap` is refused with `409` as soon as one
user exists.

> Treat the bootstrap token like a password. Do not paste it into chat, a ticket, or a screenshot.

### Running headless

```bash
curl -X POST https://your-instance/api/auth/bootstrap \
  -H 'Content-Type: application/json' \
  -H "X-Bootstrap-Token: $(grep AETHER_BOOTSTRAP_TOKEN /opt/aether/.env | cut -d= -f2)" \
  -d '{"username":"aldo","password":"<a long passphrase>"}'
```

Rate-limited to 10 attempts per 15 minutes.

---

## 2. Pair a host

Aether manages hosts through an **agent** that runs on each one. To manage the machine Aether itself
is installed on, you still pair an agent for it — the backend is not a host agent and never acts as
one.

1. **Settings → Host agents → Pair agent.**
2. Give it a label (`web-01`).
3. The dialog shows three values **once**: the backend URL, an agent id, and a pairing token. Copy
   them now.

The token is stored only as a SHA-256 hash. There is no way to display it again — if you lose it,
revoke the agent and pair a new one.

4. On the target machine:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/AFR-projection/Aether-OS/main/deploy/scripts/setup-host.sh \
     -o setup-host.sh
   sudo bash setup-host.sh \
     --backend-url wss://your-instance \
     --agent-id <agent id> \
     --token <pairing token>
   ```

   The script installs Node 20 if needed, builds the agent, writes
   `/opt/aether-host-agent/agent.env` (mode 600), and starts a systemd unit.

5. Back on **Settings → Host agents**, the row goes green within a few seconds.

Full detail, including firing the agent up by hand: [HOST-AGENTS.md](../operations/HOST-AGENTS.md).

---

## 3. A tour

| App                 | Where to start                                                           |
| ------------------- | ------------------------------------------------------------------------ |
| **Terminal**        | A real shell on the paired host. `whoami`, `df -h`. It is not a sandbox. |
| **Files**           | The workspace only — `AETHER_WORKSPACE_ROOT`, not the whole filesystem.  |
| **Ports**           | Servers running on the host, opened as windows. See below.               |
| **System Monitor**  | Live CPU, memory, disk from the host's `/proc`.                          |
| **Task Manager**    | Processes with memory and state. The CPU column is empty — see below.    |
| **Code Studio**     | Edit a text file from the Files app. No syntax highlighting, by choice.  |
| **Security Center** | The audit log of everything that has happened on this instance.          |
| **Settings**        | Account, sessions, users, host agents.                                   |

Two things that look broken but are not:

- **The Task Manager's CPU column is always `0`.** A per-process percentage needs two samples over
  time; Aether takes one and reports zero rather than inventing a number. System-wide CPU is real.
  See
  [Known limitations](../status/KNOWN-LIMITATIONS.md#6-per-process-cpu-usage-is-always-reported-as-0).
- **Code Studio has no syntax highlighting.** It is a textarea with a gutter. An honest plain editor
  beat a half-configured code editor component.

---

## 3a. Running a project

This is the part that makes the desktop a place to work rather than a place to look.

```bash
# In the Terminal app, on the host
mkdir -p ~/projects/hello && cd ~/projects/hello
printf '<h1>hello from the host</h1>\n' > index.html
python3 -m http.server 8000
```

Open the **Ports** app. Port `8000` is listed with the process that owns it. Press **Preview**: the
server is reached through the host agent and the page appears in a window — and in a tab of your own
browser, at the same address, if you would rather have it there.

Anything that binds to loopback works the same way, which is all of them by default: `npm run dev`,
`php -S localhost:8000`, `go run .`. A dev server keeps its hot reload too, because the WebSocket it
uses is relayed along with everything else.

Moving a project onto the host from your own machine is an ordinary file operation — the Files app
uploads, or `scp`, or `git clone` in the Terminal.

Two things worth knowing:

- **A preview is its own origin.** It is served from this same hostname on a spare port, so the
  project cannot read the desktop's session, and it must be configured with a base path of `/`.
- **Previews are per user and expire.** Twelve hours, or until you press Stop. The address is not
  guessable in a useful way and is checked against the reservation on every request — but it is a
  bearer credential for the port it names, so it is not something to leave open on a shared machine.

---

## 4. Before you expose it to the internet

Read [HARDENING.md](../security/HARDENING.md). The short version:

- [ ] A domain with HTTPS (the installer does this when you pass `--domain`), not plain HTTP.
- [ ] `AETHER_BOOTSTRAP_TOKEN` cleared from `.env` now that the owner account exists.
- [ ] `sudo aether backup` run once, and the archive moved off the host.
- [ ] `AETHER_PROCESS_SIGNAL_ENABLED` left `false` unless you specifically need it.
- [ ] Know what the known limitations are — particularly that the refresh token lives in
      `localStorage`, which is the largest weakness in the project.

---

## 5. Day two

```bash
sudo aether status                 # what is running
sudo aether logs backend           # follow the logs
sudo aether backup                 # take a backup
sudo aether update                 # update (backs up first, automatically)
```

Add users at **Settings → Users** — owner only. The four roles and what each may do are in
[API.md](../reference/API.md#conventions).

# Hardening

What to do beyond the defaults before letting other people use an instance. The installer already
does a lot — generates secrets, writes a hardened `.env`, configures the firewall, checks that no
internal port is exposed. This is the list of things it cannot decide for you.

Ordered by what actually reduces risk most.

---

## 1. Put it behind HTTPS

If the installer ran with `--domain`, Caddy already holds a Let's Encrypt certificate and renews it.
If it did not, you are on HTTP, and **login credentials and every terminal keystroke travel in the
clear.**

```bash
sudo aether status          # is it running?
curl -sI https://your-domain | head -1
```

To add TLS to an existing instance, re-run the installer with `--domain` and `--email`. Caddy's ACME
HTTP-01 challenge needs port 80 reachable from the internet and the domain's A record pointing at
this host — check with `dig +short your-domain` before you start.

---

## 2. Create the owner account immediately

Between the stack coming up and the owner account existing, anyone who can reach the instance can
claim it via `POST /api/auth/bootstrap`.

The installer generates `AETHER_BOOTSTRAP_TOKEN` and requires it on that request, which closes the
window. It is in `/opt/aether/.env`. Read it, use it, and then **do not leave it in your shell
history**:

```bash
sudo grep '^AETHER_BOOTSTRAP_TOKEN=' /opt/aether/.env
```

Once a user exists, bootstrap is refused unconditionally — the token stops mattering. Do not paste
it into a chat, a ticket, or a screenshot.

Full walkthrough: [FIRST-RUN.md](../getting-started/FIRST-RUN.md).

---

## 3. Stop using HTTP-only mode

If you installed without a domain, the site address in Caddy is `:80` and everything is plaintext.
This is fine for a lab. It is not fine for anything reachable.

---

## 4. Tighten the firewall

The installer allows SSH **before** anything else, then 80 and 443, and never disables the firewall.
Verify it did:

```bash
sudo ufw status verbose
```

The default deny policy is what matters — `ufw default deny incoming`. If your host has a cloud
provider firewall as well, restrict 22 to your own address there.

**Do not close the SSH rule while you are connected over SSH.** That is how you lock yourself out of
a remote machine.

### Add brute-force protection on SSH

Aether's login is rate-limited to 10 attempts per 15 minutes. SSH is not.

```bash
sudo apt-get install -y fail2ban
sudo systemctl enable --now fail2ban
```

Do this **after** confirming you can still log in. Test in a second session before closing the
first.

---

## 5. Review who has an account

Every account is a way in, and `operator` and above have a shell on every managed host.

**Settings → Users.** The four roles are described in
[SECURITY-MODEL.md](SECURITY-MODEL.md#authorization). The short version:

| Role       | Give it to                                 |
| ---------- | ------------------------------------------ |
| `owner`    | As few people as possible. It is absolute. |
| `admin`    | People who administer users and agents     |
| `operator` | People who should have a terminal          |
| `viewer`   | Anyone who only needs to look              |

Deactivating a user takes effect immediately for new requests; existing sessions keep working for up
to 5 seconds. Revoke their sessions explicitly if that matters:

**Settings → Sessions**, or **Security Center**.

---

## 6. Turn off process signalling unless you need it

`AETHER_PROCESS_SIGNAL_ENABLED` defaults to **false**, including in the agent config the setup
script writes. Leave it off.

When it is on, the Task Manager can end processes on the host — and a careless click on `sshd` or
the firewall daemon locks you out. If you enable it, do it on a host you can reach by console.

---

## 7. Choose the workspace deliberately

`AETHER_WORKSPACE_ROOT` is the only tree the UI can touch, but everything inside it is fully
readable and writable by anyone with `files:read` / `files:write`. Pointing it at `/` would make the
sandbox meaningless.

Set it to a directory that contains what you want to manage and nothing else. Both the backend and
the agent enforce it, and it is resolved with `fs.realpath` at startup.

---

## 8. Restrict who can reach the instance

Not everything needs to be on the public internet. Options, roughly in order of effort:

- **Bind Caddy to a specific interface**, or restrict 443 by source address in your cloud firewall.
- **Put it behind a VPN** (WireGuard, Tailscale) and allow 443 only from the VPN range. This is the
  biggest single reduction in attack surface available, and it costs nothing in usability for a
  single-admin instance.
- **Front it with an authenticating proxy** if you need to expose it more widely.

Remember that a viewer with a working session can still read files in the workspace.

---

## 9. Back up, and test the restore

`sudo aether update` takes a backup automatically, but that is not a backup _policy_ — it only fires
when you update.

```bash
sudo crontab -e
# 17 2 * * * /opt/aether/scripts/backup.sh >> /var/log/aether-backup.log 2>&1
```

The archive contains `.env` and therefore every secret in plaintext. **Treat it like the server
itself** — if you copy it off-host, encrypt it or put it somewhere access-controlled.

A backup you have never restored is a hypothesis. Restore one into a scratch instance and confirm
the data is there. See [BACKUP-AND-RESTORE.md](../operations/BACKUP-AND-RESTORE.md).

---

## 10. Keep it updated

```bash
sudo aether update --check     # is there anything new?
sudo aether update             # back up, rebuild, restart, verify health
```

`update` takes a full backup before touching anything, and if the post-update health check fails it
prints the archive to roll back to:

```bash
sudo aether rollback /opt/aether/backups/aether-backup-<timestamp>.tar.gz
```

Subscribe to security advisories for the pieces this depends on — PostgreSQL, Docker, Caddy, Node —
because Aether shipping a fix does you no good if the base image is the vulnerable part.

---

## 11. Watch the audit log

**Security Center** shows the audit trail. The entries worth noticing:

| Action              | Means                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------- |
| `permission.denied` | Someone tried something their role does not allow. A few are normal; a pattern is not. |
| `auth.login.failed` | Repeated failures on one account is a brute-force attempt.                             |
| `agent.paired`      | A host was added. If you did not do it, someone has an owner or admin session.         |
| `session.revoked`   | Someone was logged out. Investigate unexpected ones.                                   |

The API is append-only — there is no endpoint that edits or deletes an event. But the log lives in
the same database as everything else, so it is not tamper-proof against someone with database
access. If you need that property, ship the events somewhere else:

```bash
sudo aether logs backend | grep '"audit"'
```

---

## 12. Review the `.env` the installer wrote

```bash
sudo grep -v '^#' /opt/aether/.env | grep -v '=$'
```

Check specifically:

- `TRUST_PROXY_HOPS` — should be `1` behind Caddy. **Higher than the real number of proxies lets a
  client spoof its IP and bypass rate limiting entirely.**
- `ALLOWED_ORIGINS` — should be your domain, not `*`.
- `LOG_LEVEL` — `debug` and `trace` are rejected in production for a reason: they log more.
- `RATE_LIMIT_ENABLED` — leave it on.
- `NODE_ENV` — must be `production`, or the secrets validation relaxes.

Do not print this file to a terminal you are screen-sharing, and do not paste it into a chat.

---

## Hardening checklist

- [ ] HTTPS working, certificate renewing
- [ ] Owner account created; bootstrap token no longer usable
- [ ] `ufw` enabled, default deny, SSH allowed **before** 80/443
- [ ] fail2ban installed _and_ tested from a second session
- [ ] User list reviewed; no unnecessary `owner` or `operator` accounts
- [ ] `AETHER_PROCESS_SIGNAL_ENABLED=false`
- [ ] `AETHER_WORKSPACE_ROOT` points at a purpose-built directory, not `/`
- [ ] `TRUST_PROXY_HOPS` matches the actual proxy count
- [ ] `ALLOWED_ORIGINS` is your domain, not `*`
- [ ] Access restricted by VPN or source IP if it does not need to be public
- [ ] Nightly backup in cron; a restore has actually been tested
- [ ] Backup archives stored encrypted, or on a host as trusted as this one
- [ ] `sudo aether status` clean, no internal port exposed
- [ ] Audit log reviewed once

---

## What hardening cannot fix

Be clear-eyed about the ceiling here:

- **A stolen password is a full compromise.** There is no second factor.
- **An `owner` can do anything**, including deleting the audit trail's usefulness by removing users.
- **A terminal is a root shell on that host.** No firewall rule or role setting changes what someone
  with `operator` can do _after_ they open one.
- **A compromised agent is a root compromise** of the host it runs on. That is inherent to the
  design, not a misconfiguration.

Mitigate those with access control and network position, not with Aether configuration. See
[KNOWN-LIMITATIONS.md](../status/KNOWN-LIMITATIONS.md).

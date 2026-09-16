# Aether Cloud OS — VPS End-to-End Test Instructions

This runbook requires a fresh Ubuntu 22.04/24.04 x86_64 VPS with systemd, at least 2 CPU cores, 4 GB
RAM, 40 GB free disk, and ports 80/443 available. The local environment cannot validate Docker,
Caddy ACME, or external DNS.

## 1. Prepare DNS and VPS

1. Create an A record such as `cloud.example.com` pointing to the VPS public IPv4.
2. Wait for DNS propagation and confirm from your workstation:

```bash
dig +short cloud.example.com
```

3. SSH to the fresh VPS and confirm:

```bash
lsb_release -ds
uname -m
systemctl is-system-running
sudo ss -ltnp | grep -E ':(80|443)\\b' || true
df -BG /
free -m
nproc
```

## 2. Run the installer

Use the published HTTPS URL after a release is available:

```bash
curl -fsSL https://raw.githubusercontent.com/AFR-projection/Aether-OS/main/install.sh \
  | bash -s -- --domain cloud.example.com --email admin@example.com --yes
```

For a safe preflight-only check, use:

```bash
curl -fsSL https://raw.githubusercontent.com/AFR-projection/Aether-OS/main/install.sh \
  | bash -s -- --domain cloud.example.com --email admin@example.com --dry-run
```

Do not paste bootstrap tokens or `.env` contents into chat or ticket systems.

## 3. Verify service deployment

On the VPS:

```bash
sudo systemctl status aether --no-pager
cd /opt/aether
sudo docker compose ps
curl -fsS https://cloud.example.com/health
curl -fsS https://cloud.example.com/
```

All services should be healthy. Only Caddy may publish host ports:

```bash
sudo ss -ltnp
# PostgreSQL 5432, Redis 6379, and backend 3000 must not listen on the host.
```

## 4. Verify security controls

```bash
stat -c '%a' /opt/aether/.env /opt/aether/secrets/*
sudo ufw status verbose
sudo docker compose config
```

Expected permissions are `.env=600`, secret files `600`, and the secrets directory `700`. Confirm
SSH remains allowed before enabling UFW.

## 5. Verify pairing, terminal, filesystem, and processes

1. Read the one-time bootstrap token locally without sharing it:

```bash
sudo grep '^AETHER_BOOTSTRAP_TOKEN=' /opt/aether/.env
```

2. Open `https://cloud.example.com`, complete first-run bootstrap, and create the owner account.
3. Pair the desktop/host agent using the pairing flow.
4. In the desktop shell verify:
   - Terminal creates a PTY, accepts input, streams output, reconnects, and exits cleanly.
   - Files can create/read/rename/delete only inside the configured workspace.
   - Task Manager lists host processes and refuses protected PID signalling.
   - Metrics show CPU, memory, disk, and network values.

## 6. Failure and resume checks

In a disposable VPS only:

```bash
sudo cp -a /opt/aether /opt/aether.before-test
sudo systemctl stop aether
sudo aether status
sudo aether repair
sudo aether backup
sudo aether restore /opt/aether/backups/<backup>.tar.gz
```

Verify the default uninstall preserves data and `--purge` is required for permanent removal. Never
run purge on a production instance without a backup.

## 7. Report results

Record Ubuntu version, provider, instance size, installer commit, DNS result, service status, HTTPS
result, security checks, and any failed test step. This VPS validation is an external-environment
prerequisite and cannot be marked passed from the Windows development machine alone.

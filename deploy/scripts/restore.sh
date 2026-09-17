#!/usr/bin/env bash
# Aether Cloud OS — restore.
#
# Restores an archive produced by backup.sh:
#
#   aether restore /opt/aether/backups/aether-backup-20260917-101500.tar.gz
#
# Restoring replaces the database, the workspace, and the uploads. It is
# destructive and asks for confirmation unless AETHER_YES=true.
#
# The previous version of this script ran `sudo -u postgres psql` and
# `systemctl restart aether-backend`. Neither exists here: PostgreSQL runs in a
# container with no host-side `postgres` OS user, and the systemd unit is named
# `aether`, not `aether-backend`. Both were silent no-ops, so a "successful"
# restore quietly restored nothing. Everything below talks to the compose
# project instead, and verifies that it worked.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AETHER_INSTALL_DIR="${AETHER_INSTALL_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"

# shellcheck source=../lib/core.sh
source "$SCRIPT_DIR/../lib/core.sh"
# shellcheck source=../lib/utils.sh
source "$SCRIPT_DIR/../lib/utils.sh"

AETHER_BACKUP_DIR="${AETHER_BACKUP_DIR:-$AETHER_INSTALL_DIR/backups}"
COMPOSE_FILE="$AETHER_INSTALL_DIR/docker-compose.yml"
ENV_FILE="$AETHER_INSTALL_DIR/.env"
ARCHIVE_IMAGE="${AETHER_ARCHIVE_IMAGE:-postgres:16-alpine}"

# The uid/gid the backend container runs as (see packages/backend/Dockerfile).
# Files restored by a root container must be handed back to it or the backend
# cannot write to its own workspace.
AETHER_APP_UID="${AETHER_APP_UID:-1001}"
AETHER_APP_GID="${AETHER_APP_GID:-1001}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
require_deployment() {
    [ -f "$COMPOSE_FILE" ] || fatal "No deployment found at $AETHER_INSTALL_DIR (missing docker-compose.yml)."
    command_exists docker || fatal "docker is not installed."
}

compose() {
    compose_cmd -f "$COMPOSE_FILE" "$@"
}

db_user() {
    local value
    value=$(env_value POSTGRES_USER "$ENV_FILE" || true)
    printf '%s' "${value:-aether}"
}

db_name() {
    local value
    value=$(env_value POSTGRES_DB "$ENV_FILE" || true)
    printf '%s' "${value:-aether}"
}

# The workspace and uploads are host directories bind-mounted into the backend
# (see docker-compose.prod.yml), because the local host agent runs as a systemd
# service on this machine and must see the same tree. Restoring writes them back
# in place, then hands ownership to the uid the backend runs as.
AETHER_DATA_DIR="${AETHER_DATA_DIR:-$AETHER_INSTALL_DIR/data}"

# ---------------------------------------------------------------------------
# Steps
# ---------------------------------------------------------------------------

verify_archive() {
    local archive="$1" expected actual

    [ -f "$archive" ] || fatal "Backup archive not found: $archive"
    tar -tzf "$archive" >/dev/null 2>&1 || fatal "$archive is not a readable tar.gz archive."

    # `tar -tzf` only proves the gzip stream is intact, not that the archive is
    # complete — a truncated file can still list. The checksum is what makes
    # "this is the backup that was taken" a fact rather than a hope, so a
    # missing one is a failure, not a warning.
    if [ ! -f "$archive.sha256" ]; then
        if [ "${AETHER_ALLOW_UNVERIFIED:-false}" = "true" ]; then
            warn "No .sha256 beside $archive; continuing because AETHER_ALLOW_UNVERIFIED=true."
            return 0
        fi
        error "No checksum file at $archive.sha256, so the archive cannot be verified."
        error "Every archive this version writes has one. Either it was deleted, or the"
        error "file was produced by an older release (which did not write them)."
        error "To restore it anyway, re-run with: AETHER_ALLOW_UNVERIFIED=true aether restore $archive"
        exit 1
    fi

    expected=$(cut -d' ' -f1 < "$archive.sha256")
    actual=$(sha256sum "$archive" | cut -d' ' -f1)
    if [ "$expected" != "$actual" ]; then
        fatal "Checksum mismatch — $archive is corrupt or was modified. Refusing to restore."
    fi
    info "Checksum verified"
    return 0
}

confirm_restore() {
    warn "This will REPLACE the current database, workspace, and uploads."
    if ! confirm "Restore anyway?"; then
        fatal "Restore cancelled."
    fi
}

restore_database() {
    local dump="$1"
    local user db

    user=$(db_user)
    db=$(db_name)

    [ -s "$dump" ] || fatal "Archive contains no database dump."

    info "Restoring database '$db'"

    # Bring postgres up on its own first: `compose exec` needs a running target,
    # and the stack may well be down if the operator is restoring after a failure.
    compose up -d postgres
    info "Waiting for PostgreSQL to accept connections"
    local attempts=30
    until compose exec -T postgres pg_isready -U "$user" >/dev/null 2>&1; do
        attempts=$((attempts - 1))
        [ "$attempts" -gt 0 ] || fatal "PostgreSQL did not become ready."
        sleep 2
    done

    # The backend is stopped by now, so nothing holds a connection to the old
    # database and it can be dropped. Recreating rather than truncating is what
    # makes this a true restore: objects the backup does not contain — a table
    # added by a newer schema, a leftover row — cannot survive.
    compose exec -T postgres psql -U "$user" -d postgres -v ON_ERROR_STOP=1 \
        -c "DROP DATABASE IF EXISTS \"$db\";"
    compose exec -T postgres psql -U "$user" -d postgres -v ON_ERROR_STOP=1 \
        -c "CREATE DATABASE \"$db\" OWNER \"$user\";"

    if ! gunzip -c "$dump" | compose exec -T postgres psql -U "$user" -d "$db" -v ON_ERROR_STOP=1 >/dev/null; then
        fatal "Database restore failed. The database is now in a partial state — restore again or rebuild."
    fi

    info "Database restored"
}

restore_data() {
    local work_dir="$1"

    local data_archive="$work_dir/data.tar.gz"
    [ -f "$data_archive" ] || data_archive="$work_dir/volumes.tar.gz"
    [ -f "$data_archive" ] || fatal "Archive contains no workspace or uploads data."

    info "Restoring $AETHER_DATA_DIR"

    mkdir -p "$AETHER_DATA_DIR"

    # Clear before extracting: without this, files deleted since the backup was
    # taken would survive as stale leftovers and the restore would be a merge
    # rather than a rollback.
    #
    # The uid/gid are passed as environment variables so the whole script can
    # stay a single-quoted literal — interpolating them into the string would
    # mean stitching quotes together.
    if ! docker_cmd run --rm \
        -e APP_UID="$AETHER_APP_UID" \
        -e APP_GID="$AETHER_APP_GID" \
        -v "$AETHER_DATA_DIR":/dst \
        -v "$work_dir":/backup:ro \
        -e DATA_ARCHIVE="$(basename "$data_archive")" \
        "$ARCHIVE_IMAGE" \
        sh -euc '
            find /dst -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
            tar -xzf "/backup/$DATA_ARCHIVE" -C /dst
            chown -R "$APP_UID:$APP_GID" /dst
        '; then
        fatal "Data restore failed."
    fi

    info "Workspace and uploads restored"
}

restore_configuration() {
    local work_dir="$1"

    [ -d "$work_dir/config" ] || { warn "Archive contains no configuration; keeping the current one."; return 0; }

    info "Restoring configuration"

    # Keep the .env that is in place. It is almost certainly the newer one (it
    # carries the current secrets), and overwriting it with an older copy would
    # change JWT_SECRET and break every existing session, or change
    # ENCRYPTION_KEY and make stored ciphertext unreadable.
    if [ -f "$work_dir/config/.env" ]; then
        local saved="$AETHER_INSTALL_DIR/.env.pre-restore-$(date +%Y%m%d-%H%M%S)"
        cp "$ENV_FILE" "$saved"
        info "Current .env preserved at $saved (the archived .env was NOT applied)"
    fi

    if [ -f "$work_dir/config/caddy/Caddyfile" ] && [ -d "$AETHER_INSTALL_DIR/caddy" ]; then
        cp "$work_dir/config/caddy/Caddyfile" "$AETHER_INSTALL_DIR/caddy/Caddyfile"
        info "Caddyfile restored"
    fi
}

# The restored database carries the host_agents rows that were live when the
# backup was taken, so the agent on this host has to be the one those rows
# describe. Restoring the agent's own configuration is what makes the pair match
# again; without it the agent presents an id the restored database has never
# heard of and reconnects forever.
#
# instance.json and install.state are deliberately NOT restored: they describe
# the installation that is running now, and the archive's copies would be older.
restore_metadata() {
    local work_dir="$1"

    [ -d "$work_dir/metadata" ] || return 0

    local agent_dir="$AETHER_INSTALL_DIR/local-agent"

    if [ -f "$work_dir/metadata/agent.env" ] && [ -d "$agent_dir" ]; then
        cp "$work_dir/metadata/agent.env" "$agent_dir/agent.env"
        chmod 600 "$agent_dir/agent.env"
        info "Host agent configuration restored"

        if [ -f "$work_dir/metadata/local-agent.json" ]; then
            cp "$work_dir/metadata/local-agent.json" "$AETHER_INSTALL_DIR/local-agent.json"
        fi
    fi
}

# The frontend bundle is not in the archive: it is a build artifact of a
# specific commit, and restoring an old one next to a possibly-newer backend is
# the version skew the docs warn about. Rebuilding it at the current commit is
# both smaller and more correct — but it has to *happen*, because a restore onto
# a host that lost /opt/aether/static otherwise comes back with a working API
# and no UI, which the /health probe cannot see.
restore_frontend() {
    local static_dir="$AETHER_INSTALL_DIR/static"

    if [ -f "$static_dir/index.html" ]; then
        info "Frontend bundle already present; leaving it alone."
        return 0
    fi

    stage "Rebuilding the frontend bundle (not stored in backups)"
    if install_frontend_bundle; then
        return 0
    fi

    error "The frontend bundle could not be rebuilt, so the restored instance has no UI."
    error "The data is restored and the API works. Fix the build and run: aether repair"
    error "Check: aether logs --tail 100 backend"
    return 1
}

# The local agent is stopped for the duration of the restore: the backend is
# down while its database is replaced, and an agent hammering a stopped backend
# only fills the journal with reconnection noise.
agent_stop() {
    if systemctl is-active --quiet aether-host-agent 2>/dev/null; then
        $SUDO systemctl stop aether-host-agent
        AETHER_AGENT_STOPPED=true
        info "Paused the host agent"
    fi
    return 0
}

agent_start() {
    [ "${AETHER_AGENT_STOPPED:-false}" = "true" ] || return 0
    $SUDO systemctl start aether-host-agent
    info "Host agent restarted"
}

start_stack() {
    info "Starting the stack"
    compose up -d

    # The backend publishes no host port, so the probe runs inside the container;
    # checking the database too distinguishes "the app answers" from "the app
    # answers without a database", which is exactly what a bad restore looks
    # like.
    local attempts=60
    while [ "$attempts" -gt 0 ]; do
        if compose exec -T backend node -e \
            "fetch('http://127.0.0.1:3000/api/health').then(r=>r.json()).then(j=>process.exit(j.checks&&j.checks.database&&j.checks.database.ok?0:1)).catch(()=>process.exit(1))" \
            >/dev/null 2>&1; then
            info "Backend is healthy and its database is reachable"
            return 0
        fi
        attempts=$((attempts - 1))
        sleep 3
    done

    error "The backend did not report healthy within 3 minutes."
    error "Check: aether logs --tail 100 backend"
    return 1
}

# Confirms the agent came back, on both sides, after the restore. A restore that
# leaves the host unmanageable has not restored the instance.
verify_agent() {
    [ -f "$AETHER_INSTALL_DIR/local-agent.json" ] || return 0

    local agent_id attempts=20
    agent_id=$(sed -n 's/.*"agentId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
        "$AETHER_INSTALL_DIR/local-agent.json" | head -n1)
    [ -n "$agent_id" ] || return 0

    info "Waiting for the host agent to reconnect"
    while [ "$attempts" -gt 0 ]; do
        if compose logs --since 5m backend 2>/dev/null \
            | grep -q "\"agentId\":\"$agent_id\".*agent connected"; then
            info "Host agent reconnected"
            return 0
        fi
        attempts=$((attempts - 1))
        sleep 3
    done

    error "The host agent has not reconnected to the backend."
    error "Check: sudo journalctl -u aether-host-agent -n 50 --no-pager"
    return 1
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
restore_backup() {
    local archive="$1"

    stage "Restoring Aether backup"
    require_deployment
    verify_archive "$archive"
    confirm_restore

    local name work_dir
    name=$(basename "$archive" .tar.gz)
    work_dir="$AETHER_BACKUP_DIR/$name.restore"

    info "Extracting archive"
    rm -rf "$work_dir"
    mkdir -p "$work_dir"
    tar -xzf "$archive" -C "$work_dir" --strip-components=1

    # Stop the backend first so it is not writing while its database and files
    # are being replaced.
    info "Stopping the backend"
    compose stop backend

    agent_stop

    restore_database "$work_dir/database.sql.gz"
    restore_data "$work_dir"
    restore_configuration "$work_dir"
    restore_metadata "$work_dir"

    rm -rf "$work_dir"

    # Recorded rather than fatal: the agent is still stopped at this point, so
    # aborting here would leave the host unmanaged. The stack and the agent come
    # back first, then the failure is reported with the rest of the diagnostics.
    local frontend_ok=true
    restore_frontend || frontend_ok=false

    if ! start_stack; then
        agent_start
        error "Restore failed: the stack did not come back healthy."
        error "The data has been replaced. Fix the reported problem and re-run, or restore an earlier archive."
        exit 1
    fi

    agent_start

    if ! verify_agent; then
        error "Restore failed: the host agent did not reconnect."
        exit 1
    fi

    if [ "$frontend_ok" != "true" ]; then
        error "Restore finished with the frontend bundle missing — the instance has no UI."
        exit 1
    fi

    printf '\n'
    info "Restore complete."
    printf '\n'
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    if [ -z "${1:-}" ]; then
        printf 'Usage: %s <backup-archive>\n' "$0" >&2
        exit 2
    fi
    restore_backup "$1"
fi

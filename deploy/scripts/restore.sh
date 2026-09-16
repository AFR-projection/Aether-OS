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

volume_name_for() {
    local key="$1" name
    name=$(docker_cmd volume ls --format '{{.Name}}' 2>/dev/null | grep -E "_${key}\$" | head -n1 || true)
    [ -n "$name" ] || fatal "Could not find the Docker volume ending in '_${key}'."
    printf '%s' "$name"
}

# ---------------------------------------------------------------------------
# Steps
# ---------------------------------------------------------------------------

verify_archive() {
    local archive="$1" expected actual

    [ -f "$archive" ] || fatal "Backup archive not found: $archive"
    tar -tzf "$archive" >/dev/null 2>&1 || fatal "$archive is not a readable tar.gz archive."

    if [ -f "$archive.sha256" ]; then
        expected=$(cut -d' ' -f1 < "$archive.sha256")
        actual=$(sha256sum "$archive" | cut -d' ' -f1)
        if [ "$expected" != "$actual" ]; then
            fatal "Checksum mismatch — $archive is corrupt or was modified. Refusing to restore."
        fi
        info "Checksum verified"
    else
        warn "No .sha256 beside the archive; integrity not verified."
    fi
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

restore_volumes() {
    local archive="$1"
    local work_dir="$2"
    local workspace uploads

    [ -f "$work_dir/volumes.tar.gz" ] || fatal "Archive contains no volume data."

    workspace=$(volume_name_for workspace_data)
    uploads=$(volume_name_for uploads_data)

    info "Restoring workspace and uploads"

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
        -v "$workspace":/dst/workspace \
        -v "$uploads":/dst/uploads \
        -v "$work_dir":/backup:ro \
        "$ARCHIVE_IMAGE" \
        sh -euc '
            rm -rf /dst/workspace/* /dst/workspace/.[!.]* /dst/uploads/* /dst/uploads/.[!.]* 2>/dev/null || true
            tar -xzf /backup/volumes.tar.gz -C /dst
            chown -R "$APP_UID:$APP_GID" /dst/workspace /dst/uploads
        '; then
        fatal "Volume restore failed."
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

start_stack() {
    info "Starting the stack"
    compose up -d

    local attempts=60
    while [ "$attempts" -gt 0 ]; do
        if curl -sf --max-time 5 http://127.0.0.1:3000/health >/dev/null 2>&1 \
            || compose exec -T backend node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
            info "Backend is healthy"
            return 0
        fi
        attempts=$((attempts - 1))
        sleep 3
    done

    warn "Backend did not report healthy within 3 minutes. Check: aether logs backend"
    return 0
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

    restore_database "$work_dir/database.sql.gz"
    restore_volumes "$archive" "$work_dir"
    restore_configuration "$work_dir"

    rm -rf "$work_dir"
    start_stack

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

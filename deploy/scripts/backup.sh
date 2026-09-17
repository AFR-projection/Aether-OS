#!/usr/bin/env bash
# Aether Cloud OS — backup.
#
# Produces one archive containing a consistent PostgreSQL dump, the workspace
# and uploads directories, the deployment configuration, and the instance
# metadata.
#
#   <install>/backups/aether-backup-YYYYmmdd-HHMMSS.tar.gz
#   <install>/backups/aether-backup-YYYYmmdd-HHMMSS.tar.gz.sha256
#
# Every step is mandatory. An earlier version of this script looked for
# `pg_dump` on the *host* and, not finding it, logged a warning and carried on.
# On a Docker deployment PostgreSQL lives in a container on an `internal: true`
# network with no published port, so that path can never work — it produced an
# archive with no database in it while still printing "Backup created
# successfully". The same script then found no workspace directory (the data is
# in a named volume, not at the path it checked) and skipped that too. A backup
# that silently omits the data is worse than no backup, because it is trusted.
# This script fails hard instead of skipping.
#
# Redis is deliberately not backed up: it holds WebSocket tickets and rate-limit
# counters, all of which are reconstructible. Losing it loses nothing.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The installer copies this to <install>/scripts, beside <install>/lib. Deriving
# the install directory from the script's own location means `aether backup`
# works no matter which directory it was invoked from.
AETHER_INSTALL_DIR="${AETHER_INSTALL_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"

# shellcheck source=../lib/core.sh
source "$SCRIPT_DIR/../lib/core.sh"
# shellcheck source=../lib/utils.sh
source "$SCRIPT_DIR/../lib/utils.sh"

AETHER_BACKUP_DIR="${AETHER_BACKUP_DIR:-$AETHER_INSTALL_DIR/backups}"
AETHER_BACKUP_RETENTION_DAYS="${AETHER_BACKUP_RETENTION_DAYS:-30}"
COMPOSE_FILE="$AETHER_INSTALL_DIR/docker-compose.yml"
ENV_FILE="$AETHER_INSTALL_DIR/.env"

# The image used to archive the data volumes. Any image with `tar` will do, and
# the postgres image is guaranteed to be present on a deployed host — unlike
# `alpine`, which would have to be pulled.
ARCHIVE_IMAGE="${AETHER_ARCHIVE_IMAGE:-postgres:16-alpine}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Fails with a readable message if this is not a deployed instance.
require_deployment() {
    [ -f "$COMPOSE_FILE" ] || fatal "No deployment found at $AETHER_INSTALL_DIR (missing docker-compose.yml)."
    [ -f "$ENV_FILE" ] || fatal "No .env found at $ENV_FILE."
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
# container, not named volumes. They have to be: the local host agent runs as a
# systemd service on this machine and must see exactly the same tree the
# backend serves, and a named volume is invisible from the host.
AETHER_DATA_DIR="$AETHER_INSTALL_DIR/data"

# ---------------------------------------------------------------------------
# Steps
# ---------------------------------------------------------------------------

backup_database() {
    local target="$1"
    local user db

    user=$(db_user)
    db=$(db_name)

    info "Dumping database '$db' (role '$user') from the postgres container"

    # `-T` disables TTY allocation so the dump can be piped. pg_dump runs inside
    # the container, so no PostgreSQL client is needed on the host and the
    # database never has to be reachable from outside the compose network.
    if ! compose exec -T postgres pg_dump -U "$user" -d "$db" --no-owner --no-privileges | gzip > "$target"; then
        fatal "pg_dump failed — the backup is incomplete. Partial file left at $target for inspection."
    fi

    # A pipeline can succeed while producing nothing usable, so check the
    # result rather than trusting the exit status alone.
    [ -s "$target" ] || fatal "The database dump is empty. Refusing to write a backup without a database."
    gzip -t "$target" 2>/dev/null || fatal "The database dump is not valid gzip. Refusing to continue."

    info "Database dump written: $(du -h "$target" | cut -f1)"
}

backup_data() {
    local target="$1"

    [ -d "$AETHER_DATA_DIR" ] || fatal "No data directory at $AETHER_DATA_DIR. Is the stack deployed?"

    info "Archiving $AETHER_DATA_DIR (workspace, uploads)"

    # A throwaway container rather than `compose exec backend tar`: this works
    # even while the backend is stopped or crash-looping, which is exactly when
    # someone reaches for a backup. tar runs as root inside the container so
    # every file is readable regardless of the uid that owns it on the host.
    if ! docker_cmd run --rm \
        -v "$AETHER_DATA_DIR":/src:ro \
        -v "$(dirname "$target")":/backup \
        "$ARCHIVE_IMAGE" \
        tar -czf "/backup/$(basename "$target")" -C /src .; then
        fatal "Failed to archive the data directory."
    fi

    [ -s "$target" ] || fatal "The data archive is empty."
    info "Data archive written: $(du -h "$target" | cut -f1)"
}

# The small files that make a restore reproduce *this* instance rather than a
# generic one: the instance id, which installer stages had completed, the local
# agent's record, and the agent's own configuration (which holds its pairing
# token, so the restored host reconnects without being paired again).
backup_metadata() {
    local target="$1"

    info "Copying instance metadata"
    mkdir -p "$target/metadata"

    local file
    for file in instance.json install.state local-agent.json; do
        if [ -f "$AETHER_INSTALL_DIR/$file" ]; then
            cp "$AETHER_INSTALL_DIR/$file" "$target/metadata/$file"
        fi
    done

    if [ -f "$AETHER_INSTALL_DIR/local-agent/agent.env" ]; then
        cp "$AETHER_INSTALL_DIR/local-agent/agent.env" "$target/metadata/agent.env"
    fi

    chmod -R go-rwx "$target/metadata"
}

backup_configuration() {
    local target="$1"

    info "Copying deployment configuration"

    mkdir -p "$target/config"
    # `.env` holds JWT_SECRET and ENCRYPTION_KEY. It is copied because a restore
    # without it cannot decrypt data written by this instance, but that also
    # makes every backup archive a secret: protect it accordingly.
    cp "$ENV_FILE" "$target/config/.env"
    cp "$COMPOSE_FILE" "$target/config/docker-compose.yml"

    if [ -d "$AETHER_INSTALL_DIR/caddy" ]; then
        cp -r "$AETHER_INSTALL_DIR/caddy" "$target/config/caddy"
    fi

    chmod -R go-rwx "$target/config"
}

create_archive() {
    local work_dir="$1" name="$2"
    local archive="$AETHER_BACKUP_DIR/$name.tar.gz"

    info "Compressing archive"
    tar -czf "$archive" -C "$AETHER_BACKUP_DIR" "$name"
    rm -rf "$work_dir"

    # A checksum so a restore can tell a truncated archive from a good one —
    # `tar -tzf` only proves the gzip stream is intact, not that it is complete.
    ( cd "$AETHER_BACKUP_DIR" && sha256sum "$(basename "$archive")" > "$(basename "$archive").sha256" )

    printf '%s' "$archive"
}

clean_old_backups() {
    local days="$AETHER_BACKUP_RETENTION_DAYS"

    [ "$days" -gt 0 ] 2>/dev/null || return 0

    info "Removing backups older than $days days"
    find "$AETHER_BACKUP_DIR" -maxdepth 1 -name 'aether-backup-*' -mtime "+$days" -delete 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
create_backup() {
    stage "Creating Aether backup"
    require_deployment

    local name work_dir archive
    name="aether-backup-$(date +%Y%m%d-%H%M%S)"
    work_dir="$AETHER_BACKUP_DIR/$name"

    create_directory "$AETHER_BACKUP_DIR"
    create_directory "$work_dir"

    backup_database "$work_dir/database.sql.gz"
    backup_data "$work_dir/data.tar.gz"
    backup_configuration "$work_dir"
    backup_metadata "$work_dir"

    archive=$(create_archive "$work_dir" "$name")
    clean_old_backups

    printf '\n'
    info "Backup complete: $archive"
    printf '\n'
    printf '  Restore it with:\n'
    printf '    aether restore %s\n\n' "$archive"
}

list_backups() {
    require_deployment

    [ -d "$AETHER_BACKUP_DIR" ] || fatal "No backup directory at $AETHER_BACKUP_DIR."

    local found=false
    printf '%-46s %-10s %s\n' 'ARCHIVE' 'SIZE' 'CREATED'
    while IFS= read -r archive; do
        [ -n "$archive" ] || continue
        found=true
        printf '%-46s %-10s %s\n' "$(basename "$archive")" \
            "$(du -h "$archive" | cut -f1)" "$(date -r "$archive" '+%Y-%m-%d %H:%M:%S')"
    done < <(ls -1t "$AETHER_BACKUP_DIR"/aether-backup-*.tar.gz 2>/dev/null || true)

    [ "$found" = true ] || printf '(no archives)\n'
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    case "${1:-create}" in
        list) list_backups ;;
        create|'') create_backup ;;
        -h|--help)
            printf 'Usage: %s [create|list]\n' "$0"
            ;;
        *) fatal "Unknown backup subcommand: $1 (expected 'create' or 'list')" ;;
    esac
fi

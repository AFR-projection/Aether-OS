#!/usr/bin/env bash
# Aether Cloud OS — backup.
#
# Produces one archive containing a consistent PostgreSQL dump, the workspace
# and uploads volumes, and the deployment configuration.
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

# Resolves a compose volume key (`workspace_data`) to the real Docker volume
# name. Compose prefixes the key with the project name — `aether_workspace_data`
# — but resolving it rather than assuming keeps this working if the project is
# renamed.
volume_name_for() {
    local key="$1" name
    name=$(docker_cmd volume ls --format '{{.Name}}' 2>/dev/null | grep -E "_${key}\$" | head -n1 || true)
    [ -n "$name" ] || fatal "Could not find the Docker volume ending in '_${key}'. Is the stack deployed?"
    printf '%s' "$name"
}

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

backup_volumes() {
    local target="$1"
    local workspace uploads

    workspace=$(volume_name_for workspace_data)
    uploads=$(volume_name_for uploads_data)

    info "Archiving data volumes ($workspace, $uploads)"

    # A throwaway container rather than `compose exec backend tar`: this works
    # even while the backend is stopped or crash-looping, which is exactly when
    # someone reaches for a backup.
    if ! docker_cmd run --rm \
        -v "$workspace":/src/workspace:ro \
        -v "$uploads":/src/uploads:ro \
        -v "$(dirname "$target")":/backup \
        "$ARCHIVE_IMAGE" \
        tar -czf "/backup/$(basename "$target")" -C /src .; then
        fatal "Failed to archive the data volumes."
    fi

    [ -s "$target" ] || fatal "The volume archive is empty."
    info "Volume archive written: $(du -h "$target" | cut -f1)"
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
    backup_volumes "$work_dir/volumes.tar.gz"
    backup_configuration "$work_dir"

    archive=$(create_archive "$work_dir" "$name")
    clean_old_backups

    printf '\n'
    info "Backup complete: $archive"
    printf '\n'
    printf '  Restore it with:\n'
    printf '    aether restore %s\n\n' "$archive"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    create_backup
fi

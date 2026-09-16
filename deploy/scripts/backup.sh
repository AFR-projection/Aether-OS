#!/usr/bin/env bash
# Aether Cloud OS — backup script.
#
# Creates backups of the Aether Cloud OS installation, including database,
# configuration, and workspace data.

set -euo pipefail

# Source utility functions
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/../lib/core.sh"
source "$SCRIPT_DIR/../lib/utils.sh"

# Default configuration
AETHER_BACKUP_DIR="${AETHER_BACKUP_DIR:-/opt/aether/backups}"
AETHER_INSTALL_DIR="${AETHER_INSTALL_DIR:-/opt/aether}"
AETHER_WORKSPACE_DIR="${AETHER_WORKSPACE_DIR:-/opt/aether/workspace}"
AETHER_LOG_RETENTION_DAYS="${AETHER_LOG_RETENTION_DAYS:-30}"

# ---------------------------------------------------------------------------
# Backup functions
# ---------------------------------------------------------------------------
create_backup() {
    stage "Creating Aether backup"

    local backup_name="aether-backup-$(date +%Y%m%d-%H%M%S)"
    local backup_path="$AETHER_BACKUP_DIR/$backup_name"

    # Create backup directory
    create_directory "$backup_path"

    # Backup database
    backup_database "$backup_path"

    # Backup configuration
    backup_configuration "$backup_path"

    # Backup workspace
    backup_workspace "$backup_path"

    # Create backup archive
    create_backup_archive "$backup_path" "$backup_name"

    # Clean old backups
    clean_old_backups

    info "Backup created successfully: $backup_path"
}

backup_database() {
    local backup_path="$1"
    local db_backup_file="$backup_path/database.sql.gz"

    info "Backing up database"

    if ! command -v pg_dump &> /dev/null; then
        warn "pg_dump not found, skipping database backup"
        return
    fi

    # Get database credentials from environment
    local db_host="${AETHER_DB_HOST:-localhost}"
    local db_port="${AETHER_DB_PORT:-5432}"
    local db_user="${AETHER_DB_USER:-aether}"
    local db_name="${AETHER_DB_NAME:-aether}"

    pg_dump -h "$db_host" -p "$db_port" -U "$db_user" -d "$db_name" | gzip > "$db_backup_file"
    info "Database backup created: $db_backup_file"
}

backup_configuration() {
    local backup_path="$1"
    local config_backup_dir="$backup_path/config"

    info "Backing up configuration"

    create_directory "$config_backup_dir"

    # Backup .env files
    if [ -f "$AETHER_INSTALL_DIR/.env" ]; then
        cp "$AETHER_INSTALL_DIR/.env" "$config_backup_dir/"
    fi

    # Backup docker-compose files
    if [ -f "$AETHER_INSTALL_DIR/docker-compose.prod.yml" ]; then
        cp "$AETHER_INSTALL_DIR/docker-compose.prod.yml" "$config_backup_dir/"
    fi

    info "Configuration backup created"
}

backup_workspace() {
    local backup_path="$1"
    local workspace_backup_file="$backup_path/workspace.tar.gz"

    info "Backing up workspace"

    if [ -d "$AETHER_WORKSPACE_DIR" ]; then
        tar -czf "$workspace_backup_file" -C "$(dirname "$AETHER_WORKSPACE_DIR")" "$(basename "$AETHER_WORKSPACE_DIR")"
        info "Workspace backup created: $workspace_backup_file"
    else
        warn "Workspace directory not found: $AETHER_WORKSPACE_DIR"
    fi
}

create_backup_archive() {
    local backup_path="$1"
    local backup_name="$2"
    local archive_path="$AETHER_BACKUP_DIR/$backup_name.tar.gz"

    info "Creating backup archive"
    tar -czf "$archive_path" -C "$AETHER_BACKUP_DIR" "$backup_name"
    rm -rf "$backup_path"

    info "Backup archive created: $archive_path"
}

clean_old_backups() {
    info "Cleaning old backups (older than $AETHER_LOG_RETENTION_DAYS days)"

    find "$AETHER_BACKUP_DIR" -name "aether-backup-*" -type d -mtime +$AETHER_LOG_RETENTION_DAYS -exec rm -rf {} \;
    find "$AETHER_BACKUP_DIR" -name "aether-backup-*.tar.gz" -type f -mtime +$AETHER_LOG_RETENTION_DAYS -exec rm -f {} \;

    info "Old backups cleaned"
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if [ "$0" = "$BASH_SOURCE" ]; then
    create_backup
fi

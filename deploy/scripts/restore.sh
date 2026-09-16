#!/usr/bin/env bash
# Aether Cloud OS — restore script.
#
# Restores the Aether Cloud OS installation from a backup.

set -euo pipefail

# Source utility functions
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/../lib/core.sh"
source "$SCRIPT_DIR/../lib/utils.sh"

# Default configuration
AETHER_BACKUP_DIR="${AETHER_BACKUP_DIR:-/opt/aether/backups}"
AETHER_INSTALL_DIR="${AETHER_INSTALL_DIR:-/opt/aether}"
AETHER_WORKSPACE_DIR="${AETHER_WORKSPACE_DIR:-/opt/aether/workspace}"

# ---------------------------------------------------------------------------
# Restore functions
# ---------------------------------------------------------------------------
restore_backup() {
    local backup_archive="$1"

    stage "Restoring Aether backup"

    if [ ! -f "$backup_archive" ]; then
        fatal "Backup archive not found: $backup_archive"
    fi

    local backup_name
    backup_name=$(basename "$backup_archive" .tar.gz)
    local restore_dir="$AETHER_BACKUP_DIR/$backup_name"

    # Extract backup archive
    info "Extracting backup archive"
    tar -xzf "$backup_archive" -C "$AETHER_BACKUP_DIR"

    # Restore database
    restore_database "$restore_dir"

    # Restore configuration
    restore_configuration "$restore_dir"

    # Restore workspace
    restore_workspace "$restore_dir"

    # Cleanup
    info "Cleaning up extracted backup"
    rm -rf "$restore_dir"

    # Restart services
    info "Restarting services"
    restart_services

    info "Backup restored successfully from: $backup_archive"
}

restore_database() {
    local restore_dir="$1"
    local db_backup_file="$restore_dir/database.sql.gz"

    info "Restoring database"

    if [ ! -f "$db_backup_file" ]; then
        warn "No database backup found, skipping database restore"
        return
    fi

    if ! command -v psql &> /dev/null; then
        warn "psql not found, skipping database restore"
        return
    fi

    # Get database credentials from environment
    local db_host="${AETHER_DB_HOST:-localhost}"
    local db_port="${AETHER_DB_PORT:-5432}"
    local db_user="${AETHER_DB_USER:-aether}"
    local db_name="${AETHER_DB_NAME:-aether}"

    # Drop and recreate database
    sudo -u postgres psql -c "DROP DATABASE IF EXISTS $db_name;"
    sudo -u postgres psql -c "CREATE DATABASE $db_name OWNER $db_user;"

    # Restore from backup
    gunzip -c "$db_backup_file" | psql -h "$db_host" -p "$db_port" -U "$db_user" -d "$db_name"
    info "Database restored successfully"
}

restore_configuration() {
    local restore_dir="$1"
    local config_backup_dir="$restore_dir/config"

    info "Restoring configuration"

    if [ ! -d "$config_backup_dir" ]; then
        warn "No configuration backup found, skipping configuration restore"
        return
    fi

    # Restore .env files
    if [ -f "$config_backup_dir/.env" ]; then
        cp "$config_backup_dir/.env" "$AETHER_INSTALL_DIR/"
    fi

    # Restore docker-compose files
    if [ -f "$config_backup_dir/docker-compose.prod.yml" ]; then
        cp "$config_backup_dir/docker-compose.prod.yml" "$AETHER_INSTALL_DIR/"
    fi

    info "Configuration restored successfully"
}

restore_workspace() {
    local restore_dir="$1"
    local workspace_backup_file="$restore_dir/workspace.tar.gz"

    info "Restoring workspace"

    if [ ! -f "$workspace_backup_file" ]; then
        warn "No workspace backup found, skipping workspace restore"
        return
    fi

    # Backup current workspace
    if [ -d "$AETHER_WORKSPACE_DIR" ]; then
        local backup_name="workspace-backup-$(date +%Y%m%d-%H%M%S)"
        mv "$AETHER_WORKSPACE_DIR" "$AETHER_BACKUP_DIR/$backup_name"
        info "Current workspace backed up to: $AETHER_BACKUP_DIR/$backup_name"
    fi

    # Restore workspace
    tar -xzf "$workspace_backup_file" -C "$(dirname "$AETHER_WORKSPACE_DIR")"
    info "Workspace restored successfully"
}

restart_services() {
    info "Restarting Aether services"

    # Restart backend service
    if systemctl is-active --quiet aether-backend; then
        sudo systemctl restart aether-backend
        info "Backend service restarted"
    fi

    # Restart host agent service
    if systemctl is-active --quiet aether-host-agent; then
        sudo systemctl restart aether-host-agent
        info "Host agent service restarted"
    fi

    info "Services restarted successfully"
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if [ "$0" = "$BASH_SOURCE" ]; then
    if [ -z "${1:-}" ]; then
        echo "Usage: $0 <backup-archive>"
        exit 1
    fi
    restore_backup "$1"
fi

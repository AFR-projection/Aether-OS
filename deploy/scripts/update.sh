#!/usr/bin/env bash
# Aether Cloud OS — update script.
#
# Updates the Aether Cloud OS installation to the latest version.

set -euo pipefail

# Source utility functions
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/../lib/core.sh"
source "$SCRIPT_DIR/../lib/utils.sh"

# Default configuration
AETHER_INSTALL_DIR="${AETHER_INSTALL_DIR:-/opt/aether}"
AETHER_WORKSPACE_DIR="${AETHER_WORKSPACE_DIR:-/opt/aether/workspace}"

# ---------------------------------------------------------------------------
# Update functions
# ---------------------------------------------------------------------------
update_aether() {
    stage "Updating Aether Cloud OS"

    # Check for updates
    info "Checking for updates"
    check_for_updates

    # Backup current installation
    info "Backing up current installation"
    backup_current_installation

    # Update backend
    info "Updating backend"
    update_backend

    # Update frontend
    info "Updating frontend"
    update_frontend

    # Update host agent
    info "Updating host agent"
    update_host_agent

    # Restart services
    info "Restarting services"
    restart_services

    info "Aether Cloud OS updated successfully"
}

check_for_updates() {
    info "Checking for updates"

    # Check if git is available
    if ! command -v git &> /dev/null; then
        warn "Git not found, skipping update check"
        return
    fi

    # Check if the repository is up to date
    cd "$AETHER_INSTALL_DIR"
    local current_commit
    current_commit=$(git rev-parse HEAD)
    local remote_commit
    remote_commit=$(git rev-parse @{u})

    if [ "$current_commit" = "$remote_commit" ]; then
        info "Already up to date"
        exit 0
    fi

    info "Update available"
    cd - > /dev/null
}

backup_current_installation() {
    info "Backing up current installation"

    # Create backup directory
    local backup_dir="/opt/aether-backups"
    mkdir -p "$backup_dir"

    # Backup current installation
    local backup_name="aether-backup-$(date +%Y%m%d-%H%M%S)"
    tar -czf "$backup_dir/$backup_name.tar.gz" -C "$(dirname "$AETHER_INSTALL_DIR")" "$(basename "$AETHER_INSTALL_DIR")"

    info "Current installation backed up to: $backup_dir/$backup_name.tar.gz"
}

update_backend() {
    info "Updating backend"

    cd "$AETHER_INSTALL_DIR"
    git pull origin main
    cd - > /dev/null
}

update_frontend() {
    info "Updating frontend"

    cd "$AETHER_INSTALL_DIR/packages/frontend"
    pnpm install
    pnpm build
    cd - > /dev/null
}

update_host_agent() {
    info "Updating host agent"

    cd "$AETHER_INSTALL_DIR/packages/host-agent"
    pnpm install
    cd - > /dev/null
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
    update_aether
fi

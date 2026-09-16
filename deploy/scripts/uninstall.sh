#!/usr/bin/env bash
# Aether Cloud OS — uninstall script.
#
# Removes the Aether Cloud OS installation, including all services,
# configuration, and data.

set -euo pipefail

# Source utility functions
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/../lib/core.sh"
source "$SCRIPT_DIR/../lib/utils.sh"

# Default configuration
AETHER_INSTALL_DIR="${AETHER_INSTALL_DIR:-/opt/aether}"
AETHER_PURGE=false

for arg in "$@"; do
    case "$arg" in
        --purge) AETHER_PURGE=true ;;
        --help)
            printf '%s\n' "Usage: $0 [--purge]"
            exit 0
            ;;
        *) fatal "Unknown uninstall option: $arg" ;;
    esac
done

export AETHER_PURGE
AETHER_WORKSPACE_DIR="${AETHER_WORKSPACE_DIR:-/opt/aether/workspace}"
AETHER_UPLOADS_DIR="${AETHER_UPLOADS_DIR:-/opt/aether/uploads}"
AETHER_LOG_DIR="${AETHER_LOG_DIR:-/var/log/aether}"

# ---------------------------------------------------------------------------
# Uninstall functions
# ---------------------------------------------------------------------------
uninstall_aether() {
    stage "Uninstalling Aether Cloud OS"

    if [ "$AETHER_PURGE" = true ]; then
        confirm "Purge Aether Cloud OS and permanently delete all data?" || exit 0
    else
        confirm "Uninstall Aether Cloud OS while preserving data, logs, and backups?" || exit 0
    fi

    info "Stopping services"
    stop_services
    info "Removing systemd services"
    remove_systemd_services
    info "Removing Docker resources"
    remove_docker_resources

    if [ "$AETHER_PURGE" = true ]; then
        remove_directory "$AETHER_INSTALL_DIR"
        remove_directory "$AETHER_WORKSPACE_DIR"
        remove_directory "$AETHER_UPLOADS_DIR"
        remove_directory "$AETHER_LOG_DIR"
    else
        # Preserve user data and diagnostics. Remove only runtime source files.
        backup_configuration_before_uninstall
        rm -rf "$AETHER_INSTALL_DIR/src" "$AETHER_INSTALL_DIR/static" \
            "$AETHER_INSTALL_DIR/caddy" "$AETHER_INSTALL_DIR/docker-compose.yml" \
            "$AETHER_INSTALL_DIR/packages" "$AETHER_INSTALL_DIR/deploy"
        info "Application files removed; data, logs, backups, and secrets preserved at $AETHER_INSTALL_DIR"
    fi

    info "Aether Cloud OS uninstalled successfully"
}

backup_configuration_before_uninstall() {
    local destination="$AETHER_INSTALL_DIR/backups/uninstall-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$destination"
    [ -f "$AETHER_INSTALL_DIR/.env" ] && cp "$AETHER_INSTALL_DIR/.env" "$destination/"
    [ -d "$AETHER_INSTALL_DIR/secrets" ] && cp -a "$AETHER_INSTALL_DIR/secrets" "$destination/"
    info "Configuration backed up to $destination"
}

stop_services() {
    info "Stopping Aether services"

    # Stop backend service
    if systemctl is-active --quiet aether-backend; then
        sudo systemctl stop aether-backend
        info "Backend service stopped"
    fi

    # Stop host agent service
    if systemctl is-active --quiet aether-host-agent; then
        sudo systemctl stop aether-host-agent
        info "Host agent service stopped"
    fi

    info "Services stopped successfully"
}

remove_systemd_services() {
    info "Removing systemd services"

    local services=("aether-backend" "aether-host-agent" "aether")

    for service in "${services[@]}"; do
        local service_file="/etc/systemd/system/$service.service"
        if [ -f "$service_file" ]; then
            sudo systemctl disable "$service"
            sudo rm -f "$service_file"
            info "Removed systemd service: $service"
        fi
    done

    sudo systemctl daemon-reload
    info "Systemd services removed successfully"
}

remove_docker_resources() {
    info "Removing Docker resources"

    if [ -f "$AETHER_INSTALL_DIR/docker-compose.yml" ]; then
        cd "$AETHER_INSTALL_DIR"
        if [ "$AETHER_PURGE" = true ]; then
            sudo docker compose -f docker-compose.yml down -v
        else
            sudo docker compose -f docker-compose.yml down
        fi
        cd - > /dev/null
    fi

    info "Docker resources removed successfully"
}

remove_directory() {
    local dir="$1"
    if [ -d "$dir" ]; then
        info "Removing directory: $dir"
        sudo rm -rf "$dir"
        info "Directory removed: $dir"
    else
        info "Directory does not exist: $dir"
    fi
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if [ "$0" = "$BASH_SOURCE" ]; then
    uninstall_aether
fi

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
AETHER_WORKSPACE_DIR="${AETHER_WORKSPACE_DIR:-/opt/aether/workspace}"
AETHER_UPLOADS_DIR="${AETHER_UPLOADS_DIR:-/opt/aether/uploads}"
AETHER_LOG_DIR="${AETHER_LOG_DIR:-/var/log/aether}"

# ---------------------------------------------------------------------------
# Uninstall functions
# ---------------------------------------------------------------------------
uninstall_aether() {
    stage "Uninstalling Aether Cloud OS"

    # Confirm uninstall
    confirm "Are you sure you want to uninstall Aether Cloud OS? This will remove all data." || exit 0

    # Stop services
    info "Stopping services"
    stop_services

    # Remove systemd services
    info "Removing systemd services"
    remove_systemd_services

    # Remove Docker containers and volumes
    info "Removing Docker containers and volumes"
    remove_docker_resources

    # Remove installation directory
    info "Removing installation directory"
    remove_directory "$AETHER_INSTALL_DIR"

    # Remove workspace directory
    info "Removing workspace directory"
    remove_directory "$AETHER_WORKSPACE_DIR"

    # Remove uploads directory
    info "Removing uploads directory"
    remove_directory "$AETHER_UPLOADS_DIR"

    # Remove log directory
    info "Removing log directory"
    remove_directory "$AETHER_LOG_DIR"

    info "Aether Cloud OS uninstalled successfully"
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

    if [ -f "$AETHER_INSTALL_DIR/docker-compose.prod.yml" ]; then
        cd "$AETHER_INSTALL_DIR"
        sudo docker compose -f docker-compose.prod.yml down -v
        cd - > /dev/null
    fi

    # Remove any dangling images
    sudo docker image prune -f

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

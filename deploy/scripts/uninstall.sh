#!/usr/bin/env bash
# Aether Cloud OS — uninstall script.
#
# Default behaviour removes the Aether runtime (containers, management CLI,
# systemd units) and KEEPS your data: the database volume, the workspace and
# uploads directories, secrets, configuration, and backups. Reinstalling later
# picks up where you left off.
#
# `--purge` additionally deletes all of that, and asks before doing it.
#
# Nothing outside Aether's own resources is touched: only the compose project
# defined by this installation's docker-compose.yml, and only the two systemd
# units Aether installs.

set -euo pipefail

# Source utility functions
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/../lib/core.sh"
source "$SCRIPT_DIR/../lib/utils.sh"

# Default configuration
AETHER_INSTALL_DIR="${AETHER_INSTALL_DIR:-/opt/aether}"
AETHER_PURGE=false
AETHER_YES="${AETHER_YES:-false}"

for arg in "$@"; do
    case "$arg" in
        --purge) AETHER_PURGE=true ;;
        --yes|-y) AETHER_YES=true ;;
        --help)
            printf '%s\n' "Usage: $0 [--purge] [--yes]"
            printf '%s\n' "  (default)  remove the runtime, keep data, secrets, and backups"
            printf '%s\n' "  --purge    also delete data, secrets, and backups (asks first)"
            printf '%s\n' "  --yes      do not prompt (for --purge, also answers the confirmation)"
            exit 0
            ;;
        *) fatal "Unknown uninstall option: $arg" ;;
    esac
done

export AETHER_PURGE

COMPOSE_FILE="$AETHER_INSTALL_DIR/docker-compose.yml"
AGENT_SERVICE="aether-host-agent"
AGENT_INSTALL_DIR="$AETHER_INSTALL_DIR/local-agent"

compose() { compose_cmd -f "$COMPOSE_FILE" "$@"; }

# ---------------------------------------------------------------------------
# Systemd
# ---------------------------------------------------------------------------
stop_services() {
    # Only the units Aether installs. `aether.service` brings the compose stack
    # up at boot; the host agent is its own unit. There is no aether-backend
    # unit — the backend is a container.
    local unit units
    units=$(systemctl list-unit-files 2>/dev/null || true)
    for unit in aether "$AGENT_SERVICE"; do
        if matches "$units" "^${unit}\.service"; then
            $SUDO systemctl stop "$unit" 2>/dev/null || true
            info "Stopped $unit.service"
        fi
    done
}

remove_systemd_services() {
    local unit
    for unit in aether "$AGENT_SERVICE"; do
        if [ -f "/etc/systemd/system/${unit}.service" ]; then
            $SUDO systemctl disable "$unit" 2>/dev/null || true
            $SUDO rm -f "/etc/systemd/system/${unit}.service"
            info "Removed /etc/systemd/system/${unit}.service"
        fi
    done

    $SUDO systemctl daemon-reload 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Docker
# ---------------------------------------------------------------------------
remove_docker_resources() {
    if [ ! -f "$COMPOSE_FILE" ]; then
        info "No docker-compose.yml at $AETHER_INSTALL_DIR — nothing to bring down"
        return
    fi

    if [ "$AETHER_PURGE" = true ]; then
        # -v drops this project's named volumes (database, redis, caddy state);
        # --rmi local drops images Compose built here. Both are scoped to the
        # project in this file.
        compose down -v --rmi local --remove-orphans 2>/dev/null \
            || warn "docker compose down reported an error; containers may already be gone"
        info "Containers, volumes, and locally built images removed"
    else
        compose down --remove-orphans 2>/dev/null \
            || warn "docker compose down reported an error; containers may already be gone"
        info "Containers removed; volumes and host data kept"
    fi
}

# ---------------------------------------------------------------------------
# Files
# ---------------------------------------------------------------------------
remove_cli() {
    if [ -L /usr/local/bin/aether ]; then
        $SUDO rm -f /usr/local/bin/aether
        info "Removed /usr/local/bin/aether"
    elif [ -f /usr/local/bin/aether ]; then
        warn "/usr/local/bin/aether is a regular file, not the symlink this installer creates; leaving it alone."
    fi
}

backup_configuration_before_uninstall() {
    local destination="$AETHER_INSTALL_DIR/backups/uninstall-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$destination"
    [ -f "$AETHER_INSTALL_DIR/.env" ] && cp "$AETHER_INSTALL_DIR/.env" "$destination/"
    [ -d "$AETHER_INSTALL_DIR/secrets" ] && cp -a "$AETHER_INSTALL_DIR/secrets" "$destination/"
    chmod -R go-rwx "$destination" 2>/dev/null || true
    info "Configuration backed up to $destination"
}

# Everything the installer created that is not data. Left behind by a plain
# uninstall: .env, instance.json, install.state, secrets/, data/, backups/,
# and local-agent/ (the agent's identity, so a reinstall reuses the same pair).
remove_runtime_files() {
    local target
    # `deploy`, `packages`, and `src/docker-compose.frontend.yml` are not part of
    # the current layout: they are leftovers from installs that mirrored the
    # compose file's repo-root paths with symlinks, and are removed here so an
    # upgraded host does not end up with both layouts side by side.
    for target in src static static.new static.old caddy deploy packages \
        docker-compose.yml src/docker-compose.frontend.yml scripts lib state; do
        if [ -e "$AETHER_INSTALL_DIR/$target" ] || [ -L "$AETHER_INSTALL_DIR/$target" ]; then
            $SUDO rm -rf "${AETHER_INSTALL_DIR:?}/$target"
            info "Removed $AETHER_INSTALL_DIR/$target"
        fi
    done
}

remove_directory() {
    local dir="$1"
    if [ -d "$dir" ]; then
        info "Removing directory: $dir"
        $SUDO rm -rf "$dir"
        info "Directory removed: $dir"
    else
        info "Directory does not exist: $dir"
    fi
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
uninstall_aether() {
    stage "Uninstalling Aether Cloud OS"

    if [ "$AETHER_PURGE" = true ]; then
        if [ "$AETHER_YES" != "true" ]; then
            confirm "Purge Aether Cloud OS and permanently delete all data, secrets, and backups?" || {
                info "Aborted; nothing was removed."
                exit 0
            }
        fi
    elif [ "$AETHER_YES" != "true" ]; then
        confirm "Uninstall Aether Cloud OS while preserving data, secrets, and backups?" || {
            info "Aborted; nothing was removed."
            exit 0
        }
    fi

    stop_services
    remove_systemd_services
    remove_docker_resources
    remove_cli

    if [ "$AETHER_PURGE" = true ]; then
        remove_directory "$AETHER_INSTALL_DIR"
        info "Purged. Everything Aether Cloud OS created is gone."
    else
        backup_configuration_before_uninstall
        remove_runtime_files
        printf '\n'
        info "Application files removed. Kept at $AETHER_INSTALL_DIR:"
        info "  data/          workspace and uploads"
        info "  backups/       backup archives"
        info "  secrets/       generated secrets"
        info "  .env           configuration"
        info "  local-agent/   the host agent's identity"
        printf '\n'
        info "Reinstall with the one-line command to pick these up again, or delete"
        info "$AETHER_INSTALL_DIR yourself for a clean slate."
    fi

    info "Aether Cloud OS uninstalled"
}

if [ "$0" = "$BASH_SOURCE" ]; then
    uninstall_aether
fi

#!/usr/bin/env bash
# Aether Cloud OS — workspace setup.
#
# Sets up the workspace environment, including directory structure,
# permissions, and initial configuration.

set -euo pipefail

# Source utility functions
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/../lib/core.sh"
source "$SCRIPT_DIR/../lib/utils.sh"

# Default configuration
AETHER_WORKSPACE_DIR="${AETHER_WORKSPACE_DIR:-/opt/aether/workspace}"
AETHER_UPLOADS_DIR="${AETHER_UPLOADS_DIR:-/opt/aether/uploads}"
AETHER_LOG_DIR="${AETHER_LOG_DIR:-/var/log/aether}"

# ---------------------------------------------------------------------------
# Workspace setup
# ---------------------------------------------------------------------------
setup_workspace() {
    stage "Setting up Aether workspace"
    info "Workspace directory: $AETHER_WORKSPACE_DIR"
    info "Uploads directory: $AETHER_UPLOADS_DIR"
    info "Log directory: $AETHER_LOG_DIR"

    # Create directories
    create_directory "$AETHER_WORKSPACE_DIR"
    create_directory "$AETHER_UPLOADS_DIR"
    create_directory "$AETHER_LOG_DIR"

    # Set permissions
    set_permissions

    # Create initial configuration
    create_initial_config

    info "Workspace setup completed successfully"
}

set_permissions() {
    info "Setting permissions for workspace directories"
    sudo chown -R "$USER:$USER" "$AETHER_WORKSPACE_DIR"
    sudo chown -R "$USER:$USER" "$AETHER_UPLOADS_DIR"
    sudo chmod -R 755 "$AETHER_WORKSPACE_DIR"
    sudo chmod -R 755 "$AETHER_UPLOADS_DIR"

    info "Permissions set successfully"
}

create_initial_config() {
    local config_file="$AETHER_WORKSPACE_DIR/.aetherrc"

    if [ -f "$config_file" ]; then
        info "Config file already exists: $config_file"
        return
    fi

    info "Creating initial config file: $config_file"
    cat > "$config_file" <<EOL
# Aether workspace configuration

# Workspace directory
WORKSPACE_DIR=$AETHER_WORKSPACE_DIR

# Uploads directory
UPLOADS_DIR=$AETHER_UPLOADS_DIR

# Log directory
LOG_DIR=$AETHER_LOG_DIR

# Security settings
ENABLE_SECURITY=true

# Default editor
DEFAULT_EDITOR=code
EOL

    info "Initial config file created successfully"
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if [ "$0" = "$BASH_SOURCE" ]; then
    setup_workspace
fi

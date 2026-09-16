#!/usr/bin/env bash
# Aether Cloud OS — host agent setup.
#
# Sets up the host agent environment, including pairing with the backend,
# configuration, and service installation.

set -euo pipefail

# Source utility functions
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/../lib/core.sh"
source "$SCRIPT_DIR/../lib/utils.sh"

# Default configuration
AETHER_HOST_AGENT_VERSION="${AETHER_HOST_AGENT_VERSION:-0.1.0}"
AETHER_PAIRING_URL="${AETHER_PAIRING_URL:-}"
AETHER_BACKEND_URL="${AETHER_BACKEND_URL:-https://localhost:3000}"
AETHER_INSTALL_DIR="${AETHER_INSTALL_DIR:-/opt/aether-host-agent}"
AETHER_CONFIG_FILE="${AETHER_CONFIG_FILE:-$AETHER_INSTALL_DIR/.env}"

# ---------------------------------------------------------------------------
# Host agent setup
# ---------------------------------------------------------------------------
setup_host_agent() {
    stage "Setting up Aether host agent"
    info "Host agent version: $AETHER_HOST_AGENT_VERSION"
    info "Installation directory: $AETHER_INSTALL_DIR"

    # Create installation directory
    create_directory "$AETHER_INSTALL_DIR"

    # Install Node.js if not present
    if ! command -v node &> /dev/null; then
        info "Node.js not found, installing..."
        install_nodejs
    else
        info "Node.js already installed: $(node --version)"
    fi

    # Download and install host agent
    info "Downloading host agent"
    download_host_agent

    # Configure host agent
    info "Configuring host agent"
    configure_host_agent

    # Create systemd service
    info "Creating systemd service"
    create_systemd_service

    # Start the service
    info "Starting host agent service"
    start_service

    info "Host agent setup completed successfully"
}

download_host_agent() {
    cd "$AETHER_INSTALL_DIR"

    if [ -f "package.json" ]; then
        info "Host agent already installed, skipping download"
        return
    fi

    info "Initializing host agent package"
    npm init -y

    cd - > /dev/null
}

configure_host_agent() {
    local config_content="# Aether host agent configuration

# Backend URL
AETHER_BACKEND_URL=$AETHER_BACKEND_URL

# Pairing token (set via secure pairing)
AETHER_PAIRING_TOKEN=

# Agent ID (auto-generated on first run)
AETHER_AGENT_ID=

# Workspace directory
AETHER_WORKSPACE_DIR=/opt/aether/workspace

# Log directory
AETHER_LOG_DIR=/var/log/aether-host-agent

# Auto-reconnect settings
AETHER_RECONNECT_MAX_RETRIES=5
AETHER_RECONNECT_INITIAL_DELAY=1000
AETHER_RECONNECT_MAX_DELAY=30000

# Security
AETHER_ENABLE_TLS=true
AETHER_VERIFY_PEER=true
"

    if [ -f "$AETHER_CONFIG_FILE" ]; then
        info "Config file already exists: $AETHER_CONFIG_FILE"
        return
    fi

    info "Creating config file: $AETHER_CONFIG_FILE"
    echo "$config_content" > "$AETHER_CONFIG_FILE"
}

create_systemd_service() {
    local service_file="/etc/systemd/system/aether-host-agent.service"

    info "Creating systemd service file: $service_file"

    sudo bash -c "cat > $service_file <<EOL
[Unit]
Description=Aether Cloud OS Host Agent
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$AETHER_INSTALL_DIR
EnvironmentFile=$AETHER_CONFIG_FILE
ExecStart=/usr/bin/node $AETHER_INSTALL_DIR/src/cli.js start
Restart=always
RestartSec=5s
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOL"

    info "Systemd service file created"
}

start_service() {
    info "Enabling and starting host agent service"
    sudo systemctl daemon-reload
    sudo systemctl enable aether-host-agent
    sudo systemctl start aether-host-agent
}

install_nodejs() {
    info "Installing Node.js via NodeSource repository"

    local nodejs_version="20"
    curl -fsSL "https://deb.nodesource.com/setup_${nodejs_version}.x" | sudo -E bash -
    sudo apt-get install -y nodejs

    info "Node.js installed: $(node --version)"
}

# ---------------------------------------------------------------------------
# Pairing functions
# ---------------------------------------------------------------------------
pair_with_backend() {
    stage "Pairing with backend"

    if [ -z "$AETHER_PAIRING_URL" ]; then
        error "No pairing URL provided. Set AETHER_PAIRING_URL environment variable."
        exit 1
    fi

    info "Pairing URL: $AETHER_PAIRING_URL"

    if [ ! -f "$AETHER_CONFIG_FILE" ]; then
        error "Config file not found: $AETHER_CONFIG_FILE"
        error "Run setup-host.sh first"
        exit 1
    fi

    info "Initiating pairing process"
    local pairing_code
    pairing_code=$(curl -s -X POST "$AETHER_PAIRING_URL/pairing/tickets" \
        -H "Content-Type: application/json" \
        -d '{"platform": "linux", "name": "'$(hostname)'"}')

    info "Pairing code: $pairing_code"
    echo "Please enter the following pairing code in the web UI: $pairing_code"

    info "Waiting for pairing confirmation..."
    # TODO: Implement pairing confirmation polling
    info "Pairing initiated. Complete the pairing in the web UI."
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if [ "$0" = "$BASH_SOURCE" ]; then
    case "${1:-}" in
        --pair)
            pair_with_backend
            ;;
        "")
            setup_host_agent
            ;;
        *)
            echo "Usage: $0 [--pair]"
            exit 1
            ;;
    esac
fi

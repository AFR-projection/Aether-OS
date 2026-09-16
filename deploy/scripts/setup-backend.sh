#!/usr/bin/env bash
# Aether Cloud OS — backend setup.
#
# Sets up the backend environment, including database setup,
# configuration, and service installation.

set -euo pipefail

# Source utility functions
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/../lib/core.sh"
source "$SCRIPT_DIR/../lib/utils.sh"

# Default configuration
AETHER_BACKEND_VERSION="${AETHER_BACKEND_VERSION:-0.1.0}"
AETHER_INSTALL_DIR="${AETHER_INSTALL_DIR:-/opt/aether-backend}"
AETHER_CONFIG_FILE="${AETHER_CONFIG_FILE:-$AETHER_INSTALL_DIR/.env}"
AETHER_DB_HOST="${AETHER_DB_HOST:-localhost}"
AETHER_DB_PORT="${AETHER_DB_PORT:-5432}"
AETHER_DB_USER="${AETHER_DB_USER:-aether}"
AETHER_DB_PASSWORD="${AETHER_DB_PASSWORD:-}"
AETHER_DB_NAME="${AETHER_DB_NAME:-aether}"

# ---------------------------------------------------------------------------
# Backend setup
# ---------------------------------------------------------------------------
setup_backend() {
    stage "Setting up Aether backend"
    info "Backend version: $AETHER_BACKEND_VERSION"
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

    # Download and install backend
    info "Downloading backend"
    download_backend

    # Configure backend
    info "Configuring backend"
    configure_backend

    # Setup database
    info "Setting up database"
    setup_database

    # Create systemd service
    info "Creating systemd service"
    create_systemd_service

    # Start the service
    info "Starting backend service"
    start_service

    info "Backend setup completed successfully"
}

download_backend() {
    cd "$AETHER_INSTALL_DIR"

    if [ -f "package.json" ]; then
        info "Backend already installed, skipping download"
        return
    fi

    info "Initializing backend package"
    npm init -y

    cd - > /dev/null
}

configure_backend() {
    local config_content="# Aether backend configuration

# Database configuration
DB_HOST=$AETHER_DB_HOST
DB_PORT=$AETHER_DB_PORT
DB_USER=$AETHER_DB_USER
DB_PASSWORD=$AETHER_DB_PASSWORD
DB_NAME=$AETHER_DB_NAME

# Server configuration
SERVER_PORT=3000
SERVER_HOST=0.0.0.0

# Security
JWT_SECRET=
JWT_EXPIRES_IN=1h

# Logging
LOG_LEVEL=info
LOG_DIR=/var/log/aether-backend
"

    if [ -f "$AETHER_CONFIG_FILE" ]; then
        info "Config file already exists: $AETHER_CONFIG_FILE"
        return
    fi

    info "Creating config file: $AETHER_CONFIG_FILE"
    echo "$config_content" > "$AETHER_CONFIG_FILE"
}

setup_database() {
    info "Setting up database"

    if ! command -v psql &> /dev/null; then
        info "PostgreSQL client not found, installing..."
        sudo apt-get update
        sudo apt-get install -y postgresql-client
    fi

    info "Creating database user and database"
    sudo -u postgres psql -c "CREATE USER $AETHER_DB_USER WITH PASSWORD '$AETHER_DB_PASSWORD';"
    sudo -u postgres psql -c "CREATE DATABASE $AETHER_DB_NAME OWNER $AETHER_DB_USER;"

    info "Database setup completed successfully"
}

create_systemd_service() {
    local service_file="/etc/systemd/system/aether-backend.service"

    info "Creating systemd service file: $service_file"

    sudo bash -c "cat > $service_file <<EOL
[Unit]
Description=Aether Cloud OS Backend
After=network.target postgresql.service
Requires=postgresql.service

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
    info "Enabling and starting backend service"
    sudo systemctl daemon-reload
    sudo systemctl enable aether-backend
    sudo systemctl start aether-backend
}

install_nodejs() {
    info "Installing Node.js via NodeSource repository"

    local nodejs_version="20"
    curl -fsSL "https://deb.nodesource.com/setup_${nodejs_version}.x" | sudo -E bash -
    sudo apt-get install -y nodejs

    info "Node.js installed: $(node --version)"
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if [ "$0" = "$BASH_SOURCE" ]; then
    setup_backend
fi

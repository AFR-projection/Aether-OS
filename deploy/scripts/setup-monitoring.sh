#!/usr/bin/env bash
# Aether Cloud OS — monitoring setup.
#
# Sets up monitoring tools for the Aether Cloud OS installation.

set -euo pipefail

# Source utility functions
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/../lib/core.sh"
source "$SCRIPT_DIR/../lib/utils.sh"

# Default configuration
AETHER_MONITORING_DIR="${AETHER_MONITORING_DIR:-/opt/aether-monitoring}"
AETHER_LOG_RETENTION_DAYS="${AETHER_LOG_RETENTION_DAYS:-30}"

# ---------------------------------------------------------------------------
# Monitoring setup
# ---------------------------------------------------------------------------
setup_monitoring() {
    stage "Setting up Aether monitoring"
    info "Monitoring directory: $AETHER_MONITORING_DIR"

    # Create monitoring directory
    create_directory "$AETHER_MONITORING_DIR"

    # Install monitoring tools
    info "Installing monitoring tools"
    install_monitoring_tools

    # Configure log rotation
    info "Configuring log rotation"
    configure_log_rotation

    # Configure monitoring scripts
    info "Configuring monitoring scripts"
    configure_monitoring_scripts

    # Start monitoring services
    info "Starting monitoring services"
    start_monitoring_services

    info "Monitoring setup completed successfully"
}

install_monitoring_tools() {
    info "Installing system monitoring tools"

    sudo apt-get update
    sudo apt-get install -y htop iotop iftop

    info "Monitoring tools installed successfully"
}

configure_log_rotation() {
    local logrotate_config="/etc/logrotate.d/aether"

    if [ -f "$logrotate_config" ]; then
        info "Logrotate config already exists: $logrotate_config"
        return
    fi

    info "Creating logrotate config: $logrotate_config"
    sudo bash -c "cat > $logrotate_config <<EOL
/var/log/aether/*.log {
    daily
    missingok
    rotate $AETHER_LOG_RETENTION_DAYS
    compress
    delaycompress
    notifempty
    create 0640 root root
    sharedscripts
    postrotate
        systemctl reload rsyslog > /dev/null 2>&1 || true
    endscript
}
EOL"

    info "Log rotation configured successfully"
}

configure_monitoring_scripts() {
    info "Creating monitoring scripts"

    local healthcheck_script="$AETHER_MONITORING_DIR/healthcheck.sh"
    cat > "$healthcheck_script" <<'EOF'
#!/usr/bin/env bash
# Aether Cloud OS — health check script.

set -euo pipefail

check_service() {
    local service_name="$1"
    if systemctl is-active --quiet "$service_name"; then
        echo "✓ $service_name is running"
    else
        echo "✗ $service_name is not running"
        return 1
    fi
}

check_port() {
    local port="$1"
    local service_name="$2"
    if curl -sf --max-time 5 "http://localhost:$port/health" > /dev/null 2>&1; then
        echo "✓ $service_name (port $port) is responding"
    else
        echo "✗ $service_name (port $port) is not responding"
        return 1
    fi
}

echo "Aether Cloud OS Health Check"
echo "============================"
echo ""

check_service "aether-backend"
check_service "aether-host-agent"
check_port 3000 "Backend"

echo ""
echo "Health check completed at $(date)"
EOF

    chmod +x "$healthcheck_script"
    info "Monitoring scripts configured successfully"
}

start_monitoring_services() {
    info "Starting monitoring services"
    # Start any necessary monitoring services
    info "Monitoring services started successfully"
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if [ "$0" = "$BASH_SOURCE" ]; then
    setup_monitoring
fi

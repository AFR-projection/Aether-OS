#!/usr/bin/env bash
# Aether Cloud OS — finalization.
#
# Permission hardening (contract §5.2, §7.2), firewall rules (§4.3), the
# `aether` management CLI, the systemd unit that keeps compose up across
# reboots, and a post-install security check (§6.2).

apply_permissions() {
    info "Hardening permissions"

    chmod 600 "${AETHER_INSTALL_DIR}/.env"
    chmod 700 "$AETHER_SECRETS_DIR"
    find "$AETHER_SECRETS_DIR" -type f -exec chmod 600 {} \;
    chmod 644 "${AETHER_INSTALL_DIR}/install.state" "${AETHER_INSTALL_DIR}/instance.json" 2>/dev/null || true

    if [ "$(id -u)" -ne 0 ]; then
        $SUDO chown -R "$(id -un):$(id -gn)" "$AETHER_INSTALL_DIR" 2>/dev/null || \
            warn "Could not chown $AETHER_INSTALL_DIR to the invoking user; continue with sudo chown -R $USER $AETHER_INSTALL_DIR"
    fi
}

configure_firewall() {
    # Contract §4.3: backup, allow SSH FIRST, then 80/443; never disable.
    if ! command_exists ufw; then
        info "UFW not present — skipping firewall configuration (install ufw to manage it)"
        return
    fi

    mkdir -p "${AETHER_INSTALL_DIR}/backups"
    local backup="${AETHER_INSTALL_DIR}/backups/ufw-backup-$(date +%Y%m%d-%H%M%S).txt"
    ufw status numbered > "$backup" 2>/dev/null || true
    info "Current firewall rules backed up to $backup"

    # SSH before anything else so the operator is never locked out.
    $SUDO ufw allow ssh || warn "Could not add the SSH allow rule — verify access before continuing."
    $SUDO ufw allow 80/tcp
    $SUDO ufw allow 443/tcp

    if [ "${AETHER_YES:-false}" = "true" ] || confirm "Enable UFW now?"; then
        $SUDO ufw --force enable
    else
        warn "UFW left in its previous state. Enable it later with: sudo ufw enable"
    fi
}

install_cli() {
    # Thin wrapper so operators manage the stack without remembering paths.
    local cli_dir="${AETHER_INSTALL_DIR}/scripts"
    mkdir -p "$cli_dir"

    cat > "$cli_dir/aether" <<EOF
#!/usr/bin/env bash
# Aether Cloud OS management CLI (installed by the installer).
set -euo pipefail
cd "$AETHER_INSTALL_DIR"
compose() {
    if docker info >/dev/null 2>&1; then docker compose "\$@"; else sudo docker compose "\$@"; fi
}
case "\${1:-help}" in
    status)   compose ps ;;
    logs)     shift; compose logs -f "\$@" ;;
    start)    compose up -d ;;
    stop)     compose stop ;;
    restart)  compose restart ;;
    update)   compose build --pull --no-cache && compose up -d ;;
    backup)   bash "$AETHER_INSTALL_DIR/scripts/backup.sh" ;;
    uninstall) bash "$AETHER_INSTALL_DIR/scripts/uninstall.sh" ;;
    *)        echo "Usage: aether {status|logs|start|stop|restart|update|backup|uninstall}" ;;
esac
EOF
    chmod 755 "$cli_dir/aether"

    if [ -w /usr/local/bin ]; then
        ln -sf "$cli_dir/aether" /usr/local/bin/aether
    else
        $SUDO ln -sf "$cli_dir/aether" /usr/local/bin/aether
    fi
    info "Management CLI installed: aether"
}

create_systemd_unit() {
    # The unit does not run the app — it asks Docker to bring the stack up at
    # boot; each container's `restart: unless-stopped` handles resilience.
    local service_file="/etc/systemd/system/aether.service"

    $SUDO tee "$service_file" >/dev/null <<EOF
[Unit]
Description=Aether Cloud OS (Docker Compose stack)
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
User=$(id -un)
WorkingDirectory=$AETHER_INSTALL_DIR
ExecStartPre=/usr/bin/docker info
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=600

[Install]
WantedBy=multi-user.target
EOF

    $SUDO systemctl daemon-reload
    $SUDO systemctl enable aether
    info "Systemd unit installed and enabled: aether.service"
}

health_check() {
    info "Waiting for the stack to become healthy…"

    local attempts=60
    while [ $attempts -gt 0 ]; do
        if curl -sf --max-time 5 http://127.0.0.1/health >/dev/null 2>&1; then
            info "Caddy → backend health check passed"
            break
        fi
        attempts=$((attempts - 1))
        sleep 3
    done

    if [ $attempts -eq 0 ]; then
        warn "Stack is not answering on http://127.0.0.1/health yet."
        warn "Check progress with: aether logs -f backend"
        return
    fi

    # Post-install security check (contract §6.2): internal ports must NOT be
    # reachable from the host's public interfaces.
    local leaked=()
    for port in 5432 6379 3000; do
        if command_exists ss && ss -ltn "( sport = :$port )" 2>/dev/null | grep -q LISTEN; then
            leaked+=("$port")
        fi
    done
    if [ ${#leaked[@]} -gt 0 ]; then
        warn "These internal ports are listening on the host and should not be: ${leaked[*]}"
    else
        info "Security check passed: no internal service ports exposed"
    fi
}

finalize_installation() {
    stage "Finalizing installation"
    apply_permissions
    configure_firewall
    install_cli
    create_systemd_unit
    health_check
    mark_done finalize
}

print_summary() {
    printf '\n'
    printf '  ---------------------------------------------------------------\n'
    printf '   Aether Cloud OS %s installed\n' "$AETHER_VERSION"
    printf '  ---------------------------------------------------------------\n'
    printf '   URL:              https://%s\n' "$AETHER_DOMAIN"
    printf '   Install dir:      %s\n' "$AETHER_INSTALL_DIR"
    printf '   Installer log:    %s\n' "$AETHER_LOG_FILE"
    printf '   Installation ID:  %s\n' "$AETHER_INSTALLATION_ID"
    printf '\n'
    printf '   First steps:\n'
    printf '     1. Open https://%s and complete the setup wizard.\n' "$AETHER_DOMAIN"
    printf '     2. The one-time bootstrap token is in:\n'
    printf '          grep AETHER_BOOTSTRAP_TOKEN %s/.env\n' "$AETHER_INSTALL_DIR"
    printf '\n'
    printf '   Management:  aether status | logs | restart | update | backup\n'
    printf '   Service:     systemctl status aether\n'
    printf '\n'
}

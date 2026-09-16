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
    # Install a real management CLI and the helper scripts it dispatches.
    local cli_dir="${AETHER_INSTALL_DIR}/scripts"
    local lib_dir="${AETHER_INSTALL_DIR}/lib"
    mkdir -p "$cli_dir" "$lib_dir"

    # Helpers source ../lib/core.sh and ../lib/utils.sh. Keep those libraries
    # beside the installed scripts rather than depending on the source tree.
    cp "${AETHER_INSTALL_DIR}/src/deploy/lib/core.sh" "$lib_dir/core.sh"
    cp "${AETHER_INSTALL_DIR}/src/deploy/lib/utils.sh" "$lib_dir/utils.sh"
    for helper in backup.sh restore.sh update.sh uninstall.sh; do
        cp "${AETHER_INSTALL_DIR}/src/deploy/scripts/$helper" "$cli_dir/$helper"
        chmod 755 "$cli_dir/$helper"
    done
    # Ensure helper scripts resolve the copied libraries, not the deleted source.
    chmod 644 "$lib_dir/core.sh" "$lib_dir/utils.sh"

    cat > "$cli_dir/aether" <<EOF
#!/usr/bin/env bash
# Aether Cloud OS management CLI (installed by the installer).
set -euo pipefail
INSTALL_DIR="$AETHER_INSTALL_DIR"
cd "\$INSTALL_DIR"
compose() {
    if docker info >/dev/null 2>&1; then docker compose "\$@"; else sudo docker compose "\$@"; fi
}
usage() {
    printf '%s\\n' 'Usage: aether {status|logs [service]|start|stop|restart|update|repair|rollback|backup|restore <archive>|uninstall [--purge]}'
}
case "\${1:-help}" in
    status) compose ps ;;
    logs) shift; compose logs -f "\$@" ;;
    start) compose up -d ;;
    stop) compose stop ;;
    restart) compose restart ;;
    update)
        bash "\$INSTALL_DIR/scripts/backup.sh"
        compose pull
        compose build --pull
        compose up -d
        ;;
    repair)
        compose config >/dev/null
        compose up -d --force-recreate
        ;;
    rollback)
        archive="\${2:-}"
        [ -n "\$archive" ] || { printf '%s\\n' 'rollback requires a backup archive path' >&2; exit 2; }
        bash "\$INSTALL_DIR/scripts/restore.sh" "\$archive"
        ;;
    backup) bash "\$INSTALL_DIR/scripts/backup.sh" ;;
    restore)
        [ -n "\${2:-}" ] || { printf '%s\\n' 'restore requires a backup archive path' >&2; exit 2; }
        bash "\$INSTALL_DIR/scripts/restore.sh" "\$2"
        ;;
    uninstall) bash "\$INSTALL_DIR/scripts/uninstall.sh" "\${2:-}" ;;
    help|*) usage ;;
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

    local attempts=60 health_url
    if [ -n "${AETHER_DOMAIN:-}" ]; then
        health_url="http://${AETHER_DOMAIN}/health"
    else
        health_url="http://127.0.0.1/health"
    fi
    while [ $attempts -gt 0 ]; do
        if [ -n "${AETHER_DOMAIN:-}" ]; then
            if curl -sf --max-time 5 --resolve "${AETHER_DOMAIN}:80:127.0.0.1" "$health_url" >/dev/null 2>&1; then
                info "Caddy → backend health check passed"
                break
            fi
        elif curl -sf --max-time 5 "$health_url" >/dev/null 2>&1; then
            info "Caddy → backend health check passed"
            break
        fi
        attempts=$((attempts - 1))
        sleep 3
    done

    if [ $attempts -eq 0 ]; then
        warn "Stack is not answering on ${health_url} yet."
        warn "Recent container status:"
        compose_cmd ps 2>/dev/null || true
        warn "Check progress with: aether logs backend"
        fatal "Health check failed. Fix the reported service and rerun with --resume."
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

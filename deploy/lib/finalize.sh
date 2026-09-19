#!/usr/bin/env bash
# Aether Cloud OS — finalization.
#
# Permission hardening (contract §5.2, §7.2), firewall rules (§4.3), the
# `aether` management CLI, the systemd unit that keeps compose up across
# reboots, and a post-install security check (§6.2).

# `install_local_agent` (the local host agent stage) lives in its own file so it
# can also be run on its own: deploy/lib/local-agent.sh
# shellcheck source=./local-agent.sh
source "$SCRIPT_DIR/local-agent.sh"

apply_permissions() {
    info "Hardening permissions"

    chmod 600 "${AETHER_INSTALL_DIR}/.env"
    chmod 700 "$AETHER_SECRETS_DIR"
    find "$AETHER_SECRETS_DIR" -type f -exec chmod 600 {} \;
    chmod 644 "${AETHER_INSTALL_DIR}/install.state" "${AETHER_INSTALL_DIR}/instance.json" 2>/dev/null || true

    # Static frontend must be readable by the backend container (uid 1001).
    # Without this, restrictive umask during build/copy leaves files unreadable.
    if [ -d "${AETHER_INSTALL_DIR}/static" ]; then
        find "${AETHER_INSTALL_DIR}/static" -type d -exec chmod 755 {} \;
        find "${AETHER_INSTALL_DIR}/static" -type f -exec chmod 644 {} \;
    fi

    if [ "$(id -u)" -ne 0 ]; then
        $SUDO chown -R "$(id -un):$(id -gn)" "$AETHER_INSTALL_DIR" 2>/dev/null || \
            warn "Could not chown $AETHER_INSTALL_DIR to the invoking user; continue with sudo chown -R $USER $AETHER_INSTALL_DIR"
    fi

    # The recursive chown above also takes the data directory, which the
    # backend container and the host agent must both own by numeric uid. Put it
    # back, or the backend loses write access to the workspace.
    if [ -d "${AETHER_INSTALL_DIR}/data" ]; then
        $SUDO chown -R "${AETHER_APP_UID:-1001}:${AETHER_APP_GID:-1001}" "${AETHER_INSTALL_DIR}/data"
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

    # Preview addresses. A project running on this host is served from one of
    # these ports, and the connection is made by the operator's own browser
    # rather than by the machine — so without the rule the preview window fills
    # with nothing at all, which reads as the project being broken.
    #
    # The range is opened as a whole rather than per preview because ufw rules
    # are not something to write and delete as ports are opened and closed; the
    # backend is what decides whether a given address answers, and it answers
    # only for the user who asked for it.
    if [ "${AETHER_PREVIEW_ENABLED:-true}" = "true" ]; then
        local preview_range="${AETHER_PREVIEW_PORT_START}:$(preview_port_end)"
        $SUDO ufw allow "$preview_range/tcp" \
            || warn "Could not open the preview ports $preview_range — previews will not be reachable."
        info "Preview ports opened: $preview_range/tcp"
    fi

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

    cp "${AETHER_INSTALL_DIR}/src/deploy/scripts/aether" "$cli_dir/aether"
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

    local attempts=60 url domain no_https
    domain="${AETHER_DOMAIN:-}"
    no_https="${AETHER_NO_HTTPS:-false}"

    # Caddy is the only ingress (the backend publishes no host port), so this
    # goes through it. With a domain, Caddy matches on Host, hence --resolve:
    # it pins the name to loopback without needing public DNS to be live yet.
    if [ -n "$domain" ] && [ "$no_https" != "true" ]; then
        url="https://${domain}/health"
        probe() { curl -sf --max-time 5 --resolve "${domain}:443:127.0.0.1" "$url" >/dev/null 2>&1; }
    elif [ -n "$domain" ]; then
        url="http://${domain}/health"
        probe() { curl -sf --max-time 5 --resolve "${domain}:80:127.0.0.1" "$url" >/dev/null 2>&1; }
    else
        url="http://127.0.0.1/health"
        probe() { curl -sf --max-time 5 "$url" >/dev/null 2>&1; }
    fi

    while [ $attempts -gt 0 ]; do
        if probe; then
            info "Caddy → backend health check passed"
            break
        fi
        attempts=$((attempts - 1))
        sleep 3
    done

    if [ $attempts -eq 0 ]; then
        warn "Stack is not answering on ${url}."
        # Tell the two failures apart: an HTTP answer on port 80 means the
        # containers are up and only TLS is not ready (ACME still working, or
        # DNS not pointed here yet).
        if [ -n "$domain" ] && curl -sf --max-time 5 --resolve "${domain}:80:127.0.0.1" \
            "http://${domain}/health" >/dev/null 2>&1; then
            error "The backend is up over HTTP but HTTPS on ${domain} is not serving."
            error "Cause: Caddy has not obtained a certificate (DNS must point at this host's public IP and port 80 must be reachable)."
            error "Check: aether logs --tail 100 caddy"
        else
            warn "Recent container status:"
            compose_cmd ps 2>/dev/null || true
            error "Check progress with: aether logs backend"
        fi
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

write_initial_deployment_metadata() {
    local metadata_file="$AETHER_INSTALL_DIR/deployment.json"
    local src_dir="$AETHER_INSTALL_DIR/src"
    local revision branch

    if [ -d "$src_dir/.git" ]; then
        revision=$(git -C "$src_dir" rev-parse HEAD 2>/dev/null || echo "unknown")
        branch=$(git -C "$src_dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
    else
        revision="local-copy"
        branch="local-copy"
    fi

    mkdir -p "$(dirname "$metadata_file")"
    cat > "$metadata_file" <<EOF
{
  "revision": "$revision",
  "revisionShort": "$(git -C "$src_dir" rev-parse --short HEAD 2>/dev/null || echo "$revision")",
  "branch": "$branch",
  "deployedAt": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "deploymentMethod": "fresh-install",
  "instanceId": "$(sed -n 's/.*"installationId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$AETHER_INSTALL_DIR/instance.json" 2>/dev/null | head -n1)"
}
EOF
    info "Deployment metadata written to $metadata_file"
}

finalize_installation() {
    stage "Finalizing installation"
    apply_permissions
    configure_firewall
    install_cli
    create_systemd_unit
    health_check

    # Create the master account BEFORE the host agent. The login account is what
    # makes the instance usable at all; the agent is an enhancement on top of it.
    # install_local_agent calls fatal on failure, so if it ran first a failed
    # agent would abort the whole install and leave the operator with an instance
    # they cannot even log into — which is exactly how a CHDIR failure in the
    # agent left a live deployment stuck on the "no users yet" bootstrap screen.
    # Order it so the account always exists once the stack is healthy.
    if [ -n "${AETHER_MASTER_USERNAME:-}" ] && [ -n "${AETHER_MASTER_PASSWORD:-}" ]; then
        stage "Creating master administrator account"
        create_master_user "$AETHER_MASTER_USERNAME" "$AETHER_MASTER_PASSWORD"
    fi

    # Now pair this host with its own backend. A failure here still aborts the
    # install (the agent is required for a complete instance), but the master
    # account above is already committed, so the operator can log in and finish
    # pairing from the UI even if this step needs a retry.
    stage "Installing the local host agent"
    install_local_agent

    # Write deployment metadata after successful install
    write_initial_deployment_metadata

    mark_done finalize
}

# The URL the operator should open, matching what `write_caddyfile` deployed.
#
# IP-only mode has no domain to print, and hardcoding `https://` there would
# send the operator to a scheme Caddy is not serving.
installation_url() {
    if [ -n "${AETHER_DOMAIN:-}" ]; then
        if [ "${AETHER_NO_HTTPS:-false}" = "true" ]; then
            printf 'http://%s' "$AETHER_DOMAIN"
        else
            printf 'https://%s' "$AETHER_DOMAIN"
        fi
        return
    fi

    # IP-only: report the address the operator most likely reaches this host on.
    local address
    address="$(hostname -I 2>/dev/null | awk '{print $1}')"
    printf 'http://%s' "${address:-<server-ip>}"
}

print_summary() {
    local url
    url="$(installation_url)"

    printf '\n'
    printf '═══════════════════════════════════════════════════════════════\n'
    printf '  ✓ AETHER CLOUD OS INSTALLED SUCCESSFULLY\n'
    printf '═══════════════════════════════════════════════════════════════\n'
    printf '\n'

    # Domain/URL
    if [ -n "${AETHER_DOMAIN:-}" ]; then
        printf '  Domain:           %s\n' "$AETHER_DOMAIN"
    else
        printf '  Access URL:       %s\n' "$url"
    fi

    printf '\n'

    # Master Account
    if [ -n "${AETHER_MASTER_USERNAME:-}" ]; then
        printf '  MASTER ACCOUNT\n'
        printf '  ─────────────────────────────────────────────────────────────\n'
        printf '  Username:         %s\n' "$AETHER_MASTER_USERNAME"
        printf '  Password:         %s\n' "$AETHER_MASTER_PASSWORD"
        printf '\n'
        printf '  ⚠  IMPORTANT: Save these credentials securely!\n'
        printf '     This is the only time the password will be displayed.\n'
        printf '\n'
    fi

    printf '  NEXT STEPS\n'
    printf '  ─────────────────────────────────────────────────────────────\n'
    printf '  1. Open your browser: %s\n' "$url"
    if [ -n "${AETHER_MASTER_USERNAME:-}" ]; then
        printf '  2. Login with the master account credentials above\n'
    else
        printf '  2. Create the owner account (bootstrap token in .env)\n'
    fi
    printf '  3. Start managing your cloud infrastructure\n'
    printf '\n'

    printf '  MANAGEMENT COMMANDS\n'
    printf '  ─────────────────────────────────────────────────────────────\n'
    printf '  aether status      Check system health\n'
    printf '  aether logs        View service logs\n'
    printf '  aether update      Update to latest version\n'
    printf '  aether backup      Create backup\n'
    printf '  aether restart     Restart services\n'
    printf '\n'

    printf '  SYSTEM INFO\n'
    printf '  ─────────────────────────────────────────────────────────────\n'
    printf '  Install directory: %s\n' "$AETHER_INSTALL_DIR"
    if [ "${AETHER_FULL_HOST_ACCESS:-true}" = "true" ]; then
        printf '  Host access:       FULL — the whole filesystem is manageable from the GUI\n'
    else
        printf '  Host access:       CONFINED — the agent only sees its workspace\n'
    fi
    printf '  Version:           %s\n' "$AETHER_VERSION"
    printf '  Installation ID:   %s\n' "$AETHER_INSTALLATION_ID"
    printf '  Log file:          %s\n' "$AETHER_LOG_FILE"
    printf '\n'
    printf '═══════════════════════════════════════════════════════════════\n'
    printf '\n'
}

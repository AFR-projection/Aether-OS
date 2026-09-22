#!/usr/bin/env bash
# Aether Cloud OS — finalization.
#
# Permission hardening (contract §5.2, §7.2), firewall rules (§4.3), the
# `aether` management CLI, the systemd unit that keeps compose up across
# reboots, and a post-install security check (§6.2).

# `install_local_agent` (the local host agent stage) lives in its own file so it
# can also be run on its own: deploy/lib/local-agent.sh
#
# Resolved from this file, not from $SCRIPT_DIR. Every other source in this tree
# is written against the SCRIPT_DIR of the script that owns it, and install.sh
# sets that to this directory — but `aether update` sources this file from the
# *installed* CLI, whose SCRIPT_DIR is $AETHER_INSTALL_DIR/scripts. That
# directory has no local-agent.sh, so every update printed
# "finalize.sh: line 11: /opt/aether/scripts/local-agent.sh: No such file or
# directory" and installed no agent functions. This file is the one library that
# is sourced across trees, so it resolves its own sibling.
# shellcheck source=./local-agent.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/local-agent.sh"

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

# Opens the preview port range in the host firewall.
#
# A preview is served from one of these ports and the connection is made by the
# operator's own browser rather than by the machine — so without the rule the
# preview window fills with nothing at all, which reads as the project being
# broken rather than as a missing firewall rule. The ports are published by the
# compose file, and `aether update` regenerates that compose file, so the update
# has to reconcile this rule too: an instance whose ufw was enabled after it was
# installed would otherwise publish ports nothing can reach, and `aether update`
# would keep reporting that it is up to date.
#
# The range is opened as a whole rather than per preview because ufw rules are
# not something to write and delete as ports are opened and closed; the backend
# is what decides whether a given address answers, and it answers only for the
# user who asked for it.
#
# Additive by design: no rule is ever removed, and ufw is never enabled or
# disabled here — whether the host runs a firewall is the operator's decision,
# and configure_firewall is what asks. An inactive firewall blocks nothing, so
# there is nothing to open and the function says nothing. The install path
# passes --even-if-inactive because it opens the ports and *then* enables the
# firewall, so the ports are allowed from the moment it comes up.
ensure_preview_firewall_rule() {
    local even_if_inactive=false
    [ "${1:-}" = "--even-if-inactive" ] && even_if_inactive=true

    if [ "${AETHER_PREVIEW_ENABLED:-true}" != "true" ]; then
        return 0
    fi

    if ! command_exists ufw; then
        return 0
    fi

    local status
    status=$($SUDO ufw status 2>/dev/null || true)
    if [ "$even_if_inactive" = false ] && ! matches "$status" '^Status: active'; then
        return 0
    fi

    local preview_range="${AETHER_PREVIEW_PORT_START}:$(preview_port_end)"
    local output
    if ! output=$($SUDO ufw allow "$preview_range/tcp" 2>&1); then
        warn "Could not open the preview ports $preview_range — previews will not be reachable."
        return 0
    fi

    # ufw reports a rule that is already there as skipped rather than as a
    # failure, so a second update stays quiet instead of claiming to have opened
    # the ports again.
    case "$output" in
        *Skipping*) : ;;
        *) info "Preview ports opened: $preview_range/tcp" ;;
    esac
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

    # Opened before the firewall is enabled below, so the preview ports are
    # allowed from the moment it comes up rather than needing a second pass.
    ensure_preview_firewall_rule --even-if-inactive

    # AETHER_ENABLE_UFW was collected upfront in run_interactive_setup.
    # --yes always enables; non-interactive without the flag disables.
    local enable_ufw="${AETHER_ENABLE_UFW:-false}"
    if [ "${AETHER_YES:-false}" = "true" ]; then
        enable_ufw="true"
    fi

    if [ "$enable_ufw" = "true" ]; then
        $SUDO ufw --force enable
    else
        warn "UFW left in its previous state. Enable it later with: sudo ufw enable"
    fi
}

# Copies one file into the installed CLI, atomically.
#
# Written beside the destination and renamed into place, rather than copied over
# it, because `aether update` re-installs this CLI while `update.sh` — one of the
# files being replaced — is the script it is executing. A shell reads a script
# as it runs it, and `cp` truncates the target in place, so a running update
# would carry on reading from its own offset into different content and fail in
# a way that looks like the update being broken. A rename swaps the inode
# instead: the running script keeps reading the file it started with, and the
# new copy is in place for whatever runs next.
install_script_file() {
    local source="$1" target="$2" mode="$3"
    cp "$source" "$target.new"
    chmod "$mode" "$target.new"
    mv -f "$target.new" "$target"
}

install_cli() {
    # Install a real management CLI and the helper scripts it dispatches.
    local cli_dir="${AETHER_INSTALL_DIR}/scripts"
    local lib_dir="${AETHER_INSTALL_DIR}/lib"
    mkdir -p "$cli_dir" "$lib_dir"

    # Helpers source ../lib/core.sh and ../lib/utils.sh. Keep those libraries
    # beside the installed scripts rather than depending on the source tree.
    # Terse mode 644 spelled out as a number, because these are sourced and only
    # need to be readable.
    install_script_file "${AETHER_INSTALL_DIR}/src/deploy/lib/core.sh" "$lib_dir/core.sh" 644
    install_script_file "${AETHER_INSTALL_DIR}/src/deploy/lib/utils.sh" "$lib_dir/utils.sh" 644

    # The presentation layer core.sh sources when it finds it. This is the only
    # place that decides what lands in an installation's lib directory, and it is
    # used both by the installer and by `aether update` — so copying them here is
    # what makes the UI reach an instance that was installed before it existed.
    #
    # Copied one at a time and skipped when absent, rather than copied
    # unconditionally: `aether update` refreshes the CLI from the source tree it
    # just fetched, and a tree older than this layer has neither file. A `cp` of a
    # missing source would fail, and under `set -e` that failure would abort the
    # whole CLI refresh — leaving the operator with the old CLI because of a
    # cosmetic file. core.sh already handles the files being absent.
    local ui_file
    for ui_file in ui-state.sh ui.sh ui-sword.sh; do
        if [ -f "${AETHER_INSTALL_DIR}/src/deploy/lib/${ui_file}" ]; then
            install_script_file "${AETHER_INSTALL_DIR}/src/deploy/lib/${ui_file}" "$lib_dir/${ui_file}" 644
        fi
    done

    for helper in backup.sh restore.sh update.sh uninstall.sh; do
        install_script_file "${AETHER_INSTALL_DIR}/src/deploy/scripts/$helper" "$cli_dir/$helper" 755
    done

    install_script_file "${AETHER_INSTALL_DIR}/src/deploy/scripts/aether" "$cli_dir/aether" 755

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
    # --now, not a bare `enable`. Enabling alone only arranges the start at boot,
    # so a fresh install left the unit that owns the stack reading "inactive
    # (dead)" — and docs/operations/DEPLOYMENT.md tells the operator to check
    # exactly that with `systemctl status aether`. Starting it runs the unit's own
    # `docker compose up -d` against the same install directory start_services
    # already brought up; compose is idempotent, so a healthy stack is left alone
    # and the unit simply records that it is what owns it.
    $SUDO systemctl enable --now aether
    info "Systemd unit installed, enabled, and started: aether.service"
}

health_check() {
    info "Waiting for the stack to become healthy…"

    local attempts=60 url domain no_https
    domain="${AETHER_DOMAIN:-}"
    no_https="${AETHER_NO_HTTPS:-false}"

    # HEALTH_CHECK is one of the two stages in the whole install with a real
    # denominator: a fixed, known number of probes, each of which either answered
    # or did not. So the bar carries a percentage here, and it is driven by the
    # attempt counter that was already doing the bounding — nothing is estimated.
    ui_stage_begin_notify HEALTH_CHECK "Health verification"
    local total_attempts="$attempts" used=0
    ui_progress HEALTH_CHECK "$used" "$total_attempts" "probes"

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
        used=$((used + 1))
        ui_progress HEALTH_CHECK "$used" "$total_attempts" "probes"
        sleep 3
    done

    # Cleared as the counted phase ends: the security check below is a different
    # kind of work with no denominator, and leaving "7/60 probes" over it would
    # be a stale number claiming to describe something it does not.
    ui_progress_clear HEALTH_CHECK

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
    ui_note HEALTH_CHECK "Checking that no internal service port is exposed"
    local leaked=()
    local listening
    for port in 5432 6379 3000; do
        # Read into a variable and test it, rather than piping into `grep -q`.
        # The pipeline is not the same thing: `grep -q` exits at the first match,
        # the listing on the other end is killed by SIGPIPE, and under
        # `set -o pipefail` the pipeline then reports failure — so a port that IS
        # listening can be reported as not listening. See `matches` in core.sh,
        # which exists for exactly this and cost a real deployment once already.
        if command_exists ss; then
            listening=$(ss -ltn "( sport = :$port )" 2>/dev/null || true)
            if matches "$listening" "LISTEN"; then
                leaked+=("$port")
            fi
        fi
    done
    if [ ${#leaked[@]} -gt 0 ]; then
        warn "These internal ports are listening on the host and should not be: ${leaked[*]}"
    else
        info "Security check passed: no internal service ports exposed"
    fi

    # Completed only here, after the whole check — not the moment the first probe
    # answered. The message names the scheme the probe really used, so a
    # --no-https install does not read as a TLS deployment, and it carries the
    # port warning when there was one rather than reporting a clean bill of
    # health over a finding the line above just raised.
    local scheme="http"
    if [ -n "$domain" ] && [ "$no_https" != "true" ]; then
        scheme="https"
    fi
    local verdict="Caddy → backend healthy over $scheme"
    if [ ${#leaked[@]} -gt 0 ]; then
        verdict="$verdict · internal port exposed: ${leaked[*]}"
    fi
    ui_stage_done_notify HEALTH_CHECK "$verdict"
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

    # FINALIZATION is the enclosing stage of the closing phase: it opens here and
    # closes at the end of this function, and HEALTH_CHECK and HOST_AGENT are
    # reported as sub-stages inside it. That is why its duration covers them — the
    # phase really did take that long — while each of those two keeps its own row
    # and its own real duration. Its message is refreshed before each step, so
    # whichever stage is current, the operation line names what is running.
    ui_stage_begin_notify FINALIZATION "Finalizing installation"

    ui_note FINALIZATION "Hardening file permissions"
    apply_permissions

    ui_note FINALIZATION "Configuring the host firewall"
    configure_firewall

    ui_note FINALIZATION "Installing the management CLI"
    install_cli

    ui_note FINALIZATION "Installing the systemd service unit"
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
        # Registered for redaction before the account is created. The one place
        # this password is meant to be legible is print_summary's one-time
        # display, and that prints it directly rather than through the log path —
        # so redacting it everywhere else costs nothing and covers any line that
        # could echo it.
        ui_secret_add "${AETHER_MASTER_PASSWORD:-}"
        ui_note FINALIZATION "Creating the master administrator account"
        create_master_user "$AETHER_MASTER_USERNAME" "$AETHER_MASTER_PASSWORD"
    fi

    # Now pair this host with its own backend. A failure here still aborts the
    # install (the agent is required for a complete instance), but the master
    # account above is already committed, so the operator can log in and finish
    # pairing from the UI even if this step needs a retry.
    stage "Installing the local host agent"
    install_local_agent

    # Write deployment metadata after successful install
    ui_note FINALIZATION "Recording deployment metadata"
    write_initial_deployment_metadata

    ui_stage_done_notify FINALIZATION "installation finalized"

    # No mark_done here. run_stage already writes it for whatever function it
    # ran, and install.sh is the only caller of finalize_installation — so the
    # call that used to be on this line logged "Stage completed: finalize" a
    # second time, in the same second, and the line appeared twice in the log and
    # twice in the panel's activity feed. The checkpoint itself was never in
    # doubt: run_stage's is the one that has always written it.
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

    # The sword finale (rich mode) has already shown the domain and the master
    # credentials, and set this flag. Suppress the duplicate block here so the
    # password is displayed exactly once — never twice, never in the log — while
    # the rest of the summary (next steps, commands, system info) still prints.
    local show_creds=true
    [ "${AETHER_CREDENTIALS_ON_SCREEN:-0}" = "1" ] && show_creds=false

    if [ "$show_creds" = true ]; then
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

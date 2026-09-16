#!/usr/bin/env bash
# Aether Cloud OS — installer orchestrator.
#
# Entry point invoked by /install.sh at the repo root (curl | bash, or a
# checkout). Runs the five stages in order, checkpointing each so an
# interrupted install resumes instead of redoing finished work.
#
# Environment overrides (all optional):
#   AETHER_INSTALL_DIR   where to install            (default /opt/aether)
#   AETHER_DOMAIN        domain for TLS + routing    (prompted if unset)
#   AETHER_ADMIN_EMAIL   Let's Encrypt notices       (prompted if unset)
#   AETHER_VERSION       version stamp               (default 0.1.0)
#   AETHER_YES           "true" = non-interactive, accept defaults
#   AETHER_FORCE_BUILD   "true" = rebuild the frontend bundle
#   AETHER_RESUME        "true" = skip stages already marked done

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=./core.sh
source "$SCRIPT_DIR/core.sh"
# shellcheck source=./utils.sh
source "$SCRIPT_DIR/utils.sh"
# shellcheck source=./secrets.sh
source "$SCRIPT_DIR/secrets.sh"
# shellcheck source=./preflight.sh
source "$SCRIPT_DIR/preflight.sh"
# shellcheck source=./dependencies.sh
source "$SCRIPT_DIR/dependencies.sh"
# shellcheck source=./configure.sh
source "$SCRIPT_DIR/configure.sh"
# shellcheck source=./deploy.sh
source "$SCRIPT_DIR/deploy.sh"
# shellcheck source=./finalize.sh
source "$SCRIPT_DIR/finalize.sh"

usage() {
    cat <<EOF
Aether Cloud OS installer

Usage: install.sh [options]

Options:
  --domain DOMAIN        public domain pointing at this host
  --email  EMAIL         admin email for certificate notices
  --dir    PATH          installation directory (default /opt/aether)
  --yes                  non-interactive; accept defaults
  --resume               skip stages already completed in this directory
  --dry-run              validate everything but make no changes to the system
  --channel CHANNEL      release channel: stable, beta, or development
  --no-https              serve HTTP only (domain remains optional)
  --version              show installer version
  --help                 show this message

Environment: see the header comment in $(basename "$0").
EOF
}

parse_args() {
    while [ $# -gt 0 ]; do
        case "$1" in
            --domain) AETHER_DOMAIN="$2"; shift 2 ;;
            --email) AETHER_ADMIN_EMAIL="$2"; shift 2 ;;
            --dir) AETHER_INSTALL_DIR="$2"; shift 2 ;;
            --yes) AETHER_YES=true; shift ;;
            --resume) AETHER_RESUME=true; shift ;;
            --dry-run) AETHER_DRY_RUN=true; shift ;;
            --channel)
                [ $# -ge 2 ] || { printf '%s\n' '--channel requires stable, beta, or development' >&2; exit 2; }
                case "$2" in stable|beta|development) AETHER_RELEASE_CHANNEL="$2" ;; *) printf 'Invalid release channel: %s\n' "$2" >&2; exit 2 ;; esac
                shift 2 ;;
            --no-https) AETHER_NO_HTTPS=true; shift ;;
            --version) printf '%s\n' "$AETHER_VERSION"; exit 0 ;;
            --help) usage; exit 0 ;;
            *) printf 'Unknown option: %s\n\n' "$1" >&2; usage; exit 2 ;;
        esac
    done
    export AETHER_DOMAIN="${AETHER_DOMAIN:-}" AETHER_ADMIN_EMAIL="${AETHER_ADMIN_EMAIL:-}" \
        AETHER_YES="${AETHER_YES:-false}" AETHER_RESUME="${AETHER_RESUME:-false}" \
        AETHER_DRY_RUN="${AETHER_DRY_RUN:-false}" \
        AETHER_RELEASE_CHANNEL="${AETHER_RELEASE_CHANNEL:-stable}" \
        AETHER_NO_HTTPS="${AETHER_NO_HTTPS:-false}" \
        AETHER_INSTALL_DIR
}

run_stage() {
    local key="$1"; shift
    if [ "${AETHER_RESUME:-false}" = "true" ] && state_done "$key"; then
        info "Skipping completed stage: $key"
        return
    fi
    "$@"
    mark_done "$key"
}

main() {
    parse_args "$@"

    # Unique id for this run, shown in errors and stored in instance.json so
    # support can correlate a failure with the exact log file.
    AETHER_INSTALLATION_ID="$(date +%Y%m%d-%H%M)-$(openssl rand -hex 4 2>/dev/null || echo 00000000)"
    export AETHER_INSTALLATION_ID

    mkdir -p "$(dirname "$AETHER_LOG_FILE")"
    touch "$AETHER_LOG_FILE"
    chmod 600 "$AETHER_LOG_FILE" 2>/dev/null || true

    acquire_lock
    trap 'release_lock' EXIT

    info "Aether Cloud OS install ${AETHER_VERSION} (id ${AETHER_INSTALLATION_ID})"
    info "Install dir: ${AETHER_INSTALL_DIR} | Log: ${AETHER_LOG_FILE}"

    if [ "${AETHER_DRY_RUN:-false}" = "true" ]; then
        info "=== DRY RUN MODE — no changes will be made ==="
        run_preflight
        prompt_for_settings
        info "Dry run complete. Everything above would be executed on a real install."
        info "Install dir: $AETHER_INSTALL_DIR | Domain: $AETHER_DOMAIN | Email: $AETHER_ADMIN_EMAIL"
        exit 0
    fi

    # The stage total covers configure through finalize; preflight and
    # dependencies already called stage() themselves.
    run_stage preflight run_preflight

    # Handle existing installation: offer resume / reinstall / abort.
    if [ -n "${EXISTING_STATE:-}" ] && [ "${AETHER_RESUME:-false}" != "true" ]; then
        warn "An existing Aether installation was found at $AETHER_INSTALL_DIR"
        if [ -t 0 ]; then
            printf 'Resume the previous install? [Y/n]: '
            read -r answer || answer=""
            case "$answer" in
                ""|[Yy]*) AETHER_RESUME=true ;;
                *)
                    fatal "Aborted. To reinstall from scratch, remove $AETHER_INSTALL_DIR first, or pass --resume."
                    ;;
            esac
        else
            info "Non-interactive: resuming existing installation automatically."
            AETHER_RESUME=true
        fi
        export AETHER_RESUME
    fi

    run_stage dependencies install_dependencies
    run_stage configure configure_system
    run_stage deploy deploy_application
    run_stage finalize finalize_installation

    print_summary
    state_set status completed
    info "Installation complete."
}

if [ "$0" = "${BASH_SOURCE:-$0}" ]; then
    main "$@"
fi

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
  --email EMAIL        admin email for certificate notices
  --dir PATH             installation directory (default /opt/aether)
  --yes                  non-interactive; accept defaults
  --resume               skip stages already completed in this directory
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
            --yes) AETHER_YES=true ;;
            --resume) AETHER_RESUME=true ;;
            --help) usage; exit 0 ;;
            *) printf 'Unknown option: %s\n\n' "$1" >&2; usage; exit 2 ;;
        esac
    done
    export AETHER_DOMAIN="${AETHER_DOMAIN:-}" AETHER_ADMIN_EMAIL="${AETHER_ADMIN_EMAIL:-}" \
        AETHER_YES="${AETHER_YES:-false}" AETHER_RESUME="${AETHER_RESUME:-false}" \
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

    # The stage total covers configure through finalize; preflight and
    # dependencies already called stage() themselves.
    run_stage preflight run_preflight
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

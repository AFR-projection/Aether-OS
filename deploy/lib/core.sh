#!/usr/bin/env bash
# Aether Cloud OS — installer core library.
#
# Shared functions for logging, state, and error handling.
# This file is sourced by install.sh, never executed directly.

set -euo pipefail

AETHER_VERSION="${AETHER_VERSION:-0.1.0}"
AETHER_INSTALL_DIR="${AETHER_INSTALL_DIR:-/opt/aether}"
AETHER_STATE_DIR="${AETHER_STATE_DIR:-${AETHER_INSTALL_DIR}/state}"
AETHER_WORKSPACE_DIR="${AETHER_WORKSPACE_DIR:-${AETHER_INSTALL_DIR}/workspace}"
AETHER_UPLOADS_DIR="${AETHER_UPLOADS_DIR:-${AETHER_INSTALL_DIR}/uploads}"
AETHER_LOG_DIR="${AETHER_LOG_DIR:-${AETHER_INSTALL_DIR}/logs}"
AETHER_SECRETS_DIR="${AETHER_SECRETS_DIR:-${AETHER_INSTALL_DIR}/secrets}"
AETHER_LOG_FILE="${AETHER_LOG_FILE:-/tmp/aether-install.log}"
AETHER_LOCK_FILE="${AETHER_LOCK_FILE:-/tmp/aether-install.lock}"

# Location of the sourced libraries — $0 is unreliable inside sourced files.
AETHER_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The repository the installer deploys from (set by the root install.sh).
AETHER_REPO_DIR="${AETHER_REPO_DIR:-$(dirname "$AETHER_LIB_DIR")}"

# Set by preflight: "sudo" for unprivileged users, "" when already root.
SUDO="${SUDO:-}"
# Unique id for this run; the root install.sh generates it before staging.
AETHER_INSTALLATION_ID="${AETHER_INSTALLATION_ID:-unknown}"

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
_log() {
    local level="$1"; shift
    local ts
    ts=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
    printf '[%s] [%s] %s\n' "$ts" "$level" "$*" | tee -a "$AETHER_LOG_FILE"
}

info()  { _log "INFO " "$@"; }
warn()  { _log "WARN " "$@"; }
error() { _log "ERROR" "$@"; }
fatal() { _log "FATAL" "$@"; exit 1; }

# ---------------------------------------------------------------------------
# Lock file — prevents concurrent installs.
# ---------------------------------------------------------------------------
acquire_lock() {
    if [ -f "$AETHER_LOCK_FILE" ]; then
        local pid
        pid=$(cat "$AETHER_LOCK_FILE" 2>/dev/null || true)
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            fatal "Another Aether install is running (PID $pid). Remove $AETHER_LOCK_FILE if this is stale."
        fi
        warn "Stale lock file found; removing."
        rm -f "$AETHER_LOCK_FILE"
    fi
    echo $$ > "$AETHER_LOCK_FILE"
}

release_lock() {
    rm -f "$AETHER_LOCK_FILE"
}

# ---------------------------------------------------------------------------
# State tracking — lets the installer resume after a partial failure.
# install.state lives at the install root (contract §13.2). Recompute the
# path through this function: AETHER_INSTALL_DIR can be overridden by
# --dir after core.sh is sourced.
# ---------------------------------------------------------------------------
state_file() {
    printf '%s/install.state' "$AETHER_INSTALL_DIR"
}

state_get() {
    local key="$1" file
    file=$(state_file)
    if [ -f "$file" ]; then
        grep "^${key}=" "$file" | tail -1 | cut -d= -f2- || true
    fi
}

state_set() {
    local key="$1" value="$2" file
    file=$(state_file)
    mkdir -p "$(dirname "$file")"
    if grep -q "^${key}=" "$file" 2>/dev/null; then
        sed -i "s|^${key}=.*|${key}=${value}|" "$file"
    else
        echo "${key}=${value}" >> "$file"
    fi
}

state_done() {
    local key="$1"
    local current
    current=$(state_get "$key")
    [ "$current" = "done" ]
}

mark_done() {
    state_set "$1" "done"
    info "Stage completed: $1"
}

# ---------------------------------------------------------------------------
# Progress display
# ---------------------------------------------------------------------------
STAGE_TOTAL=4
STAGE_CURRENT=0

stage() {
    STAGE_CURRENT=$((STAGE_CURRENT + 1))
    printf '\n\033[1m[%d/%d] %s\033[0m\n' "$STAGE_CURRENT" "$STAGE_TOTAL" "$*"
}

# ---------------------------------------------------------------------------
# Misc helpers
# ---------------------------------------------------------------------------
confirm() {
    local prompt="${1:-Continue?}"
    if [ "${AETHER_YES:-false}" = "true" ]; then
        return 0
    fi
    printf '%s [y/N]: ' "$prompt"
    read -r answer
    [[ "$answer" =~ ^[Yy]$ ]]
}

command_exists() {
    command -v "$1" >/dev/null 2>&1
}

require_command() {
    local cmd="$1"
    if ! command_exists "$cmd"; then
        fatal "Required command '$cmd' is not installed."
    fi
}

detect_distro() {
    if [ -f /etc/os-release ]; then
        # shellcheck disable=SC1091
        . /etc/os-release
        echo "${ID:-unknown} ${VERSION_ID:-unknown}"
    else
        echo "unknown unknown"
    fi
}

detect_arch() {
    uname -m
}

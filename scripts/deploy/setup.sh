#!/usr/bin/env bash
# Aether Cloud OS — one-command bootstrap.
#
# This script is the official entry point for the one-liner:
#   curl -fsSL https://raw.githubusercontent.com/AFR-projection/Aether-OS/main/scripts/deploy/setup.sh | bash
#
# It either uses the checkout it finds itself in, or clones the repository to a
# temporary directory, then hands over to the multi-stage installer
# (deploy/lib/install.sh). The clone is removed when the install finishes.
#
# Running it as a non-root user who has sudo is supported: the script
# re-launches itself under sudo, because the installation writes to /opt, to
# /etc/systemd, and to the Docker socket.
#
# Everything the installer can be told is passed through:
#   ... | bash -s -- --domain aether.example.com --email you@example.com

set -euo pipefail

AETHER_REPO_URL="${AETHER_REPO_URL:-https://github.com/AFR-projection/Aether-OS.git}"
AETHER_SETUP_URL="${AETHER_SETUP_URL:-https://raw.githubusercontent.com/AFR-projection/Aether-OS/main/scripts/deploy/setup.sh}"

info() { printf '\033[0;36m[INFO]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[0;33m[WARN]\033[0m %s\n' "$*" >&2; }
error() { printf '\033[0;31m[ERROR]\033[0m %s\n' "$*" >&2; }
fatal() {
    error "$@"
    exit 1
}

# --- Privileges ------------------------------------------------------------
# Everything the installer does to /opt, systemd, and the Docker socket needs
# root, so a non-root run relaunches itself under sudo.
#
# Deliberately NOT `sudo -E`: a stock Ubuntu sudoers sets `env_reset` and does
# not grant SETENV, so `-E` is refused outright — the install would fail before
# it started for exactly the users this path exists for. The cost is that
# configuration given as environment variables does not survive the relaunch;
# flags (--domain, --email, --yes) are forwarded verbatim and are the supported
# way to configure a one-liner.
require_root() {
    [ "$(id -u)" -eq 0 ] && return 0

    command -v sudo >/dev/null 2>&1 || fatal \
        "This installer must run as root, or as a user with sudo. Re-run with: curl -fsSL $AETHER_SETUP_URL | sudo bash"

    local self="${BASH_SOURCE[0]:-}"
    local downloaded=false

    if [ ! -f "$self" ]; then
        # Piped (`curl | bash`): there is no path to hand to sudo, so fetch a copy.
        command -v curl >/dev/null 2>&1 || fatal \
            "sudo is available but curl is not, so the installer cannot re-launch itself as root. Install curl, or download the installer and run: sudo bash setup.sh"

        self="$(mktemp /tmp/aether-setup-XXXXXX.sh)"
        downloaded=true
        info "Re-running as root with sudo"
        curl -fsSL "$AETHER_SETUP_URL" -o "$self" \
            || fatal "Could not download the installer to re-run it as root."
    else
        info "Re-running as root with sudo"
    fi

    local status=0
    sudo bash "$self" "$@" || status=$?

    # Removed here rather than with a trap: the file is only this process's to
    # clean up when it is the one that downloaded it.
    [ "$downloaded" = true ] && rm -f "$self"

    exit "$status"
}

# --- Repository ------------------------------------------------------------

# A checkout is any directory holding the repo root and the installer: the
# `.git` directory is not required, because an install from a downloaded
# tarball still has everything needed to deploy.
find_checkout() {
    local dir="$1"
    if [ -f "$dir/package.json" ] && [ -f "$dir/deploy/lib/install.sh" ]; then
        printf '%s' "$dir"
        return 0
    fi
    return 1
}

# Set to the temp directory when (and only when) resolve_repo clones one, so
# main() can remove it after the install and leave an existing checkout alone.
AETHER_CLONE_DIR=""

cleanup_clone() {
    [ -n "$AETHER_CLONE_DIR" ] && rm -rf "$AETHER_CLONE_DIR"
}

resolve_repo() {
    local candidate="${BASH_SOURCE[0]:-}"
    if [ -n "$candidate" ]; then
        candidate="$(cd "$(dirname "$candidate")/../.." 2>/dev/null && pwd || true)"
    fi

    if [ -n "$candidate" ] && find_checkout "$candidate" >/dev/null; then
        info "Using the existing checkout at $candidate"
        printf '%s' "$candidate"
        return 0
    fi

    command -v git >/dev/null 2>&1 || fatal \
        "git is required to fetch Aether Cloud OS. Install it (apt-get install -y git) and run the installer again."

    local tmp
    tmp="$(mktemp -d)"

    info "Downloading Aether Cloud OS"
    git clone --quiet --depth=1 "$AETHER_REPO_URL" "$tmp" \
        || fatal "Could not clone $AETHER_REPO_URL. Check the network and the URL, then try again."

    # Verify clone succeeded and has expected structure
    if ! find_checkout "$tmp" >/dev/null; then
        error "Clone completed but required files are missing."
        error "Contents of $tmp:"
        ls -la "$tmp" 2>&1 | head -20 >&2 || true
        error "Contents of $tmp/deploy:"
        ls -la "$tmp/deploy" 2>&1 | head -20 >&2 || true
        rm -rf "$tmp"
        fatal "The downloaded repository does not look like Aether Cloud OS (no deploy/lib/install.sh)."
    fi

    # Record the clone for cleanup by main(). This assignment is why resolve_repo
    # must NOT run in a command-substitution subshell (see main): a value set in a
    # subshell would not survive, and — the bug this replaced — an EXIT trap set
    # here would fire when that subshell returned, deleting the clone before the
    # installer ever ran.
    AETHER_CLONE_DIR="$tmp"
    printf '%s' "$tmp"
}

main() {
    require_root

    # resolve_repo prints the path on fd 1 and, when it clones, records the temp
    # dir in AETHER_CLONE_DIR. Capturing its stdout with `$(...)` would run it in
    # a subshell, so that assignment would be lost and the clone never cleaned
    # up. Instead it writes the resolved path to a temp file we read back here,
    # keeping the function in this shell.
    local pathfile repo
    pathfile="$(mktemp)"
    resolve_repo >"$pathfile"
    repo="$(cat "$pathfile")"
    rm -f "$pathfile"

    # Remove the clone (if any) whenever main's shell exits, success or failure.
    trap cleanup_clone EXIT

    # The installer reads this for the source tree it deploys.
    export AETHER_REPO_DIR="$repo"

    info "Installing from $repo"
    bash "$repo/deploy/lib/install.sh" "$@"
}

main "$@"

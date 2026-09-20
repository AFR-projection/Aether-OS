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

# Whether the wordmark is drawn at all. Only --quiet sets this, and it is read
# here rather than by the installer because the banner is drawn before the
# installer exists. The installer parses the same flag from the same argv.
AETHER_UI_QUIET=false

info() { printf '\033[0;36m[INFO]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[0;33m[WARN]\033[0m %s\n' "$*" >&2; }
error() { printf '\033[0;31m[ERROR]\033[0m %s\n' "$*" >&2; }
fatal() {
    error "$@"
    exit 1
}

# --- Presentation -----------------------------------------------------------
# The first thing the operator sees, and it is drawn here rather than by the
# installer because this script runs for seconds before the installer exists —
# it clones the repository. Making the one-liner sit silent through that download
# and only then draw a wordmark would put the branding in the wrong place: the
# wait is the first thing that happens, so it is the thing that needs to look
# deliberate.
#
# Deliberately self-contained. Nothing in the repository can be sourced yet, so
# the capability test and the few escape sequences are repeated here instead of
# shared. It says AETHER_UI_BANNER_SHOWN so the installer does not draw a second
# wordmark two lines below this one.
print_banner() {
    [ "$AETHER_UI_QUIET" != "true" ] || return 0
    # Non-TTY gets nothing: this is output meant for a person, and a redirect, a
    # CI log, and a pipe all have somewhere better to put the bytes.
    [ -t 1 ] || return 0
    case "${TERM:-}" in
        "" | dumb) return 0 ;;
    esac

    local colour="" bold="" dim="" reset="" rule="-" width cols
    if [ -z "${NO_COLOR:-}" ]; then
        colour=$'\033[38;5;39m'; bold=$'\033[1m'; dim=$'\033[2m'; reset=$'\033[0m'
    fi
    case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
        *UTF-8* | *UTF8* | *utf-8* | *utf8*) rule='─' ;;
    esac

    cols="${COLUMNS:-}"
    if [ -z "$cols" ] && command -v tput >/dev/null 2>&1; then
        cols="$(tput cols 2>/dev/null || true)"
    fi
    case "$cols" in
        '' | *[!0-9]*) cols=80 ;;
    esac
    # The same clamp ui_term_width applies, so the rule below is the same length
    # as the one the installer's own banner draws a moment later. Two rules of
    # different lengths two lines apart is the kind of detail that reads as a bug.
    [ "$cols" -lt 64 ] && cols=64
    [ "$cols" -gt 100 ] && cols=100
    width=$cols

    printf '\n%s%s  AETHER CLOUD OS%s\n' "$bold" "$colour" "$reset"

    local line
    printf -v line '%*s' "$width" ''
    printf '%s  %s%s\n' "$dim" "${line// /$rule}" "$reset"

    export AETHER_UI_BANNER_SHOWN=true
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

# Removing nothing is a success, not a failure, and the difference is the exit
# code of the whole one-liner: this is an EXIT trap under `set -e`, and bash
# takes the trap's status as the script's when the trap fails. `[ -n ... ] && rm`
# fell through the test on every run that made no clone — which is every run
# from a checkout, where resolve_repo finds the tree next to the script and never
# clones — so a correct install finished by failing, `curl | bash` returned 1,
# and CI and the E2E harness read a successful install as an error. Measured on
# bash 5.2: success + failing trap = 1, failure + succeeding trap = the
# failure's own status. The reverse cannot happen, so this cannot hide a real
# failure.
cleanup_clone() {
    [ -n "$AETHER_CLONE_DIR" ] || return 0
    rm -rf "$AETHER_CLONE_DIR"
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
    local arg
    for arg in "$@"; do
        if [ "$arg" = "--quiet" ]; then
            AETHER_UI_QUIET=true
        fi
    done

    require_root

    # After require_root, so the re-launched root process is the one that draws
    # it and the operator sees one wordmark, not two.
    print_banner

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

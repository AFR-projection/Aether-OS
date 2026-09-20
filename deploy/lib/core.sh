#!/usr/bin/env bash
# Aether Cloud OS — installer core library.
#
# Shared functions for logging, state, and error handling.
# This file is sourced by install.sh, never executed directly.

set -euo pipefail

AETHER_VERSION="${AETHER_VERSION:-0.1.0}"
AETHER_INSTALL_DIR="${AETHER_INSTALL_DIR:-/opt/aether}"
AETHER_STATE_DIR="${AETHER_STATE_DIR:-${AETHER_INSTALL_DIR}/state}"
# There is deliberately no AETHER_WORKSPACE_DIR/AETHER_UPLOADS_DIR here. The
# deployed paths are <install>/data/workspace and <install>/data/uploads, set as
# AETHER_WORKSPACE_ROOT/UPLOAD_DIR in .env and matched by the compose bind
# mounts; variables naming <install>/workspace would only invite a script to
# create a second, empty workspace that the backend never serves.
AETHER_LOG_DIR="${AETHER_LOG_DIR:-${AETHER_INSTALL_DIR}/logs}"
# Whether this path was derived here or supplied by the caller. These defaults
# are computed before install.sh parses --dir, so a moved install root would
# otherwise generate secrets under the *default* root — and a later install
# with a different --dir would silently reuse them. install.sh recomputes this
# one when --dir was given, but only if it was not set explicitly.
AETHER_SECRETS_DIR_DEFAULTED=false
[ -n "${AETHER_SECRETS_DIR:-}" ] || AETHER_SECRETS_DIR_DEFAULTED=true
AETHER_SECRETS_DIR="${AETHER_SECRETS_DIR:-${AETHER_INSTALL_DIR}/secrets}"
AETHER_LOG_FILE="${AETHER_LOG_FILE:-/tmp/aether-install.log}"
AETHER_LOCK_FILE="${AETHER_LOCK_FILE:-/tmp/aether-install.lock}"

# Location of the sourced libraries — $0 is unreliable inside sourced files.
AETHER_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The repository the installer deploys from (set by the root install.sh).
#
# The fallback assumes this file sits at <repo>/deploy/lib, which is true in a
# checkout but NOT once core.sh has been copied into an installation at
# <install>/lib — there "../.." is the install directory's *parent*, i.e. /opt
# for the default /opt/aether. update.sh rsyncs from this path with --delete,
# so a wrong value would replace the source tree with a copy of /opt. The guess
# is therefore accepted only when the directory actually looks like the
# repository; otherwise it stays empty and callers take their safe branch.
if [ -z "${AETHER_REPO_DIR:-}" ]; then
    _aether_repo_candidate="$(cd "$AETHER_LIB_DIR/../.." 2>/dev/null && pwd || true)"
    if [ -n "$_aether_repo_candidate" ] &&
        [ -f "$_aether_repo_candidate/package.json" ] &&
        [ -f "$_aether_repo_candidate/deploy/lib/install.sh" ]; then
        AETHER_REPO_DIR="$_aether_repo_candidate"
    fi
    unset _aether_repo_candidate
fi
AETHER_REPO_DIR="${AETHER_REPO_DIR:-}"

# Set by preflight: "sudo" for unprivileged users, "" when already root.
#
# The default covers the post-install helper scripts, which are run through the
# `aether` CLI by an operator who may not be root: without this, `$SUDO cmd`
# would expand to a bare `cmd` and fail on permissions. preflight overrides it
# during installation with the same answer it would produce here.
if [ -z "${SUDO:-}" ] && [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
else
    SUDO="${SUDO:-}"
fi
# Unique id for this run; the root install.sh generates it before staging.
AETHER_INSTALLATION_ID="${AETHER_INSTALLATION_ID:-unknown}"

# ---------------------------------------------------------------------------
# UI layer
# ---------------------------------------------------------------------------
# The installer's presentation layer. ui-state.sh must load first — ui.sh calls
# into it. Both are optional: an installation created before this existed has
# neither file in its lib directory, and core.sh there is expected to keep
# working. When they are absent AETHER_UI_AVAILABLE stays false and _log/stage
# fall back to exactly the output they produced before, so nothing that sources
# core.sh — the installer or the standalone CLI — changes behaviour.
#
# Loading the UI does not activate it: the entry point that wants the live panel
# calls ui_init. Until then UI_MODE is "plain", which reproduces the line output,
# so `aether status`, `aether doctor`, uninstall, backup and restore look the
# same as always while still gaining secret redaction on their log lines.
if [ -f "$AETHER_LIB_DIR/ui-state.sh" ] && [ -f "$AETHER_LIB_DIR/ui.sh" ]; then
    # shellcheck source=./ui-state.sh
    source "$AETHER_LIB_DIR/ui-state.sh"
    # shellcheck source=./ui.sh
    source "$AETHER_LIB_DIR/ui.sh"
    AETHER_UI_AVAILABLE=true
else
    AETHER_UI_AVAILABLE=false
    # The stage libraries call the engine-facing UI functions directly, so those
    # names must resolve even when the UI files are absent from this lib
    # directory — an installation created before the UI layer existed, updated in
    # place, has core.sh but not ui.sh. Under `set -u`/`set -e` an undefined
    # function is a fatal "command not found", so define passthrough shims.
    #
    # ui_run is the one that matters: it *runs* the operation, so its shim must
    # execute the command and return the real exit code, not swallow it. The rest
    # are pure presentation and become no-ops. This is the same behaviour the
    # installer had before instrumentation — a plain command, run directly.
    #
    # This list has to hold every ui_* name the stage libraries call, and it is
    # the one thing here that goes stale silently: a new UI function called from
    # preflight/dependencies/configure/deploy/finalize/local-agent without a shim
    # added below is fine on a fresh install and "command not found" — fatal under
    # set -e — on an installation updated in place from one that predates ui.sh.
    # Re-check with:
    #
    #   for f in $(grep -hoE '\bui_[a-z_]+[ (]' deploy/lib/{preflight,dependencies,configure,deploy,finalize,local-agent,create-master-user}.sh | grep -oE 'ui_[a-z_]+' | sort -u); do
    #       grep -qE "^$f\(\)" deploy/lib/ui.sh || grep -qE "^    $f\(\)" deploy/lib/core.sh || echo "unshimmed: $f"
    #   done
    #
    # deploy/tests/installer-ui.sh asserts the same thing, so the count is checked
    # rather than remembered.
    ui_run() { shift; [ "$#" -gt 0 ] || return 0; "$@"; }
    ui_stage_begin_notify() { :; }
    ui_stage_done_notify() { :; }
    ui_stage_failed_notify() { :; }
    ui_stage_skipped_notify() { :; }
    ui_stage_skip_range() { :; }
    ui_note() { :; }
    ui_progress() { :; }
    ui_progress_clear() { :; }
    ui_fact_set() { :; }
    ui_profile_set() { :; }
    ui_secret_add() { :; }
    ui_prompt_prepare() { :; }
fi

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
_log() {
    local level="$1"; shift
    if [ "$AETHER_UI_AVAILABLE" = true ]; then
        ui_write_log "$level" "$*"
        return 0
    fi
    local ts
    ts=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
    printf '[%s] [%s] %s\n' "$ts" "$level" "$*" | tee -a "$AETHER_LOG_FILE"
}

info()  { _log "INFO " "$@"; }
warn()  { _log "WARN " "$@"; }
error() { _log "ERROR" "$@"; }
# A fatal error must leave the terminal usable and say why it failed exactly
# once. During a rich install the live panel owns the bottom of the screen and
# hides the cursor, so the message is not printed over it: it is recorded to the
# log file, stashed for the installer's EXIT trap to render as the error panel
# (which tears the panel down and restores the cursor), and the process exits.
# Routing it through _log instead would push the line into the activity feed and
# repaint the very panel the teardown is about to erase.
#
# When the UI is not active — a bash-3 host, or any standalone CLI command that
# sources core.sh but never calls ui_init, so UI_MODE is still "plain" — this is
# the original behaviour: the message is printed and the process exits 1.
fatal() {
    if [ "${AETHER_UI_AVAILABLE:-false}" = true ] && [ "${UI_MODE:-plain}" = "rich" ]; then
        AETHER_FATAL_MESSAGE="$*"
        ui_log_line "FATAL" "$*"
        exit 1
    fi
    _log "FATAL" "$@"
    exit 1
}

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
# The installer proper drives the UI directly with ui_stage_* by id. stage()
# survives for the standalone CLI — uninstall, backup, restore, update — which
# prints a single free-text header per operation and never runs the live panel.
# On the off chance one of those runs under an active panel (it does not today),
# the header is routed through the log/activity path so it cannot corrupt a
# frame; otherwise it prints the same bold line it always did.
STAGE_TOTAL=7
STAGE_CURRENT=0

stage() {
    STAGE_CURRENT=$((STAGE_CURRENT + 1))
    if [ "${AETHER_UI_AVAILABLE:-false}" = true ] && [ "${UI_MODE:-plain}" = "rich" ]; then
        info "$*"
        return 0
    fi
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
    # Hand the terminal back before prompting: a live panel hides the cursor and
    # owns the lines at the bottom of the screen, and a y/N read underneath an
    # invisible cursor is how a "hung" installer gets reported. The panel redraws
    # itself on the next state change.
    if [ "${AETHER_UI_AVAILABLE:-false}" = true ]; then
        ui_prompt_prepare
    fi
    printf '%s [y/N]: ' "$prompt"
    read -r answer
    [[ "$answer" =~ ^[Yy]$ ]]
}

command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# True when the text in $1 contains a line matching the pattern in the rest of
# the arguments, which are passed to grep as they are (`-E`, `-F`, `-w`, ...).
#
#   matches "$backend_logs" "\"agentId\":\"$id\".*agent connected"
#   matches "$rules" -F "8443:8452/tcp"
#
# Written this way, and not as `printf '%s' "$text" | grep -q "$pattern"`, which
# reads as the same thing and is not. `grep -q` exits at the first match, the
# process on the other end of the pipe is killed by SIGPIPE, and every script
# here runs under `set -o pipefail` — so a pipeline that found exactly what it
# was looking for reports failure. Whether that happens depends on how much
# output follows the match, which means it depends on the size of a log: the
# same check passes against a freshly started service whose log ends at the
# match, and fails against one that has been up long enough to log past it.
#
# It cost a real deployment: `aether update` confirmed the backend had accepted
# the host agent, saw a non-zero status from the pipeline that proved it, and
# rolled a healthy update back — restoring the pre-update database over it.
#
# A here-string is expanded by the shell into a file, so there is no second
# process to signal and nothing to make the pipeline fail.
matches() {
    local text="$1"
    shift
    grep --quiet "$@" <<<"$text"
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

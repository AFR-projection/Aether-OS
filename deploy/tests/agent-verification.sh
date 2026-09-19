#!/usr/bin/env bash
# Aether Cloud OS — host agent verification harness.
#
# `aether update` and `aether restore` refuse to report success until the host
# agent is confirmed connected, and roll the whole operation back when it is
# not. That check reads the backend's log and the agent's journal — and it read
# them with `... | grep -q`, which under the `set -o pipefail` that every deploy
# script sets reports failure whenever the match is not the last line of the
# output. `grep -q` exits at the match, the process writing into the pipe dies
# of SIGPIPE, and the pipeline's status becomes 141 even though the pattern was
# found.
#
# A log with anything after the match therefore made a healthy instance look
# broken, and the update rolled back over a working deployment — restoring the
# pre-update database on top of it. It passed on a freshly started service whose
# log ends at the match, which is why it survived until an update ran against an
# instance that had been up long enough to log past it.
#
# The checks below drive the real function against synthetic logs in which the
# matching line is buried in the middle, which is the case the broken form could
# not handle. Needs only bash. Runs anywhere, including Windows and CI:
#
#   bash deploy/tests/agent-verification.sh
#
# Exits 0 when every check passes, 1 when one fails. It never reports a pass for
# a check it did not run.

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
PASS=0
FAIL=0

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

ok() { PASS=$((PASS + 1)); printf '  [ ok ] %s\n' "$1"; }
fail() {
    FAIL=$((FAIL + 1))
    printf '  [FAIL] %s\n' "$1"
}
section() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

blocked() {
    printf 'BLOCKED_BY_ENVIRONMENT: %s\n' "$1"
    printf 'No checks were executed.\n'
    exit 77
}

AGENT_ID="11111111-2222-3333-4444-555555555555"

# --- an install that has a paired local agent -------------------------------
INSTALL="$WORK/install"
mkdir -p "$INSTALL"
cat > "$INSTALL/local-agent.json" <<EOF
{"agentId":"$AGENT_ID","label":"Local host","scope":"local","pairedAt":"2026-01-01T00:00:00Z"}
EOF

export AETHER_INSTALL_DIR="$INSTALL"
unset AETHER_REPO_DIR

# update.sh parses "$@" while it is being sourced, so the positional parameters
# have to be empty first or it reads this script's arguments as update flags.
set --
# shellcheck source=/dev/null
source "$REPO_DIR/deploy/scripts/update.sh" || blocked "update.sh could not be sourced"

# Sourcing it enables `set -e`, which aborts the harness on the very failures it
# exists to observe.
set +e

# --- stubs for docker and journald ------------------------------------------
BACKEND_LOG="$WORK/backend.log"
AGENT_LOG="$WORK/agent.log"

# `$SUDO journalctl` would leave the shell for a real journalctl on a host where
# the harness does not run as root; the function below is only found when the
# command is run directly.
SUDO=""

compose() {
    case "$*" in
        *logs*backend*) cat "$BACKEND_LOG" ;;
        *) return 0 ;;
    esac
}

journalctl() {
    case "$*" in
        *aether-host-agent*) cat "$AGENT_LOG" ;;
        *) return 0 ;;
    esac
}

# A log whose matching line sits between filler, well past the 64 KB pipe
# buffer. Stopping at the match leaves the writer with nowhere to put the rest,
# which is what turns the pipeline into a failure.
filler() {
    local count="$1" i
    for ((i = 0; i < count; i++)); do
        printf '{"level":30,"service":"aether-backend","msg":"request %d handled"}\n' "$i"
    done
}

write_backend_log() {
    local verdict="$1"
    {
        filler 4000
        if [ "$verdict" = "connected" ]; then
            printf '{"level":30,"subsystem":"agent-ws","agentId":"%s","msg":"agent connected"}\n' "$AGENT_ID"
        fi
        filler 4000
    } >"$BACKEND_LOG"
}

write_agent_log() {
    local verdict="$1"
    {
        filler 4000
        if [ "$verdict" = "paired" ]; then
            printf '{"level":30,"subsystem":"connection","msg":"paired with backend"}\n'
        fi
        filler 4000
    } >"$AGENT_LOG"
}

# Runs the function under test, capturing its output and status.
run_verify() {
    LAST_OUTPUT=$(verify_local_agent 2>&1)
    LAST_STATUS=$?
}

expect_status() {
    if [ "$LAST_STATUS" = "$2" ]; then
        ok "$1"
    else
        fail "$1 (expected status $2, got $LAST_STATUS)"
        printf '%s\n' "$LAST_OUTPUT" | sed 's/^/         /'
    fi
}

expect_output_has() {
    if grep -qF "$2" <<<"$LAST_OUTPUT"; then
        ok "$1"
    else
        fail "$1 (output did not contain: $2)"
        printf '%s\n' "$LAST_OUTPUT" | sed 's/^/         /'
    fi
}

# --- the checks --------------------------------------------------------------
section "A log with content after the match"
write_backend_log connected
write_agent_log paired
printf '  backend log: %s bytes, agent log: %s bytes\n' \
    "$(wc -c <"$BACKEND_LOG" | tr -d ' ')" "$(wc -c <"$AGENT_LOG" | tr -d ' ')"

run_verify
expect_status "a connected agent is confirmed" 0
expect_output_has "it says so on both sides" "confirmed on both sides"

section "The guard still refuses a half-connected instance"
write_backend_log connected
write_agent_log silent
run_verify
expect_status "the backend alone is not enough" 1

write_backend_log silent
write_agent_log paired
run_verify
expect_status "the agent alone is not enough" 1

section "An install with no agent record"
mv "$INSTALL/local-agent.json" "$INSTALL/local-agent.json.away"
run_verify
expect_status "no agent record, nothing to verify" 0
mv "$INSTALL/local-agent.json.away" "$INSTALL/local-agent.json"

printf '\n\033[1m== Summary\033[0m\n'
printf '  %d checks, %d failed\n\n' "$((PASS + FAIL))" "$FAIL"
[ "$FAIL" -eq 0 ]

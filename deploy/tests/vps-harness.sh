#!/usr/bin/env bash
# Aether Cloud OS — end-to-end install harness.
#
# Drives a real installation on a throwaway Ubuntu host and asserts the whole
# lifecycle: one-command install, status, doctor, backup/restore, update
# (including "already up to date"), repair, adoption of a source tree that has
# no Git history, reconciliation of the preview-port firewall rule, and
# uninstall with and without --purge.
#
# It needs a real machine: root, systemd, and Docker, on Ubuntu. Anywhere else
# it prints BLOCKED_BY_ENVIRONMENT and exits 77 (the conventional "skipped"
# code), so a CI runner without Docker reports a skip rather than a pass. It
# NEVER reports a pass for a check it did not run.
#
# Usage, on a fresh Ubuntu 22.04/24.04 host as root:
#
#   bash deploy/tests/vps-harness.sh                    # full run (installs twice)
#   AETHER_HARNESS_PURGE=false bash deploy/tests/vps-harness.sh   # skip the purge pass
#   AETHER_HARNESS_DOMAIN=aether.example.com bash deploy/tests/vps-harness.sh
#
# Expect 15-30 minutes: two full installs, each of which builds a frontend
# bundle and a backend image.

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALL_DIR="${AETHER_INSTALL_DIR:-/opt/aether}"
DOMAIN="${AETHER_HARNESS_DOMAIN:-}"
PURGE_PASS="${AETHER_HARNESS_PURGE:-true}"
HARNESS_LOG="${AETHER_HARNESS_LOG:-/tmp/aether-harness.log}"

CHECKS_RUN=0
CHECKS_FAILED=0
LAST_OUTPUT=""

# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------
pass() {
    CHECKS_RUN=$((CHECKS_RUN + 1))
    printf '  [ ok ] %s\n' "$1"
}

fail() {
    CHECKS_RUN=$((CHECKS_RUN + 1))
    CHECKS_FAILED=$((CHECKS_FAILED + 1))
    printf '  [FAIL] %s\n' "$1"
}

section() {
    printf '\n\033[1m== %s\033[0m\n' "$1"
}

# Runs a command, keeping its output for later assertions. Never aborts the run.
run() {
    local desc="$1"
    shift
    local status
    LAST_OUTPUT=$("$@" 2>&1)
    status=$?
    if [ $status -eq 0 ]; then
        pass "$desc"
    else
        fail "$desc (exit $status)"
        printf '%s\n' "$LAST_OUTPUT" | tail -n 20 | sed 's/^/         /'
    fi
    return 0
}

# Runs a long command whose output is far larger than what a report needs: the
# full log goes to a file, the tail into LAST_OUTPUT.
run_logged() {
    local desc="$1" logfile="$2"
    shift 2
    local status
    "$@" >"$logfile" 2>&1
    status=$?
    LAST_OUTPUT=$(tail -n 40 "$logfile")
    if [ $status -eq 0 ]; then
        pass "$desc"
    else
        fail "$desc (exit $status)"
        printf '%s\n' "$LAST_OUTPUT" | sed 's/^/         /'
    fi
    return 0
}

# Runs a command that must FAIL, which is how the destructive guards are tested.
run_expect_failure() {
    local desc="$1"
    shift
    local status
    LAST_OUTPUT=$("$@" 2>&1)
    status=$?
    if [ $status -ne 0 ]; then
        pass "$desc"
    else
        fail "$desc (expected a non-zero exit, got 0)"
    fi
    return 0
}

expect_contains() {
    local desc="$1" needle="$2"
    if grep -qF "$needle" <<<"$LAST_OUTPUT"; then
        pass "$desc"
    else
        fail "$desc (output did not contain: $needle)"
        printf '%s\n' "$LAST_OUTPUT" | tail -n 20 | sed 's/^/         /'
    fi
}

# True when $1 contains a line matching the pattern in the rest of the
# arguments, which go to grep as they are (-F, -E, ...).
#
# Written with a here-string rather than `printf ... | grep -q`: grep exits at
# the first match, the producer is killed by SIGPIPE, and this file's
# `set -o pipefail` reports the pipeline as failed — so a check that found what
# it was looking for fails whenever there was more to read. See `matches` in
# deploy/lib/core.sh, which every deploy script uses for the same reason.
text_has() {
    local text="$1"
    shift
    grep --quiet "$@" <<<"$text"
}

expect_file() {
    if [ -e "$1" ]; then pass "$2"; else fail "$2 ($1 does not exist)"; fi
}

expect_no_file() {
    if [ -e "$1" ]; then fail "$2 ($1 still exists)"; else pass "$2"; fi
}

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------
require_environment() {
    local reasons=()

    [ "$(uname -s)" = "Linux" ] || reasons+=("not Linux ($(uname -s))")
    [ "$(id -u)" -eq 0 ] || reasons+=("not running as root")
    command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ] || reasons+=("systemd is not running")
    command -v docker >/dev/null 2>&1 || reasons+=("docker is not installed")

    if [ -r /etc/os-release ]; then
        # shellcheck disable=SC1091
        . /etc/os-release
        case "${ID:-unknown}" in
            ubuntu) : ;;
            *) reasons+=("not Ubuntu (${ID:-unknown})") ;;
        esac
    else
        reasons+=("no /etc/os-release")
    fi

    if [ ${#reasons[@]} -gt 0 ]; then
        printf 'BLOCKED_BY_ENVIRONMENT: %s\n' "$(printf '%s; ' "${reasons[@]}")"
        printf 'This harness performs a real install. Run it on a fresh Ubuntu host as root,\n'
        printf 'with systemd and Docker available. No checks were executed.\n'
        exit 77
    fi
}

# ---------------------------------------------------------------------------
# Phases
# ---------------------------------------------------------------------------
phase_install() {
    section "One-command install"

    local args=(--yes)
    [ -n "$DOMAIN" ] && args+=(--domain "$DOMAIN" --email "admin@${DOMAIN}")

    run_logged "installer completes" /tmp/aether-harness-install-1.log \
        bash "$REPO_DIR/scripts/deploy/setup.sh" "${args[@]}"

    expect_file "$INSTALL_DIR/docker-compose.yml" "compose file installed"
    expect_file "$INSTALL_DIR/.env" ".env installed"
    expect_file "$INSTALL_DIR/src/.git" "source is a git checkout (needed for updates)"
    expect_file "$INSTALL_DIR/data/workspace" "workspace directory created"
    expect_file "$INSTALL_DIR/local-agent.json" "local agent recorded"
}

phase_status() {
    section "Status and diagnostics"

    run "aether status reports healthy" aether status
    expect_contains "host agent is connected" "Host Agent:         connected"
    expect_contains "database is reachable" "Database:           true"

    run "aether doctor passes" aether doctor

    run "aether version reports a commit" aether version
    if text_has "$LAST_OUTPUT" -E '^Commit: [0-9a-f]{40}$'; then
        pass "version prints a full commit sha"
    else
        fail "version prints a full commit sha"
    fi

    if systemctl is-active --quiet aether-host-agent; then
        pass "aether-host-agent.service is active"
    else
        fail "aether-host-agent.service is active"
    fi

    local agent_user
    agent_user=$(systemctl show -p User --value aether-host-agent 2>/dev/null || true)
    if [ "$agent_user" = "aether-agent" ]; then
        pass "host agent runs as the unprivileged aether-agent user"
    else
        fail "host agent runs as the unprivileged aether-agent user (got '${agent_user:-none}')"
    fi
}

phase_backup_restore() {
    section "Backup and restore"

    run "aether backup creates an archive" aether backup
    local archive
    archive=$(ls -1t "$INSTALL_DIR"/backups/aether-backup-*.tar.gz 2>/dev/null | head -n1 || true)
    if [ -n "$archive" ] && [ -f "$archive.sha256" ]; then
        pass "backup archive has a checksum"
    else
        fail "backup archive has a checksum"
    fi

    run "aether backup list" aether backup list
    expect_contains "list shows the archive" "$(basename "${archive:-none}")"

    # A corrupted archive must be refused, not restored.
    if [ -n "$archive" ]; then
        local corrupt="$INSTALL_DIR/backups/harness-corrupt.tar.gz"
        cp "$archive" "$corrupt"
        cp "$archive.sha256" "$corrupt.sha256"
        printf 'corruption' >> "$corrupt"
        run_expect_failure "restore refuses a corrupt archive" \
            aether restore "$corrupt"
        expect_contains "the refusal names the checksum" "Checksum mismatch"
        rm -f "$corrupt" "$corrupt.sha256"
    fi

    if [ -n "$archive" ]; then
        run_logged "aether restore succeeds and ends healthy" /tmp/aether-harness-restore.log \
            env AETHER_YES=true aether restore "$archive"
    fi
}

phase_update() {
    section "Git-based update"

    # The first update may legitimately have work to do — the harness may run on
    # a checkout that is behind origin/main. What must hold either way is that it
    # exits 0 and leaves a healthy instance; the *second* run is the one that
    # proves "Already up to date" is reported for an unchanged tree.
    run_logged "aether update completes" /tmp/aether-harness-update-1.log aether update --yes
    run "instance is healthy after the update" aether status

    run "second update reports already up to date" aether update --yes
    expect_contains "says so plainly" "Already up to date"

    run "update --check does not change anything" aether update --check
}

phase_update_safety() {
    section "Update safety guards"

    # Dirty tree: must refuse rather than silently discard local edits.
    printf 'harness edit\n' >> "$INSTALL_DIR/src/README.md"
    run_expect_failure "dirty tree aborts the update" aether update --yes
    expect_contains "mentions local modifications" "local modifications"
    git -C "$INSTALL_DIR/src" checkout README.md

    # Concurrent update: a second invocation must refuse while the first holds the lock.
    local lock_file="$INSTALL_DIR/state/update.lock"
    mkdir -p "$(dirname "$lock_file")"
    echo 99999 > "$lock_file"
    run_expect_failure "concurrent update is refused" aether update --yes
    expect_contains "mentions the lock" "Another update is running"
    rm -f "$lock_file"

    # Stale lock: an old PID must be removed automatically.
    echo 1 > "$lock_file"
    run "stale lock is removed automatically" aether update --check
}

phase_idempotency() {
    section "Installer idempotency"

    local agent_count_before
    agent_count_before=$(docker compose -f "$INSTALL_DIR/docker-compose.yml" exec -T postgres \
        psql -U aether -d aether -tAc "SELECT COUNT(*) FROM aether.host_agents WHERE scope='local'" 2>/dev/null | tr -d ' ' || echo 0)

    run_logged "re-run installer on existing deployment" /tmp/aether-harness-idempotency.log \
        bash "$REPO_DIR/scripts/deploy/setup.sh" --yes

    run "deployment is still healthy after re-run" aether status
    expect_contains "agent still connected" "Host Agent:         connected"

    local agent_count_after
    agent_count_after=$(docker compose -f "$INSTALL_DIR/docker-compose.yml" exec -T postgres \
        psql -U aether -d aether -tAc "SELECT COUNT(*) FROM aether.host_agents WHERE scope='local'" 2>/dev/null | tr -d ' ' || echo 0)

    if [ "$agent_count_before" = "$agent_count_after" ]; then
        pass "no duplicate agent registration (count=$agent_count_after)"
    else
        fail "no duplicate agent registration (was $agent_count_before, now $agent_count_after)"
    fi

    if systemctl list-units --type=service --all 2>/dev/null | grep -c '^aether-host-agent.service' | grep -q '^1$'; then
        pass "no duplicate systemd service"
    else
        fail "no duplicate systemd service"
    fi
}

phase_repair() {
    section "Repair"

    run "aether repair completes" aether repair

    run "aether status is still healthy afterwards" aether status
    expect_contains "host agent reconnected" "Host Agent:         connected"
}

# The state an install from a downloaded tarball ends up in, and the state a live
# instance was found in: src holds the files but no history, so there is no origin
# to fetch and `aether update` rebuilds what is already there while reporting
# success. The update has to repair that, not report it.
phase_adoption() {
    section "Adoption of a source tree with no Git history"

    rm -rf "$INSTALL_DIR/src/.git"
    expect_no_file "$INSTALL_DIR/src/.git" "history removed (the state being repaired)"

    run "update --check reports the adoption" aether update --check
    expect_contains "it names the branch it will adopt" "will adopt"
    expect_no_file "$INSTALL_DIR/src/.git" "--check changed nothing"

    run_logged "update adopts the tree and rebuilds" /tmp/aether-harness-adoption.log \
        aether update --yes

    expect_file "$INSTALL_DIR/src/.git" "src is a Git checkout again"
    expect_no_file "$INSTALL_DIR/src.pre-git" "the replaced tree was cleaned up"

    local revision
    revision=$(git -C "$INSTALL_DIR/src" rev-parse --short HEAD 2>/dev/null || echo unknown)
    if [ "$revision" != "unknown" ]; then
        pass "the adopted tree reports a revision ($revision)"
    else
        fail "the adopted tree reports a revision"
    fi

    run "instance is healthy after the adoption" aether status
    expect_contains "host agent reconnected" "Host Agent:         connected"

    # The control that makes this more than a one-off repair: the adopted tree is
    # a normal checkout, so the next update is a plain fast-forward again.
    run "a second update is a normal one" aether update --yes
    expect_contains "it reports being up to date" "Already up to date"
}

phase_rollback_injection() {
    section "Rollback on injected failure"

    # Inject a failure by breaking the backend's entrypoint. The update will try
    # to restart the stack, the backend will fail to start, health check will
    # timeout, and the rollback should restore the previous working commit.

    local current_commit
    current_commit=$(git -C "$INSTALL_DIR/src" rev-parse --short HEAD 2>/dev/null || echo unknown)

    # Create a trivial commit that will break startup
    cd "$INSTALL_DIR/src"
    echo '#!/bin/sh\nexit 42' > packages/backend/broken-entrypoint.sh
    chmod +x packages/backend/broken-entrypoint.sh
    git add packages/backend/broken-entrypoint.sh
    git commit -m "test: inject startup failure for rollback test" --no-verify 2>/dev/null || true

    # Temporarily break the backend Dockerfile to use the broken entrypoint
    local dockerfile="$INSTALL_DIR/src/packages/backend/Dockerfile"
    if [ -f "$dockerfile" ]; then
        cp "$dockerfile" "${dockerfile}.backup"
        echo 'ENTRYPOINT ["/app/broken-entrypoint.sh"]' >> "$dockerfile"
    fi

    run_expect_failure "update with broken backend triggers rollback" aether update --yes --no-pull
    expect_contains "rollback executed" "rolled back\|Rollback\|previous version"

    # Restore the Dockerfile
    if [ -f "${dockerfile}.backup" ]; then
        mv "${dockerfile}.backup" "$dockerfile"
    fi

    # Verify rollback restored the previous commit
    local after_rollback
    after_rollback=$(git -C "$INSTALL_DIR/src" rev-parse --short HEAD 2>/dev/null || echo unknown)
    if [ "$current_commit" = "$after_rollback" ]; then
        pass "rollback restored the previous commit ($current_commit)"
    else
        fail "rollback restored the previous commit (was $current_commit, now $after_rollback)"
    fi

    run "instance is healthy after rollback" aether status
    expect_contains "agent still connected after rollback" "Host Agent:         connected"

    # Clean up the injected commit
    git -C "$INSTALL_DIR/src" reset --hard HEAD~1 2>/dev/null || true
    cd /
}

# The preview ports are published by the compose file and permitted by a ufw
# rule the installer writes. An instance whose ufw was enabled after it was
# installed — or whose rules were reset — publishes ports nothing can reach,
# and an update that only ever answers "Already up to date" would never repair
# that. So the rule is removed here and an update with nothing to pull is asked
# to put it back.
phase_preview_firewall() {
    section "Preview ports and the firewall"

    # Only meaningful where a firewall is running: with ufw absent or inactive
    # the ports are reachable and there is no rule to reconcile. Reported as a
    # skip rather than a pass, so a run that never exercised this does not look
    # like one that did.
    if ! command -v ufw >/dev/null 2>&1 || ! text_has "$(ufw status 2>/dev/null || true)" '^Status: active'; then
        printf '  [skip] ufw is not installed and active, so there is no rule to reconcile\n'
        return 0
    fi

    local start count range
    start=$(sed -n 's/^AETHER_PREVIEW_PORT_START=//p' "$INSTALL_DIR/.env" 2>/dev/null | tail -n1)
    count=$(sed -n 's/^AETHER_PREVIEW_PORT_COUNT=//p' "$INSTALL_DIR/.env" 2>/dev/null | tail -n1)
    start="${start:-8443}"
    count="${count:-10}"
    range="${start}:$((start + count - 1))"

    if text_has "$(ufw status 2>/dev/null || true)" -F "$range/tcp"; then
        pass "the installer opened the preview range $range/tcp"
    else
        fail "the installer opened the preview range $range/tcp"
    fi

    ufw --force delete allow "$range/tcp" >/dev/null 2>&1 || true
    if text_has "$(ufw status 2>/dev/null || true)" -F "$range/tcp"; then
        fail "the rule was removed for the check"
    else
        pass "the rule was removed for the check"
    fi

    run "an up-to-date update is still run" aether update --yes
    expect_contains "it reports being up to date" "Already up to date"

    if text_has "$(ufw status 2>/dev/null || true)" -F "$range/tcp"; then
        pass "the rule was restored by an update that pulled nothing"
    else
        fail "the rule was restored by an update that pulled nothing"
    fi
}

phase_uninstall() {
    section "Uninstall (keeps data)"

    run "aether uninstall --yes" aether uninstall --yes

    expect_no_file "$INSTALL_DIR/docker-compose.yml" "compose file removed"
    expect_no_file "$INSTALL_DIR/src" "source tree removed"
    expect_file "$INSTALL_DIR/data/workspace" "workspace preserved"
    expect_file "$INSTALL_DIR/.env" ".env preserved"
    expect_file "$INSTALL_DIR/local-agent.json" "agent identity preserved"

    if text_has "$(systemctl list-unit-files 2>/dev/null || true)" '^aether.service'; then
        fail "aether.service removed"
    else
        pass "aether.service removed"
    fi

    if command -v docker >/dev/null 2>&1; then
        local running
        running=$(docker ps -q --filter "label=com.docker.compose.project=aether" 2>/dev/null | wc -l | tr -d ' ')
        if [ "$running" = "0" ]; then
            pass "no Aether containers left running"
        else
            fail "no Aether containers left running ($running found)"
        fi
    fi
}

phase_reinstall_and_purge() {
    section "Reinstall on preserved data, then purge"

    run_logged "reinstall succeeds" /tmp/aether-harness-install-2.log \
        bash "$REPO_DIR/scripts/deploy/setup.sh" --yes
    run "the reinstalled instance is healthy" aether status
    expect_contains "preserved data did not break the agent" "Host Agent:         connected"

    run "aether uninstall --purge --yes" aether uninstall --purge --yes
    expect_no_file "$INSTALL_DIR" "install directory removed"
    expect_no_file "/usr/local/bin/aether" "CLI symlink removed"

    if text_has "$(systemctl list-unit-files 2>/dev/null || true)" '^aether-host-agent.service'; then
        fail "aether-host-agent.service removed"
    else
        pass "aether-host-agent.service removed"
    fi
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
main() {
    printf '\033[1mAether Cloud OS — install harness\033[0m\n'
    printf 'Install dir: %s | Domain: %s | Purge pass: %s | Log: %s\n' \
        "$INSTALL_DIR" "${DOMAIN:-<none, IP-only>}" "$PURGE_PASS" "$HARNESS_LOG"

    require_environment

    exec > >(tee -a "$HARNESS_LOG") 2>&1

    phase_install
    phase_status
    phase_backup_restore
    phase_update
    phase_update_safety
    phase_idempotency
    phase_rollback_injection
    phase_repair
    phase_adoption
    phase_preview_firewall
    phase_uninstall

    if [ "$PURGE_PASS" = "true" ]; then
        phase_reinstall_and_purge
    else
        section "Purge pass skipped (AETHER_HARNESS_PURGE=$PURGE_PASS)"
    fi

    printf '\n\033[1m== Summary\033[0m\n'
    printf '  %d checks, %d failed\n' "$CHECKS_RUN" "$CHECKS_FAILED"

    if [ "$CHECKS_FAILED" -eq 0 ]; then
        printf '  All checks passed.\n\n'
        return 0
    fi

    printf '  See %s for the full run.\n\n' "$HARNESS_LOG"
    return 1
}

main "$@"

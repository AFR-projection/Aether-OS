#!/usr/bin/env bash
# Aether Cloud OS — execution-unit end-to-end harness (P1).
#
# Drives the *real* execution-unit API against a running instance and asserts
# the P1 survival matrix over the six scenarios the design of record names
# (EXECUTION-PRIMITIVE.md §9, §21, §22). It creates real units on a real host
# agent and reads their real state back — it NEVER fabricates a unit, a state,
# or a reconnection, and it NEVER reports a pass for a check it did not run.
#
# ── The six scenarios, and what P1 actually promises for each ────────────────
#
#   1. Normal execution        create → running → log → signal → exits; the
#                               happy path, fully driven by the API alone.
#   2. Backend/browser reconnect  a client that reconnects (new token, fresh
#                               GET) still sees its unit — the units surface is
#                               stateless, so a browser refresh loses nothing.
#   3. Backend restart + adoption  the backend process restarts; the agent and
#                               its units survive; the backend RE-ADOPTS them
#                               from the agent (the reported bug, DoD #7).
#   4. Agent restart            the host-agent service restarts; a `tty` unit is
#                               GONE (PTY master died → SIGHUP) and reported
#                               gone — never resurrected, never faked alive.
#   5. Aether restart           `aether restart` bounces the docker services
#                               (redis/postgres/backend/caddy) only; the agent
#                               is a SEPARATE systemd unit, so units survive and
#                               are re-adopted — same as scenario 3.
#   6. VPS reboot               the whole host reboots; every unit is GONE and
#                               reported gone; a new unit afterwards is correct.
#   7. Resource limits          a unit's own shell reports the `ulimit` ceilings
#                               it is running under — the host's answer, not
#                               Aether's — and `enforced` is checked against it.
#   8. Process tree + escalation  a grandchild is started and confirmed alive by
#                               the host, then must die with its unit; and a
#                               SIGTERM a process ignores must be reported as
#                               escalated, while a polite exit must not be.
#
# P1 solves 1, 2, 3 and 5. It does NOT make units survive an agent restart (4)
# or a reboot (6): a PTY dies with the process that owns its master fd, and P1
# ships that honestly rather than pretending otherwise. Scenarios 4 and 6 pass
# by proving the unit is reported GONE, not alive.
#
# ── Two capability tiers ─────────────────────────────────────────────────────
#
#   API tier      Needs AETHER_URL + credentials + a connected agent. Runs
#                 scenario 1 fully, scenarios 7 and 8 fully (they ask the host
#                 to report on itself through new units, so they need no shell
#                 on the VPS), and the verification half of 2/3/5/6.
#   Host tier     The restart/reboot ORCHESTRATION (scenarios 3-6) mutates a
#                 live host: it must run ON the VPS, as root, with systemctl and
#                 docker, and it is OPT-IN per action. Absent that, the scenario
#                 is reported UNEXECUTED with the exact command to run on the
#                 VPS — not PASS.
#
# A scenario is only ever PASS when it was genuinely executed and verified.
# When the environment cannot run a scenario, it is UNEXECUTED (harness present,
# environment insufficient) or BLOCKED (a real dependency failed) — never PASS.
#
# ── Usage ────────────────────────────────────────────────────────────────────
#
#   # API tier — from anywhere that can reach the instance:
#   AETHER_URL=https://dataku.id \
#   AETHER_USERNAME=master AETHER_PASSWORD=… \
#     bash deploy/tests/execution.sh
#
#   # or with a pre-obtained access token instead of a password:
#   AETHER_URL=https://dataku.id AETHER_TOKEN=eyJ… bash deploy/tests/execution.sh
#
#   # Host tier — ON the VPS, as root, opting in to the disruptive actions:
#   AETHER_URL=https://dataku.id AETHER_USERNAME=master AETHER_PASSWORD=… \
#   AETHER_EXEC_ALLOW_BACKEND_RESTART=1 \
#   AETHER_EXEC_ALLOW_AGENT_RESTART=1 \
#   AETHER_EXEC_ALLOW_AETHER_RESTART=1 \
#     bash deploy/tests/execution.sh
#
#   AETHER_AGENT_ID=…          pick a specific agent (default: the first
#                              connected one the account can see).
#   AETHER_EXEC_ALLOW_REBOOT=1 additionally run scenario 6. This REBOOTS THE
#                              HOST; only meaningful on a throwaway test VPS, and
#                              the harness cannot verify across the reboot in one
#                              process, so it prints the two-phase procedure
#                              rather than rebooting from under itself.
#
# Exit 0 when every executed scenario passed and at least one ran; 1 when an
# executed scenario failed; 77 when nothing could be executed at all.

set -uo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
AETHER_URL="${AETHER_URL:-}"
AETHER_USERNAME="${AETHER_USERNAME:-}"
AETHER_PASSWORD="${AETHER_PASSWORD:-}"
AETHER_TOKEN="${AETHER_TOKEN:-}"
AETHER_AGENT_ID="${AETHER_AGENT_ID:-}"
INSTALL_DIR="${AETHER_INSTALL_DIR:-/opt/aether}"

ALLOW_BACKEND_RESTART="${AETHER_EXEC_ALLOW_BACKEND_RESTART:-0}"
ALLOW_AGENT_RESTART="${AETHER_EXEC_ALLOW_AGENT_RESTART:-0}"
ALLOW_AETHER_RESTART="${AETHER_EXEC_ALLOW_AETHER_RESTART:-0}"
ALLOW_REBOOT="${AETHER_EXEC_ALLOW_REBOOT:-0}"

PASS=0
FAIL=0
SKIP=0

# Per-scenario verdicts, printed in the final matrix.
declare -A VERDICT
declare -A VERDICT_NOTE
SCENARIOS=(1 2 3 4 5 6 7 8)
declare -A SCENARIO_TITLE=(
    [1]="Normal execution"
    [2]="Backend/browser reconnect"
    [3]="Backend restart + adoption"
    [4]="Agent restart behaviour"
    [5]="Aether restart behaviour"
    [6]="VPS reboot behaviour"
    [7]="Resource limits enforced"
    [8]="Process-tree kill + escalation"
)

# Units created during the run, torn down on exit.
CREATED_UNITS=()

# ---------------------------------------------------------------------------
# Reporting (house style: ok/fail/section, PASS/FAIL counters)
# ---------------------------------------------------------------------------
ok() { PASS=$((PASS + 1)); printf '  [ ok ] %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  [FAIL] %s\n' "$1"; }
skip() { SKIP=$((SKIP + 1)); printf '  [skip] %s\n' "$1"; }
section() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
note() { printf '         %s\n' "$1"; }

# Records the outcome of a whole scenario for the summary matrix.
verdict() {
    local n="$1" v="$2" msg="${3:-}"
    VERDICT[$n]="$v"
    VERDICT_NOTE[$n]="$msg"
}

blocked() {
    printf 'BLOCKED_BY_ENVIRONMENT: %s\n' "$1"
    printf 'No scenarios were executed.\n'
    exit 77
}

# ---------------------------------------------------------------------------
# HTTP — a real API client, or nothing. No mock path exists.
# ---------------------------------------------------------------------------
API_READY=false
ACCESS_TOKEN=""

# Emits the HTTP body followed by a final line "HTTP_STATUS:<code>", so a caller
# can split the two without a temp file. Uses --fail-with-body semantics by
# hand: we always want the body, even on a 4xx, to read the error code.
http() {
    local method="$1" path="$2" data="${3:-}"
    local args=(-sS -X "$method" -H "Authorization: Bearer $ACCESS_TOKEN"
        -w $'\nHTTP_STATUS:%{http_code}' --max-time 30)
    if [ -n "$data" ]; then
        args+=(-H 'Content-Type: application/json' --data "$data")
    fi
    curl "${args[@]}" "${AETHER_URL%/}$path" 2>/dev/null
}

http_body() { sed '$d' <<<"$1"; }
http_status() { sed -n '$s/HTTP_STATUS:\([0-9]*\)/\1/p' <<<"$1"; }

# Reads one JSON field with jq. jq is required for the API tier; without it we
# would be parsing JSON with regex, which is exactly the fake-state risk the
# brief forbids, so its absence blocks the tier rather than degrading it.
jqf() { jq -r "$2" <<<"$1" 2>/dev/null; }

# ---------------------------------------------------------------------------
# Capability probes
# ---------------------------------------------------------------------------
probe_api() {
    [ -n "$AETHER_URL" ] || return 1
    command -v curl >/dev/null 2>&1 || { note "curl is not installed"; return 1; }
    command -v jq >/dev/null 2>&1 || { note "jq is not installed"; return 1; }

    # Obtain a token: either given, or from a login.
    if [ -n "$AETHER_TOKEN" ]; then
        ACCESS_TOKEN="$AETHER_TOKEN"
    elif [ -n "$AETHER_USERNAME" ] && [ -n "$AETHER_PASSWORD" ]; then
        local resp status
        resp="$(http POST /api/auth/login \
            "$(jq -n --arg u "$AETHER_USERNAME" --arg p "$AETHER_PASSWORD" \
                '{username:$u,password:$p}')")"
        status="$(http_status "$resp")"
        if [ "$status" != "200" ] && [ "$status" != "201" ]; then
            note "login failed (HTTP ${status:-no response})"
            return 1
        fi
        ACCESS_TOKEN="$(jqf "$(http_body "$resp")" '.data.accessToken')"
    else
        note "no AETHER_TOKEN and no AETHER_USERNAME/AETHER_PASSWORD"
        return 1
    fi
    [ -n "$ACCESS_TOKEN" ] && [ "$ACCESS_TOKEN" != "null" ] || { note "no access token"; return 1; }

    # A connected agent is required — there is nothing to run a unit on without
    # one, and we will not invent it.
    local resp status
    resp="$(http GET /api/agents)"
    status="$(http_status "$resp")"
    [ "$status" = "200" ] || { note "GET /api/agents returned HTTP ${status:-none}"; return 1; }

    if [ -z "$AETHER_AGENT_ID" ]; then
        AETHER_AGENT_ID="$(jqf "$(http_body "$resp")" '[.data[] | select(.connected==true)][0].agentId')"
    fi
    if [ -z "$AETHER_AGENT_ID" ] || [ "$AETHER_AGENT_ID" = "null" ]; then
        note "no connected agent is visible to this account"
        return 1
    fi
    return 0
}

# Is this process running on the host, with the tools to bounce services?
on_host_with_systemd() {
    [ "$(uname -s)" = "Linux" ] || return 1
    [ "$(id -u)" -eq 0 ] || return 1
    command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ] || return 1
}

# ---------------------------------------------------------------------------
# Unit helpers — every one hits the real API.
# ---------------------------------------------------------------------------

# Creates a command unit that runs $1; echoes the new unit id, or empty on error.
create_command_unit() {
    local cmd="$1" wall="${2:-null}" resp status id
    resp="$(http POST /api/units \
        "$(jq -n --arg a "$AETHER_AGENT_ID" --arg c "$cmd" --argjson w "$wall" \
            '{agentId:$a,kind:"command",command:$c,wallClockMs:$w}')")"
    status="$(http_status "$resp")"
    if [ "$status" != "201" ]; then
        note "create returned HTTP ${status:-none}: $(http_body "$resp" | head -c 200)"
        return 1
    fi
    id="$(jqf "$(http_body "$resp")" '.data.unit.id')"
    [ -n "$id" ] && [ "$id" != "null" ] || return 1
    CREATED_UNITS+=("$id")
    printf '%s' "$id"
}

# Echoes a unit's current state, or "MISSING" for a 404, or "ERR:<code>".
unit_state() {
    local id="$1" resp status
    resp="$(http GET "/api/units/$id?agentId=$AETHER_AGENT_ID")"
    status="$(http_status "$resp")"
    case "$status" in
        200) jqf "$(http_body "$resp")" '.data.unit.state' ;;
        404) printf 'MISSING' ;;
        *) printf 'ERR:%s' "$status" ;;
    esac
}

# Polls until the state matches $2 (or a terminal state), up to $3 seconds.
wait_for_state() {
    local id="$1" want="$2" secs="${3:-15}" i s
    for ((i = 0; i < secs * 2; i++)); do
        s="$(unit_state "$id")"
        [ "$s" = "$want" ] && { printf '%s' "$s"; return 0; }
        case "$s" in exited | failed | killed | MISSING) printf '%s' "$s"; return 0 ;; esac
        sleep 0.5
    done
    printf '%s' "$(unit_state "$id")"
}

# Creates a unit from a raw JSON body (sans agentId, which is filled in here).
# Echoes the new unit id, or empty on error, and leaves the full response body
# in LAST_CREATE_BODY so a caller can assert on the returned unit record without
# a second request. Used by the scenarios that need fields
# `create_command_unit` does not carry — rlimits, in particular.
LAST_CREATE_BODY=""
create_unit_raw() {
    local body="$1" resp status id
    resp="$(http POST /api/units \
        "$(jq -c --arg a "$AETHER_AGENT_ID" '. + {agentId:$a}' <<<"$body")")"
    status="$(http_status "$resp")"
    if [ "$status" != "201" ]; then
        note "create returned HTTP ${status:-none}: $(http_body "$resp" | head -c 300)"
        return 1
    fi
    LAST_CREATE_BODY="$(http_body "$resp")"
    id="$(jqf "$LAST_CREATE_BODY" '.data.unit.id')"
    [ -n "$id" ] && [ "$id" != "null" ] || return 1
    CREATED_UNITS+=("$id")
    printf '%s' "$id"
}

# Reads a unit's combined log as decoded text. Empty on any error.
read_unit_log() {
    local id="$1" resp status
    resp="$(http GET "/api/units/$id/log?agentId=$AETHER_AGENT_ID")"
    status="$(http_status "$resp")"
    [ "$status" = "200" ] || return 1
    jqf "$(http_body "$resp")" '.contentBase64' | base64 -d 2>/dev/null
}

# Polls a unit's log until it contains $2, up to $3 seconds. Echoes the log.
wait_for_log() {
    local id="$1" needle="$2" secs="${3:-15}" i out
    for ((i = 0; i < secs * 2; i++)); do
        out="$(read_unit_log "$id")"
        grep -q -- "$needle" <<<"$out" && { printf '%s' "$out"; return 0; }
        sleep 0.5
    done
    printf '%s' "$out"
    return 1
}

# Reads one field out of a unit fetched fresh from the API.
unit_field() {
    local id="$1" path="$2" resp
    resp="$(http GET "/api/units/$id?agentId=$AETHER_AGENT_ID")"
    jqf "$(http_body "$resp")" "$path"
}

kill_unit() {
    local id="$1"
    http DELETE "/api/units/$id?agentId=$AETHER_AGENT_ID" >/dev/null 2>&1 || true
}

cleanup() {
    if [ "$API_READY" = true ]; then
        local id
        for id in "${CREATED_UNITS[@]:-}"; do
            [ -n "$id" ] && kill_unit "$id"
        done
    fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Scenario 1 — normal execution (API tier, fully executable)
# ---------------------------------------------------------------------------
scenario_1() {
    section "Scenario 1 — normal execution"
    local before_fail_local="$FAIL"
    local id state

    # A unit that lives long enough to be observed running, then exits 0.
    id="$(create_command_unit 'echo aether-e2e-start; sleep 2; echo aether-e2e-done')" || {
        fail "create a command unit"
        verdict 1 FAIL "unit creation failed"
        return
    }
    ok "created a command unit ($id)"

    state="$(unit_state "$id")"
    case "$state" in
        starting | running) ok "the unit is $state right after creation" ;;
        *) fail "the unit should be starting/running, is '$state'" ;;
    esac

    # Its log carries the real stdout it produced.
    sleep 1
    local logresp logstatus content
    logresp="$(http GET "/api/units/$id/log?agentId=$AETHER_AGENT_ID")"
    logstatus="$(http_status "$logresp")"
    if [ "$logstatus" = "200" ]; then
        content="$(jqf "$(http_body "$logresp")" '.contentBase64' | base64 -d 2>/dev/null)"
        if grep -q 'aether-e2e-start' <<<"$content"; then
            ok "the unit's real stdout is readable from its log"
        else
            fail "the log did not contain the unit's output"
            note "got: $(head -c 120 <<<"$content")"
        fi
    else
        fail "reading the unit log (HTTP $logstatus)"
    fi

    # It reaches a clean exit on its own.
    state="$(wait_for_state "$id" exited 10)"
    if [ "$state" = "exited" ]; then
        ok "the unit exited cleanly on its own"
    else
        fail "the unit should have exited, is '$state'"
    fi

    # A signalled unit is never reported as a clean success (§8, §10).
    local id2 state2
    id2="$(create_command_unit 'sleep 30')" || { fail "create a second unit to signal"; verdict 1 FAIL "second create failed"; return; }
    ok "created a long-running unit to signal ($id2)"
    wait_for_state "$id2" running 5 >/dev/null
    local sigresp sigstatus
    sigresp="$(http POST "/api/units/$id2/signal?agentId=$AETHER_AGENT_ID" '{"signal":"SIGTERM"}')"
    sigstatus="$(http_status "$sigresp")"
    [ "$sigstatus" = "200" ] && ok "SIGTERM accepted" || fail "signalling the unit (HTTP $sigstatus)"
    state2="$(wait_for_state "$id2" killed 8)"
    case "$state2" in
        killed | failed) ok "a signalled unit is reported '$state2', never a clean exit" ;;
        *) fail "a signalled unit should be killed/failed, is '$state2'" ;;
    esac

    if [ "$FAIL" -eq "$before_fail_local" ]; then
        verdict 1 PASS "create/run/log/signal/exit all verified"
    else
        verdict 1 FAIL "one or more checks failed"
    fi
}

# ---------------------------------------------------------------------------
# Scenario 2 — backend/browser reconnect (API tier, fully executable)
# ---------------------------------------------------------------------------
scenario_2() {
    section "Scenario 2 — backend/browser reconnect"
    # The units surface is a stateless proxy over the agent, so a client that
    # "reconnects" is just a fresh request. We prove a unit created under one
    # session is still fully visible under a newly obtained session — the
    # property a browser refresh depends on.
    local id
    id="$(create_command_unit 'sleep 30')" || { fail "create a unit to reconnect to"; verdict 2 FAIL "create failed"; return; }
    ok "created a unit before the reconnect ($id)"
    wait_for_state "$id" running 5 >/dev/null

    if [ -n "$AETHER_USERNAME" ] && [ -n "$AETHER_PASSWORD" ]; then
        # Re-login: a genuinely new token/session, as a fresh browser tab gets.
        local resp status newtok
        resp="$(http POST /api/auth/login \
            "$(jq -n --arg u "$AETHER_USERNAME" --arg p "$AETHER_PASSWORD" '{username:$u,password:$p}')")"
        status="$(http_status "$resp")"
        newtok="$(jqf "$(http_body "$resp")" '.data.accessToken')"
        if [ "$status" = "200" ] && [ -n "$newtok" ] && [ "$newtok" != "null" ]; then
            local saved="$ACCESS_TOKEN"
            ACCESS_TOKEN="$newtok"
            local state
            state="$(unit_state "$id")"
            if [ "$state" = "running" ]; then
                ok "the unit is still running under a freshly re-authenticated session"
            else
                fail "the unit should survive a client reconnect, is '$state'"
            fi
            ACCESS_TOKEN="$saved"
            verdict 2 "$([ "$state" = "running" ] && echo PASS || echo FAIL)" "re-auth then re-fetch"
        else
            fail "re-login for the reconnect (HTTP $status)"
            verdict 2 FAIL "re-login failed"
        fi
    else
        # With only a static token we can still prove statelessness across a
        # fresh fetch, but not a new session.
        local state
        state="$(unit_state "$id")"
        [ "$state" = "running" ] && ok "the unit is visible on a fresh request" || fail "the unit vanished on re-fetch ('$state')"
        verdict 2 PARTIAL "verified stateless re-fetch; a full new-session reconnect needs username/password"
    fi
    kill_unit "$id"
}

# ---------------------------------------------------------------------------
# Restart orchestration, shared by scenarios 3, 4, 5
# ---------------------------------------------------------------------------

# Reports why a host-tier action cannot run, or empty string if it can.
host_block_reason() {
    on_host_with_systemd || { printf 'not on a Linux host with systemd/root'; return; }
    printf ''
}

# Scenario 3 & 5 share this shape: create a unit, perform a restart that leaves
# the AGENT alive, and assert the unit survived and is re-adopted (still
# readable, still running). $1 = scenario number, $2 = human action, $3.. =
# command to perform the restart.
survive_restart_scenario() {
    local n="$1" action="$2"
    shift 2
    local id before_state after_state

    id="$(create_command_unit 'sleep 120')" || { fail "create a unit before the $action"; verdict "$n" FAIL "create failed"; return; }
    ok "created a unit before the $action ($id)"
    before_state="$(wait_for_state "$id" running 5)"
    [ "$before_state" = "running" ] && ok "the unit is running before the $action" || note "pre-state: $before_state"

    note "performing: $* ..."
    if ! "$@"; then
        fail "the $action command failed"
        verdict "$n" BLOCKED "$action command exited non-zero"
        return
    fi

    # Give the agent a moment to re-handshake to the restarted backend, then the
    # backend a moment to re-adopt on the next reconcile (a list triggers it).
    sleep 8
    http GET "/api/units?agentId=$AETHER_AGENT_ID&scope=mine" >/dev/null 2>&1 || true
    sleep 2

    after_state="$(unit_state "$id")"
    if [ "$after_state" = "running" ]; then
        ok "the unit survived the $action and is re-adopted (still running)"
        verdict "$n" PASS "unit survived and was re-adopted"
    else
        fail "the unit should survive the $action, is '$after_state'"
        verdict "$n" FAIL "unit was '$after_state' after $action"
    fi
    kill_unit "$id"
}

# ---------------------------------------------------------------------------
# Scenario 3 — backend restart + adoption
# ---------------------------------------------------------------------------
scenario_3() {
    section "Scenario 3 — backend restart + adoption"
    local reason
    reason="$(host_block_reason)"
    if [ -n "$reason" ] || [ "$ALLOW_BACKEND_RESTART" != "1" ]; then
        skip "backend restart not performed ($([ -n "$reason" ] && echo "$reason" || echo 'AETHER_EXEC_ALLOW_BACKEND_RESTART!=1'))"
        note "To run on the VPS:  AETHER_EXEC_ALLOW_BACKEND_RESTART=1 (re)run this harness there."
        note "It restarts only the backend container:  docker compose -f $INSTALL_DIR/docker-compose.yml restart backend"
        note "Expected: the agent survives, the unit survives, the backend re-adopts it."
        verdict 3 UNEXECUTED "needs VPS + AETHER_EXEC_ALLOW_BACKEND_RESTART=1"
        return
    fi
    survive_restart_scenario 3 "backend restart" \
        docker compose -f "$INSTALL_DIR/docker-compose.yml" restart backend
}

# ---------------------------------------------------------------------------
# Scenario 4 — agent restart (units are GONE, reported gone)
# ---------------------------------------------------------------------------
scenario_4() {
    section "Scenario 4 — agent restart behaviour"
    local reason
    reason="$(host_block_reason)"
    if [ -n "$reason" ] || [ "$ALLOW_AGENT_RESTART" != "1" ]; then
        skip "agent restart not performed ($([ -n "$reason" ] && echo "$reason" || echo 'AETHER_EXEC_ALLOW_AGENT_RESTART!=1'))"
        note "To run on the VPS:  AETHER_EXEC_ALLOW_AGENT_RESTART=1 (re)run this harness there."
        note "It restarts the agent service:  systemctl restart aether-host-agent"
        note "Expected (P1, honest): the unit is GONE and reported gone — a PTY dies with the agent."
        verdict 4 UNEXECUTED "needs VPS + AETHER_EXEC_ALLOW_AGENT_RESTART=1"
        return
    fi

    local id after
    id="$(create_command_unit 'sleep 120')" || { fail "create a unit before the agent restart"; verdict 4 FAIL "create failed"; return; }
    ok "created a unit before the agent restart ($id)"
    wait_for_state "$id" running 5 >/dev/null

    note "performing: systemctl restart aether-host-agent ..."
    if ! systemctl restart aether-host-agent; then
        fail "restarting the agent service"
        verdict 4 BLOCKED "systemctl restart failed"
        return
    fi
    # Wait for the agent to come back and re-handshake.
    sleep 10
    http GET "/api/units?agentId=$AETHER_AGENT_ID&scope=mine" >/dev/null 2>&1 || true
    sleep 2

    after="$(unit_state "$id")"
    # The honest P1 outcome: the process is gone. It is reported MISSING (the
    # agent no longer holds it) or in a terminal state — never running.
    case "$after" in
        running | starting)
            fail "the unit is reported '$after' after an agent restart — P1 must report it gone, not alive"
            verdict 4 FAIL "unit falsely reported alive"
            ;;
        MISSING | exited | failed | killed | stale)
            ok "the unit is reported gone ('$after') after the agent restart, not resurrected"
            verdict 4 PASS "unit correctly reported gone ('$after')"
            ;;
        *)
            fail "unexpected state after agent restart: '$after'"
            verdict 4 FAIL "unexpected state '$after'"
            ;;
    esac
}

# ---------------------------------------------------------------------------
# Scenario 5 — Aether restart (docker services only; agent survives)
# ---------------------------------------------------------------------------
scenario_5() {
    section "Scenario 5 — Aether restart behaviour"
    local reason
    reason="$(host_block_reason)"
    if [ -n "$reason" ] || [ "$ALLOW_AETHER_RESTART" != "1" ]; then
        skip "aether restart not performed ($([ -n "$reason" ] && echo "$reason" || echo 'AETHER_EXEC_ALLOW_AETHER_RESTART!=1'))"
        note "To run on the VPS:  AETHER_EXEC_ALLOW_AETHER_RESTART=1 (re)run this harness there."
        note "'aether restart' bounces redis/postgres/backend/caddy only; the agent is a separate systemd unit."
        note "Expected: the agent survives, the unit survives and is re-adopted — like scenario 3."
        verdict 5 UNEXECUTED "needs VPS + AETHER_EXEC_ALLOW_AETHER_RESTART=1"
        return
    fi
    survive_restart_scenario 5 "aether restart" \
        docker compose -f "$INSTALL_DIR/docker-compose.yml" restart
}

# ---------------------------------------------------------------------------
# Scenario 6 — VPS reboot (everything gone; verified across two phases)
# ---------------------------------------------------------------------------
scenario_6() {
    section "Scenario 6 — VPS reboot behaviour"
    # A reboot tears down the very process running this harness, so it cannot be
    # verified in a single invocation without a fake. We do not fake it: we
    # print the honest two-phase procedure and mark it UNEXECUTED unless a
    # previously-recorded pre-reboot unit id is handed back for phase two.
    local marker="${AETHER_EXEC_REBOOT_MARKER:-}"
    if [ -n "$marker" ]; then
        # Phase two: after the reboot, assert the recorded unit is gone.
        local after
        after="$(unit_state "$marker")"
        case "$after" in
            MISSING | exited | failed | killed | stale)
                ok "after the reboot, the pre-reboot unit is reported gone ('$after')"
                # And a brand-new unit works.
                local fresh fstate
                fresh="$(create_command_unit 'echo post-reboot-ok')" && {
                    fstate="$(wait_for_state "$fresh" exited 8)"
                    [ "$fstate" = "exited" ] && ok "a new unit runs correctly after the reboot" || fail "post-reboot unit state '$fstate'"
                }
                verdict 6 PASS "pre-reboot unit gone; new unit works"
                ;;
            running | starting)
                fail "the pre-reboot unit is '$after' — a reboot must not leave it alive"
                verdict 6 FAIL "unit falsely alive after reboot"
                ;;
            *) fail "unexpected post-reboot state '$after'"; verdict 6 FAIL "unexpected '$after'" ;;
        esac
        return
    fi

    if [ "$ALLOW_REBOOT" != "1" ] || ! on_host_with_systemd; then
        skip "reboot not performed (needs the VPS + AETHER_EXEC_ALLOW_REBOOT=1)"
        note "Reboot cannot be verified in one process. Two-phase procedure on a throwaway VPS:"
        note "  1) create a unit and note its id:"
        note "     curl -sS -H \"Authorization: Bearer \$TOKEN\" -X POST \$AETHER_URL/api/units \\"
        note "       -H 'Content-Type: application/json' \\"
        note "       --data '{\"agentId\":\"'\"\$AETHER_AGENT_ID\"'\",\"kind\":\"command\",\"command\":\"sleep 3600\"}'"
        note "  2) reboot:  sudo reboot"
        note "  3) after it comes back, re-run with AETHER_EXEC_REBOOT_MARKER=<that unit id>"
        note "Expected: the pre-reboot unit is reported gone; a new unit works."
        verdict 6 UNEXECUTED "needs VPS + reboot; verified in two phases (see AETHER_EXEC_REBOOT_MARKER)"
        return
    fi

    # On the host and allowed: create the marker unit and tell the operator how
    # to complete phase two. We deliberately do NOT call reboot ourselves — a
    # harness that reboots from under its own report can prove nothing.
    local id
    id="$(create_command_unit 'sleep 3600')" || { fail "create the pre-reboot marker unit"; verdict 6 FAIL "create failed"; return; }
    note "Created pre-reboot marker unit: $id"
    note "Now: sudo reboot; then re-run with AETHER_EXEC_REBOOT_MARKER=$id"
    skip "reboot marker created; phase two completes verification after the reboot"
    verdict 6 UNEXECUTED "marker unit $id created; re-run post-reboot with AETHER_EXEC_REBOOT_MARKER=$id"
}

# ---------------------------------------------------------------------------
# Scenario 7 — resource limits are really enforced on the host (API tier)
# ---------------------------------------------------------------------------
scenario_7() {
    section "Scenario 7 — resource limits enforced on the host"
    # A limit recorded but not applied is worse than no limit: the caller
    # believes the process is bounded and it is not. So this scenario does not
    # stop at reading back what it sent. It has the *unit's own shell* report the
    # ceilings it is running under, which is the host's answer, not Aether's.
    local before_fail_local="$FAIL" id out

    # `ulimit -Sn`/`-Hn` are the soft and hard file-descriptor ceilings, `-Sv`
    # the soft address space. The hard value matching the soft one is what makes
    # the bound unraisable by the process itself.
    local base='{"kind":"command","command":"echo \"soft=$(ulimit -Sn) hard=$(ulimit -Hn) v=$(ulimit -Sv)\""'
    local with_rlimits="${base}"',"rlimits":{"maxOpenFiles":128,"addressSpaceBytes":268435456}}'

    id="$(create_unit_raw "$with_rlimits")" || {
        fail "create a unit with rlimits"
        verdict 7 FAIL "create failed"
        return
    }
    ok "created a unit asking for maxOpenFiles=128, addressSpaceBytes=256MiB ($id)"

    # The create response carries what the agent says it did.
    local enforced
    enforced="$(jqf "$LAST_CREATE_BODY" '.data.unit.limits.enforced')"
    [ "$enforced" = "true" ] \
        && ok "the agent reports the limits as enforced" \
        || fail "the agent reported enforced='$enforced' for a POSIX host"

    out="$(wait_for_log "$id" 'soft=' 15)" || {
        fail "the unit produced no output to read"
        verdict 7 FAIL "no log output"
        return
    }

    # What the process itself saw. This is the enforcement proof.
    if grep -q 'soft=128' <<<"$out"; then
        ok "the shell inside the unit sees a soft limit of 128 file descriptors"
    else
        fail "the unit's shell did not see the requested soft limit"
        note "got: $(tr -d '\r' <<<"$out" | head -c 200)"
    fi
    if grep -q 'hard=128' <<<"$out"; then
        ok "the hard limit is 128 too — the process cannot raise it back"
    else
        fail "the hard limit was not set, so the bound is raisable"
        note "got: $(tr -d '\r' <<<"$out" | head -c 200)"
    fi
    if grep -q 'v=262144' <<<"$out"; then
        ok "the address-space limit reached the process (256 MiB in the shell's units)"
    else
        fail "the address-space limit did not reach the process"
        note "got: $(tr -d '\r' <<<"$out" | head -c 200)"
    fi

    # The mirror: a unit that asks for nothing must not have its limits changed,
    # and must not be reported as enforced. Otherwise `enforced` is decoration.
    local plain
    plain="$(create_command_unit 'echo "hard=$(ulimit -Hn)"')" || {
        fail "create a unit with no rlimits"
        verdict 7 FAIL "control create failed"
        return
    }
    local plain_enforced
    plain_enforced="$(unit_field "$plain" '.data.unit.limits.enforced')"
    [ "$plain_enforced" = "false" ] \
        && ok "a unit that asked for no rlimits is reported unenforced" \
        || fail "a unit with no limits reported enforced='$plain_enforced'"

    if [ "$FAIL" -eq "$before_fail_local" ]; then
        verdict 7 PASS "ulimit reached the real process; enforced reports the truth"
    else
        verdict 7 FAIL "one or more checks failed"
    fi
}

# ---------------------------------------------------------------------------
# Scenario 8 — the whole process tree dies, and escalation is honest
# ---------------------------------------------------------------------------
scenario_8() {
    section "Scenario 8 — process-tree kill and SIGTERM→SIGKILL escalation"
    # A unit is a shell *and everything it started*. A kill that reaches only
    # the shell leaves children burning CPU — the failure mode where a build
    # "stops" and its compiler keeps running. The grandchild's liveness is
    # checked by asking the host itself, through a fresh unit, so this holds
    # from the API tier without assuming the harness is on the VPS.
    local before_fail_local="$FAIL" id out grandchild

    id="$(create_command_unit 'sh -c "sleep 300" & echo "GRANDCHILD=$!"; wait')" || {
        fail "create a unit that starts a grandchild"
        verdict 8 FAIL "create failed"
        return
    }
    out="$(wait_for_log "$id" 'GRANDCHILD=' 15)" || {
        fail "the unit never reported its grandchild pid"
        verdict 8 FAIL "no grandchild"
        return
    }
    grandchild="$(sed -n 's/.*GRANDCHILD=\([0-9]\+\).*/\1/p' <<<"$out" | head -1)"
    if [ -z "$grandchild" ]; then
        fail "could not parse the grandchild pid"
        verdict 8 FAIL "parse failed"
        return
    fi
    ok "the unit started a grandchild process (pid $grandchild)"

    # Before: the host confirms the grandchild exists.
    local probe_before
    probe_before="$(create_command_unit "kill -0 $grandchild 2>/dev/null && echo ALIVE || echo GONE")"
    out="$(wait_for_log "$probe_before" 'ALIVE\|GONE' 10)"
    if grep -q 'ALIVE' <<<"$out"; then
        ok "the host confirms the grandchild is running before the kill"
    else
        fail "the grandchild was not running before the kill — the test would prove nothing"
        verdict 8 FAIL "grandchild not alive before kill"
        return
    fi

    # Killing the unit must take the grandchild with it.
    kill_unit "$id"
    wait_for_state "$id" killed 8 >/dev/null

    local probe_after
    probe_after="$(create_command_unit "kill -0 $grandchild 2>/dev/null && echo ALIVE || echo GONE")"
    out="$(wait_for_log "$probe_after" 'ALIVE\|GONE' 10)"
    if grep -q 'GONE' <<<"$out"; then
        ok "the grandchild is gone too — the kill reached the whole process group"
    else
        fail "the grandchild survived the kill of its unit (orphaned process)"
        note "grandchild pid $grandchild is still running on the host"
    fi

    # --- escalation ---
    # A shell that ignores SIGTERM cannot be ended politely. The caller is told
    # so, rather than left to guess why nothing happened.
    local stubborn sigresp escalated
    stubborn="$(create_command_unit 'trap "" TERM; echo READY; while true; do sleep 1; done')" || {
        fail "create a unit that ignores SIGTERM"
        verdict 8 FAIL "stubborn create failed"
        return
    }
    wait_for_log "$stubborn" 'READY' 15 >/dev/null

    sigresp="$(http POST "/api/units/$stubborn/signal?agentId=$AETHER_AGENT_ID" \
        '{"signal":"SIGTERM","escalateAfterMs":500}')"
    escalated="$(jqf "$(http_body "$sigresp")" '.data.escalated')"
    [ "$escalated" = "true" ] \
        && ok "the API reports escalated=true when SIGTERM could not end the unit" \
        || fail "escalation not reported for a process that ignores SIGTERM (got '$escalated')"

    local sstate
    sstate="$(wait_for_state "$stubborn" killed 8)"
    case "$sstate" in
        killed | failed | exited) ok "the escalated unit is actually gone ('$sstate')" ;;
        *) fail "the unit survived the escalation, is '$sstate'" ;;
    esac

    # The mirror: a process that exits politely must NOT be reported escalated.
    local polite sigresp2 escalated2
    polite="$(create_command_unit 'sleep 300')" || { fail "create a polite unit"; verdict 8 FAIL "polite create failed"; return; }
    wait_for_state "$polite" running 5 >/dev/null
    sigresp2="$(http POST "/api/units/$polite/signal?agentId=$AETHER_AGENT_ID" \
        '{"signal":"SIGTERM","escalateAfterMs":5000}')"
    escalated2="$(jqf "$(http_body "$sigresp2")" '.data.escalated')"
    [ "$escalated2" = "false" ] \
        && ok "a unit that exits on SIGTERM is not falsely reported as escalated" \
        || fail "escalated='$escalated2' for a unit that should have died politely"

    if [ "$FAIL" -eq "$before_fail_local" ]; then
        verdict 8 PASS "process group dies whole; escalation reported honestly"
    else
        verdict 8 FAIL "one or more checks failed"
    fi
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
main() {
    printf '\033[1mAether Cloud OS — execution-unit E2E harness\033[0m\n'
    printf 'Target: %s | Agent: %s\n' "${AETHER_URL:-<unset>}" "${AETHER_AGENT_ID:-<auto>}"

    section "Environment"
    if probe_api; then
        API_READY=true
        ok "API reachable, authenticated, agent connected ($AETHER_AGENT_ID)"
    fi

    if [ "$API_READY" != true ]; then
        # No API tier means not a single scenario can be genuinely executed.
        blocked "the execution-unit API is not reachable/authenticated with a connected agent"
    fi

    if on_host_with_systemd; then
        ok "running on a Linux host with systemd — restart/reboot orchestration available where opted in"
    else
        note "not on a VPS host (or not root): restart/reboot scenarios will report UNEXECUTED with commands"
    fi

    scenario_1
    scenario_2
    scenario_3
    scenario_4
    scenario_5
    scenario_6
    scenario_7
    scenario_8

    # --- matrix ---
    section "Scenario matrix"
    local n
    for n in "${SCENARIOS[@]}"; do
        printf '  %s  %-28s %s\n' "$n" "${SCENARIO_TITLE[$n]}" "${VERDICT[$n]:-UNKNOWN}"
        [ -n "${VERDICT_NOTE[$n]:-}" ] && printf '       %s\n' "${VERDICT_NOTE[$n]}"
    done

    section "Summary"
    printf '  %d checks, %d failed, %d skipped\n' "$((PASS + FAIL))" "$FAIL" "$SKIP"
    local executed=0
    for n in "${SCENARIOS[@]}"; do
        case "${VERDICT[$n]:-}" in PASS | PARTIAL | FAIL) executed=$((executed + 1)) ;; esac
    done
    printf '  %d of %d scenarios executed; the rest are UNEXECUTED (see the commands above).\n\n' \
        "$executed" "${#SCENARIOS[@]}"

    if [ "$FAIL" -ne 0 ]; then return 1; fi
    if [ "$executed" -eq 0 ]; then
        printf 'BLOCKED_BY_ENVIRONMENT: no scenario could be executed here.\n'
        return 77
    fi
    printf '  All executed scenarios passed.\n\n'
    return 0
}

main "$@"

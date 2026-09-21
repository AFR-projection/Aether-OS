#!/usr/bin/env bash
# Aether Cloud OS — host environment parity harness.
#
# Proves the thing the user reported: a tool an installer drops in the user's
# own bin directory (`curl -fsSL https://claude.ai/install.sh | bash` writes
# `~/.local/bin/claude`; `pipx`, `cargo install`, `nvm`, `rustup` and friends do
# the same) is reachable in an Aether shell, for the same reason it is reachable
# over SSH — because the shell is a *login* shell and the host's own profile
# chain runs. No tool is named in the checks; the mechanism is what is tested.
#
# It has two portions:
#
#   A. The host login-shell environment. Needs only bash and a POSIX shell on
#      the machine, so it runs on the real VPS and in CI. It mirrors the shared
#      `buildShellArgv`/`buildShellEnvironment` contract and spawns a real shell
#      to assert the profile chain runs, the regression (no `-l`) does not, and
#      no Aether secret leaks into the shell. This is the substantive proof.
#
#   B. The terminal session lifecycle over the real API. Needs a reachable
#      instance and owner credentials (AETHER_BASE_URL, AETHER_USERNAME,
#      AETHER_PASSWORD). It logs in, creates a session, finds it in the listing
#      (the discovery a browser refresh now relies on), confirms an ended
#      session is reported ended and never running, and kills it. Without the
#      credentials this portion is SKIPPED and counted as such — never reported
#      as a pass it did not earn.
#
# Usage, on the host (or any Linux box, for portion A):
#
#   bash deploy/tests/host-environment.sh
#   AETHER_BASE_URL=https://aether.example.com \
#     AETHER_USERNAME=owner AETHER_PASSWORD=... \
#     bash deploy/tests/host-environment.sh
#
# Exits 0 when every check that ran passed, 1 when one failed, and 77 only when
# nothing could run at all (no POSIX shell for portion A and no credentials for
# portion B).

set -uo pipefail

WORK="$(mktemp -d)"
PASS=0
FAIL=0
SKIP=0

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

ok() { PASS=$((PASS + 1)); printf '  [ ok ] %s\n' "$1"; }
fail() {
    FAIL=$((FAIL + 1))
    printf '  [FAIL] %s\n' "$1"
}
skip() { SKIP=$((SKIP + 1)); printf '  [skip] %s\n' "$1"; }
section() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

blocked() {
    printf 'BLOCKED_BY_ENVIRONMENT: %s\n' "$1"
    printf 'No checks were executed.\n'
    exit 77
}

# The shared contract, mirrored. These must match
# packages/shared/src/execution-environment.ts exactly; the unit tests there own
# the definition, and this reproduces it so the VPS run needs no build.
SYSTEM_PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
DEFAULT_TERM='xterm-256color'

# ---------------------------------------------------------------------------
# Portion A — the host login-shell environment
# ---------------------------------------------------------------------------
SHELL_BIN=""
for candidate in /bin/bash /usr/bin/bash /bin/sh; do
    if [ -x "$candidate" ]; then SHELL_BIN="$candidate"; break; fi
done

run_login_shell() {
    # Spawns a shell the way the agent does — a login shell with an environment
    # built only from the identity, a stock PATH, and the terminal type. Nothing
    # of this harness's own environment crosses in except what is set here, which
    # is exactly the allowlist rule. The command's stdout is returned.
    local home="$1" command="$2"
    env -i \
        HOME="$home" \
        USER=aethertester \
        LOGNAME=aethertester \
        PWD="$home" \
        SHELL="$SHELL_BIN" \
        TERM="$DEFAULT_TERM" \
        PATH="$SYSTEM_PATH" \
        "$SHELL_BIN" -l -c "$command" 2>/dev/null
}

portion_a() {
    section "A. Host login-shell environment"

    if [ -z "$SHELL_BIN" ]; then
        skip "no POSIX shell on this host — portion A cannot run"
        return
    fi
    printf '  shell: %s\n' "$SHELL_BIN"

    # A home whose profile chain puts a per-user bin directory on PATH, then a
    # tool inside it. This is the user's case in miniature, with nothing named.
    local home="$WORK/home"
    local localbin="$home/.local/bin"
    mkdir -p "$localbin"
    printf 'export PATH="$HOME/.local/bin:$PATH"\nexport AETHER_PROFILE_RAN=1\n' >"$home/.profile"
    # Some shells read ~/.bash_profile in preference to ~/.profile; ship both so
    # the check does not depend on which the host's bash prefers.
    cp "$home/.profile" "$home/.bash_profile"
    printf '#!/bin/sh\necho tool-on-path\n' >"$localbin/aethertool"
    chmod +x "$localbin/aethertool"

    # 1. The profile chain runs and the tool resolves — the fix.
    local out
    out="$(run_login_shell "$home" 'command -v aethertool >/dev/null && aethertool')"
    if [ "$out" = "tool-on-path" ]; then
        ok "a tool in the profile's PATH resolves in a login shell (the curl-installer case)"
    else
        fail "a tool in the profile's PATH did not resolve (got: '$out')"
    fi

    # 2. The profile marker is set — proof the chain actually ran, not that the
    #    tool happened to be found some other way.
    out="$(run_login_shell "$home" 'echo "marker=$AETHER_PROFILE_RAN"')"
    if [ "$out" = "marker=1" ]; then
        ok "the host profile chain executed (~/.profile sourced)"
    else
        fail "the host profile chain did not execute (got: '$out')"
    fi

    # 3. The regression, reproduced: without -l the same tool is not found. This
    #    is what makes the fix a fix rather than a coincidence.
    out="$(env -i HOME="$home" USER=aethertester PWD="$home" SHELL="$SHELL_BIN" \
        TERM="$DEFAULT_TERM" PATH="$SYSTEM_PATH" \
        "$SHELL_BIN" -c 'command -v aethertool >/dev/null && echo found || echo not-found' 2>/dev/null)"
    if [ "$out" = "not-found" ]; then
        ok "without -l the tool is NOT found — the defect, reproduced"
    else
        fail "a non-login shell unexpectedly found the tool (got: '$out'); the check proves nothing"
    fi

    # 4. Secret non-leak: a secret-shaped variable in this harness's environment
    #    must not appear in the shell, because the environment is built by name,
    #    never inherited. `env -i` in run_login_shell is what enforces it; this
    #    asserts the property holds even when the ambient environment carries the
    #    token, as the real agent's does.
    out="$(AETHER_PAIRING_TOKEN=super-secret-token JWT_SECRET=super-secret-jwt \
        run_login_shell "$home" 'env')"
    if printf '%s\n' "$out" | grep -q 'super-secret-token\|super-secret-jwt'; then
        fail "a secret leaked into the shell environment"
    else
        ok "no Aether secret reaches the shell (allowlist holds)"
    fi
    # …while the shell still has a real environment.
    if printf '%s\n' "$out" | grep -q "^HOME=$home$" &&
        printf '%s\n' "$out" | grep -q '^USER=aethertester$' &&
        printf '%s\n' "$out" | grep -q "^TERM=$DEFAULT_TERM$"; then
        ok "the shell still has its identity, home, and terminal type"
    else
        fail "the shell is missing expected non-secret variables"
    fi

    # 5. A second per-user location (a pipx-style install prefix), to show the
    #    mechanism is general and not tied to one directory name.
    local pipxbin="$home/.local/pipx/bin"
    mkdir -p "$pipxbin"
    printf 'export PATH="$HOME/.local/pipx/bin:$PATH"\n' >>"$home/.profile"
    cp "$home/.profile" "$home/.bash_profile"
    printf '#!/bin/sh\necho pipx-tool-on-path\n' >"$pipxbin/aetherpipxtool"
    chmod +x "$pipxbin/aetherpipxtool"
    out="$(run_login_shell "$home" 'command -v aetherpipxtool >/dev/null && aetherpipxtool')"
    if [ "$out" = "pipx-tool-on-path" ]; then
        ok "a second profile-added location also resolves (pipx-style prefix)"
    else
        fail "a second profile-added location did not resolve (got: '$out')"
    fi
}

# ---------------------------------------------------------------------------
# Portion B — the terminal session lifecycle over the real API
# ---------------------------------------------------------------------------
BASE_URL="${AETHER_BASE_URL:-}"
USERNAME="${AETHER_USERNAME:-}"
PASSWORD="${AETHER_PASSWORD:-}"
ACCESS_TOKEN=""

# Reads a top-level string field from a JSON object on stdin. Uses jq when it is
# present and falls back to a narrow grep that is good enough for the flat
# fields this harness reads (token, id, status). Never trusts the fallback for
# anything nested.
# Reads a field from a JSON object, addressed by a jq path (e.g. `.data.id`).
# Uses jq when present. Without jq — the common case on a stock host and in Git
# Bash — it falls back to a grep for the path's LEAF key (`id`), which is enough
# for the flat fields this harness reads. The leaf is taken from the path so the
# same call site works with or without jq; passing a bare `.field` grep pattern
# to jq, or a `.a.b` path to grep, is the portability bug this shape avoids.
json_field() {
    local path="$1" body="$2"
    if command -v jq >/dev/null 2>&1; then
        printf '%s' "$body" | jq -r "$path" 2>/dev/null
        return
    fi
    # Leaf key: everything after the last dot, with any leading dot stripped.
    local field="${path##*.}"
    # Fallback: "field":"value" or "field":value, first match only.
    printf '%s' "$body" | grep -oE "\"$field\"[[:space:]]*:[[:space:]]*(\"[^\"]*\"|[^,}]*)" |
        head -n1 | sed -E "s/\"$field\"[[:space:]]*:[[:space:]]*//; s/^\"//; s/\"$//"
}

api() {
    # api METHOD PATH [BODY] — prints the response body; records the HTTP status
    # in $WORK/status for read_api_status().
    #
    # The status cannot be returned through a normal variable: `api` is invoked
    # through a command substitution, which runs in a subshell and discards its
    # assignments (under `set -u` a later read is an unbound-variable error). It
    # therefore travels by file. The body goes to $WORK/resp, printed by `cat`.
    local method="$1" path="$2" body="${3:-}"
    local args=(-sS -o "$WORK/resp" -w '%{http_code}' -X "$method" "$BASE_URL$path")
    args+=(-H 'Content-Type: application/json')
    [ -n "$ACCESS_TOKEN" ] && args+=(-H "Authorization: Bearer $ACCESS_TOKEN")
    [ -n "$body" ] && args+=(--data "$body")
    curl "${args[@]}" 2>/dev/null >"$WORK/status"
    cat "$WORK/resp"
}

# The HTTP status of the last api() call. Because `api` is invoked through a
# command substitution (a subshell), its variable assignments are lost; the
# status travels by file and this reads it back in the caller.
read_api_status() {
    cat "$WORK/status"
}

portion_b() {
    section "B. Terminal session lifecycle (real API)"

    if [ -z "$BASE_URL" ] || [ -z "$USERNAME" ] || [ -z "$PASSWORD" ]; then
        skip "AETHER_BASE_URL / AETHER_USERNAME / AETHER_PASSWORD not set — API portion not run"
        return
    fi
    if ! command -v curl >/dev/null 2>&1; then
        skip "curl is not installed — API portion cannot run"
        return
    fi
    printf '  instance: %s\n' "$BASE_URL"

    # --- log in --------------------------------------------------------------
    local resp
    resp="$(api POST /api/auth/login "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\"}")"
    if [ "$(read_api_status)" != "200" ]; then
        fail "login (HTTP $(read_api_status))"
        printf '%s\n' "$resp" | head -c 400 | sed 's/^/         /'
        return
    fi
    ACCESS_TOKEN="$(json_field '.data.accessToken' "$resp")"
    if [ -z "$ACCESS_TOKEN" ] || [ "$ACCESS_TOKEN" = "null" ]; then
        fail "login returned no access token"
        return
    fi
    ok "authenticated as $USERNAME"

    # --- create a workspace session -----------------------------------------
    # Workspace scope needs no agent, so the portion runs against any reachable
    # instance. The environment fix applies to this path identically; a host
    # session would additionally need a connected agent to exist.
    resp="$(api POST /api/terminal/sessions '{"cols":80,"rows":24}')"
    if [ "$(read_api_status)" != "201" ]; then
        fail "create session (HTTP $(read_api_status))"
        printf '%s\n' "$resp" | head -c 400 | sed 's/^/         /'
        return
    fi
    local sid
    sid="$(json_field '.data.id' "$resp")"
    local status
    status="$(json_field '.data.status' "$resp")"
    if [ -n "$sid" ] && { [ "$status" = "running" ] || [ "$status" = "starting" ]; }; then
        ok "created a live session ($status)"
    else
        fail "created session has no id or is not live (id='$sid', status='$status')"
        return
    fi

    # --- discovery: it appears in the listing --------------------------------
    # This is the call a browser refresh now makes to find its live shells.
    resp="$(api GET /api/terminal/sessions)"
    if [ "$(read_api_status)" = "200" ] && printf '%s\n' "$resp" | grep -q "$sid"; then
        ok "the session is discoverable via GET /api/terminal/sessions (refresh reattach)"
    else
        fail "the live session was not found in the listing (HTTP $(read_api_status))"
    fi

    # --- kill it, then confirm it is reported gone/ended, never running ------
    resp="$(api DELETE "/api/terminal/sessions/$sid")"
    if [ "$(read_api_status)" = "204" ] || [ "$(read_api_status)" = "200" ]; then
        ok "killed the session (HTTP $(read_api_status))"
    else
        fail "kill session (HTTP $(read_api_status))"
    fi

    # The honesty rule: after the kill, the session must never be listed as
    # running. It is either absent, or present with an ended status.
    resp="$(api GET /api/terminal/sessions)"
    if printf '%s\n' "$resp" | grep -q "$sid"; then
        # Present — it must not claim to be running.
        local still
        still="$(printf '%s\n' "$resp" | grep -o "\"id\":\"$sid\"[^}]*\"status\":\"[a-z]*\"" | grep -o '"status":"[a-z]*"' | tail -n1)"
        if printf '%s\n' "$still" | grep -q 'running\|starting'; then
            fail "a killed session is still reported live ($still) — the honesty rule is violated"
        else
            ok "a killed session that lingers is reported ended, never running"
        fi
    else
        ok "a killed session is dropped from the listing"
    fi
}

# ---------------------------------------------------------------------------
# The six-scenario persistence matrix — reported, with honest verdicts
# ---------------------------------------------------------------------------
print_matrix() {
    section "Persistence scenario matrix (see docs/architecture/EXECUTION-MODEL.md)"
    cat <<'EOF'
  1  Terminal reconnect      SOLVED   — same PTY, reattached; environment unchanged
  2  Browser refresh         SOLVED   — sessions discovered via GET /api/terminal/sessions
                                         and rebound; the shell survives (backend not restarted)
  3  New terminal session    SOLVED   — a fresh login shell; profile chain runs, ~/.local/bin on PATH
  4  Logout / login          SOLVED   — sessions end on logout by design; the next session is correct
  5  Aether restart          PARTIAL  — backend-only restart re-adopts nothing across users safely,
                                         so it is NOT faked; agent restart kills the PTYs, reported gone
  6  Host reboot             NOT SOLVED — a PTY dies on reboot as on any machine; reported gone, never
                                         alive. A session-broker daemon is the remedy and is scheduled,
                                         not built here (see the Part 3 assessment)
EOF
    printf '\n  Scenarios 5 and 6 are NOT reported as passes. Nothing here claims a PTY\n'
    printf '  survives its owner dying; the guarantee is only that a dead session is\n'
    printf '  reported dead.\n'
}

# ---------------------------------------------------------------------------
main() {
    printf '\033[1mAether host environment parity harness\033[0m\n'
    portion_a
    portion_b
    print_matrix

    printf '\n\033[1m== Summary\033[0m\n'
    printf '  %d checks, %d failed, %d skipped\n\n' "$((PASS + FAIL))" "$FAIL" "$SKIP"

    if [ "$PASS" -eq 0 ] && [ "$FAIL" -eq 0 ]; then
        blocked "no checks could run (no POSIX shell and no API credentials)"
    fi
    [ "$FAIL" -eq 0 ]
}

main "$@"

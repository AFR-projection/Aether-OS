#!/usr/bin/env bash
# Aether Cloud OS — installer UI guarantees.
#
# The installer's UI layer makes eighteen claims. Every one of them is a claim an
# operator would have to take on trust, because the failure mode of each is
# silent: a percentage that is not real, a stage that says SUCCESS when nothing
# happened, a password on the screen, a terminal left in a broken state. This
# file drives the real renderer against the real state registry and checks the
# claims one at a time. Nothing is mocked except the terminal itself.
#
#   1.  Without a TTY the UI is plain — no rich layout, whatever TERM says.
#   2.  A real terminal with a capable TERM gets the rich layout.
#   3.  A real terminal with TERM=dumb gets the plain layout.
#   4.  NO_COLOR turns colour off and leaves the layout alone.
#   5.  A non-UTF-8 locale keeps the rich layout and swaps the glyphs for ASCII.
#   6.  --quiet puts nothing on stdout and still writes the log file.
#   7.  --verbose is a pass-through: the command's own output reaches stdout.
#   8.  The plain path emits no ANSI escape sequence at all.
#   9.  A stage with no real denominator shows no percentage and no counter.
#   10. A running stage at cur == total never renders 100%.
#   11. A running stage with a real denominator renders cur/total honestly.
#   12. A finished stage draws no stale progress number, and the state file it
#       leaves behind is well-formed for a second process to read.
#   13. A failing operation reports FAILED with the exit code that happened.
#   14. ui_run returns the child's real exit status, in every mode.
#   15. A registered secret, and a labelled secret in captured command output,
#       are redacted from the screen and from the log file.
#   16. An interrupt marks the stage FAILED with the signal's code, restores the
#       cursor, and leaves nothing RUNNING.
#   17. The deployment profile draws only what was published, wraps at item
#       boundaries rather than cutting an item in half, and never makes the panel
#       taller than the terminal it is drawn on — the failure mode of a frame that
#       outgrows the screen is a torn panel, not a missing line.
#   18. Every UI function a stage library calls is both defined by the UI layer
#       and shimmed by core.sh for the UI-less case. Those are two different
#       failures and neither implies the other: the shim is what an installation
#       updated in place from before the UI existed will need, and it is the one
#       that goes stale silently, because adding a UI function does not make
#       anyone think about the older installation. This is exactly the case no
#       one runs by hand.
#
# Needs only bash, sed, awk, and grep. Runs anywhere:
#
#   bash deploy/tests/installer-ui.sh
#
# Cases 2-5 need a pseudo-terminal and are reported as skipped where there is no
# `script` (Git Bash, for one). A skip is never counted as a pass: the summary
# prints the three numbers separately. Exits 0 when every check that ran passed.
#
# The rich path needs bash 4 for the stage registry's associative arrays, so on a
# bash 3 host the rich cases skip and the plain-path cases still run.

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
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
skip() {
    SKIP=$((SKIP + 1))
    printf '  [skip] %s\n' "$1"
}

# One skip() line can stand for several cases — the pty block covers four — and
# counting it as one makes the summary understate what did not run. A number in
# the summary that does not mean what a reader takes it to mean is the same
# defect as a progress bar with an invented denominator.
skip_n() {
    local count="$1" why="$2"
    SKIP=$((SKIP + count))
    printf '  [skip] %s (%d cases)\n' "$why" "$count"
}
section() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

blocked() {
    printf 'BLOCKED_BY_ENVIRONMENT: %s\n' "$1"
    printf 'No checks were executed.\n'
    exit 77
}

# --- assertions --------------------------------------------------------------
expect_eq() {
    local name="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        ok "$name"
    else
        fail "$name (expected '$expected', got '$actual')"
    fi
}

expect_has() {
    local name="$1" needle="$2" haystack="$3"
    if grep -qF -- "$needle" <<<"$haystack"; then
        ok "$name"
    else
        fail "$name (did not contain '$needle')"
        printf '%s\n' "$haystack" | sed 's/^/         /'
    fi
}

expect_lacks() {
    local name="$1" needle="$2" haystack="$3"
    if grep -qF -- "$needle" <<<"$haystack"; then
        fail "$name (contains '$needle')"
        printf '%s\n' "$haystack" | sed 's/^/         /'
    else
        ok "$name"
    fi
}

# A control character in a grep pattern is its own portability problem, so the
# escape check is a bash pattern match rather than a grep.
expect_no_escape() {
    local name="$1" text="$2"
    case "$text" in
        *$'\033'*)
            fail "$name (output contains an ANSI escape sequence)"
            printf '%s' "$text" | sed 's/\033/<ESC>/g; s/^/         /'
            ;;
        *) ok "$name" ;;
    esac
}

# --- harness -----------------------------------------------------------------
HAVE_BASH4=false
if [ "${BASH_VERSINFO[0]:-0}" -ge 4 ] 2>/dev/null; then
    HAVE_BASH4=true
fi

# Fresh UI state, fresh log file, fresh registry. Deliberately re-sources both
# files rather than resetting fields by hand: the point is to exercise the same
# source-time behaviour the installer gets, including the bash 3 guards.
ui_reset() {
    unset AETHER_UI_MODE AETHER_UI_QUIET AETHER_UI_VERBOSE AETHER_UI_ANIMATION
    unset AETHER_UI_BANNER_SHOWN NO_COLOR
    export AETHER_UI_STATE_FILE="$WORK/state/ui.state"
    export AETHER_LOG_FILE="$WORK/install.log"
    export AETHER_VERSION="0.0.0-test"
    mkdir -p "$WORK/state"
    : >"$AETHER_LOG_FILE"
    rm -f "$AETHER_UI_STATE_FILE"
    # shellcheck source=/dev/null
    source "$REPO_DIR/deploy/lib/ui-state.sh"
    # shellcheck source=/dev/null
    source "$REPO_DIR/deploy/lib/ui.sh"
}

# The rendered bar row for a stage, exactly as the dashboard would draw it and
# with the colour stripped so the text can be asserted on. Uses the real
# renderer: ui_row_bar into the real row buffer, closed by the real row terminator.
bar_text() {
    ui_frame_begin
    ui_row_reset
    ui_row_bar "$1"
    ui_row_end
    printf '%s' "$UI_FRAME_TEXT" | ui_strip_ansi
}

# One field of one stage, read back out of the state file. This is the view a
# second process gets — `aether status`, a doctor run, the test itself — and it is
# the one that has to be right, so the assertions that matter are made here and
# not against the in-memory arrays.
state_field() {
    local id="$1" index="$2" line
    line="$(grep -m1 "^STAGE|${id}|" "$AETHER_UI_STATE_FILE" 2>/dev/null || true)"
    [ -n "$line" ] || return 0
    local -a fields=()
    IFS='|' read -r -a fields <<<"$line"
    printf '%s' "${fields[$index]:-}"
}

# --- pseudo-terminal ---------------------------------------------------------
# The TTY-dependent branches are the compatibility requirement, so they are tested
# through a real pty rather than by overriding the detection. `script` is the only
# portable way to get one from a shell script.
PTY_INNER="$WORK/pty-inner.sh"

have_pty() {
    command -v script >/dev/null 2>&1 || return 1
    # A pty that cannot even echo is not something to build assertions on.
    #
    # Captured and matched rather than piped into `grep -q`: grep exits at the
    # match, whatever is writing into the pipe dies of SIGPIPE, and this file's
    # `set -o pipefail` reports the pipeline as failed — so the probe would answer
    # "no pty" on a host that has one, and quietly skip the four cases that need a
    # real terminal. Same failure `matches` in deploy/lib/core.sh exists to avoid.
    local out
    out="$(script -qec "printf 'PTY-OK\\n'" /dev/null 2>&1 || true)"
    case "$out" in
        *PTY-OK*) return 0 ;;
        *) return 1 ;;
    esac
}

write_pty_inner() {
    cat >"$PTY_INNER" <<EOF
set -u
export AETHER_UI_STATE_FILE="$WORK/pty-state/ui.state"
export AETHER_LOG_FILE="$WORK/pty.log"
export AETHER_VERSION="0.0.0-test"
mkdir -p "$WORK/pty-state"
source "$REPO_DIR/deploy/lib/ui-state.sh"
source "$REPO_DIR/deploy/lib/ui.sh"
ui_init
printf 'RESULT:%s:%s:%s\n' "\$UI_MODE" "\$UI_COLOR" "\$UI_UNICODE"
EOF
}

# pty_result <TERM> [NAME=VALUE ...] -> "MODE COLOR UNICODE", empty when the
# inner run produced no result.
pty_result() {
    local term="$1"
    shift
    local out
    out="$(env TERM="$term" "$@" script -qec "bash '$PTY_INNER'" /dev/null 2>&1 || true)"
    printf '%s' "$out" | tr -d '\r' |
        sed -n 's/.*RESULT:\([^:]*\):\([^:]*\):\([^:]*\).*/\1 \2 \3/p' | tail -n1
}

# ---------------------------------------------------------------------------
# 1. No TTY, plain output
# ---------------------------------------------------------------------------
section "1. Without a TTY the UI stays plain"
if [ -t 1 ]; then
    skip "stdout is a terminal, so the no-TTY branch cannot be exercised here (pipe the suite through cat, or run it in CI)"
else
    ui_reset
    export TERM=xterm-256color
    ui_init
    expect_eq "a capable TERM does not make a non-TTY rich" "plain" "$UI_MODE"
    expect_eq "and it is not interactive" "false" "$UI_INTERACTIVE"
fi

# ---------------------------------------------------------------------------
# 2-5. Through a real pseudo-terminal
# ---------------------------------------------------------------------------
if have_pty; then
    write_pty_inner

    section "2. A real terminal with a capable TERM gets the rich layout"
    PTY_OUT="$(pty_result xterm-256color)"
    read -r PTY_MODE PTY_COLOR PTY_UNICODE <<<"$PTY_OUT"
    if [ -z "${PTY_MODE:-}" ]; then
        fail "the pty run produced no result line"
        printf '%s\n' "$PTY_OUT" | sed 's/^/         /'
    else
        expect_eq "the rich layout is chosen" "rich" "$PTY_MODE"
        expect_eq "colour is on with no NO_COLOR" "true" "$PTY_COLOR"
    fi

    section "3. A real terminal with TERM=dumb gets the plain layout"
    read -r PTY_MODE _ <<<"$(pty_result dumb)"
    expect_eq "dumb terminal stays plain" "plain" "${PTY_MODE:-}"

    section "4. NO_COLOR turns colour off and leaves the layout alone"
    read -r PTY_MODE PTY_COLOR _ <<<"$(pty_result xterm-256color NO_COLOR=1)"
    expect_eq "the layout is still rich" "rich" "${PTY_MODE:-}"
    expect_eq "colour is off" "false" "${PTY_COLOR:-}"

    section "5. A non-UTF-8 locale keeps the layout and swaps the glyphs"
    read -r PTY_MODE _ PTY_UNICODE <<<"$(pty_result xterm-256color LC_ALL=C)"
    expect_eq "the layout is still rich" "rich" "${PTY_MODE:-}"
    expect_eq "the glyphs fall back to ASCII" "false" "${PTY_UNICODE:-}"
else
    section "2-5. Pseudo-terminal cases"
    skip_n 4 "no usable 'script' command, so no pty is available"
fi

# ---------------------------------------------------------------------------
# 6. --quiet
# ---------------------------------------------------------------------------
section "6. --quiet is silent on stdout and still records"
ui_reset
export AETHER_UI_QUIET=true
ui_init
expect_eq "quiet mode is selected" "quiet" "$UI_MODE"
QUIET_OUT="$(ui_write_log INFO "a quiet line" 2>&1)"
expect_eq "nothing reaches stdout" "" "$QUIET_OUT"
expect_has "the log file still has the line" "a quiet line" "$(cat "$AETHER_LOG_FILE")"
expect_no_escape "and the log line carries no escape sequences" "$(cat "$AETHER_LOG_FILE")"

# ---------------------------------------------------------------------------
# 7. --verbose
# ---------------------------------------------------------------------------
section "7. --verbose passes the command's output through"
ui_reset
export AETHER_UI_VERBOSE=true
ui_init
expect_eq "the panel is off" "plain" "$UI_MODE"
VERBOSE_OUT="$(ui_run "running something" printf 'VERBOSE-MARKER\n' 2>&1)"
expect_has "the command's own output reaches stdout" "VERBOSE-MARKER" "$VERBOSE_OUT"

# ---------------------------------------------------------------------------
# 8. Plain output is free of escapes
# ---------------------------------------------------------------------------
section "8. The plain path emits no ANSI escapes"
ui_reset
export AETHER_UI_MODE=plain
ui_init
PLAIN_OUT="$(ui_write_log WARN "a warning" 2>&1)"
PLAIN_OUT+="$(ui_stage_begin_notify BACKEND "Backend" 2>&1)"
PLAIN_OUT+="$(ui_stage_done_notify BACKEND "running" 2>&1)"
# ui_run matters most here: it is what every long command in the installer goes
# through, so on a non-TTY install — CI, a redirect, `curl | bash > log` — this is
# the function whose output lands in someone's build log, unchecked, thousands of
# times. It is a pass-through in plain mode and has to stay one.
PLAIN_OUT+="$(ui_run "a long operation" printf 'PLAIN-RUN-OUTPUT\n' 2>&1)"
expect_has "the command's output is passed straight through" "PLAIN-RUN-OUTPUT" "$PLAIN_OUT"
expect_no_escape "no escape sequence in log, stage begin, stage done, or ui_run" "$PLAIN_OUT"
# A non-TTY run is the one whose bytes land in a CI log or a redirect, where a
# multi-byte character the receiving terminal cannot render is a mojibake byte in
# someone's build output. The plain path has no glyph set to consult, so the
# requirement is simply that it never emits one.
expect_eq "and no non-ASCII byte either" "0" \
    "$(printf '%s' "$PLAIN_OUT" | LC_ALL=C grep -c '[^ -~]' || true)"

# ---------------------------------------------------------------------------
# 9-12. Honest progress
# ---------------------------------------------------------------------------
if [ "$HAVE_BASH4" != "true" ]; then
    section "9-12. Progress honesty"
    skip "the stage registry needs bash 4 associative arrays (bash ${BASH_VERSINFO[0]:-0} here)"
else
    ui_reset
    export AETHER_UI_MODE=rich
    ui_init
    ui_stage_begin_notify BACKEND "Backend" >/dev/null

    section "9. No denominator, no percentage"
    ui_progress_clear BACKEND >/dev/null
    BAR="$(bar_text BACKEND)"
    expect_lacks "the bar shows no percentage" "%" "$BAR"
    expect_lacks "and no invented counter" "checks" "$BAR"

    section "10. A running stage never renders 100%"
    ui_stage_progress BACKEND 60 60 "checks" >/dev/null
    BAR="$(bar_text BACKEND)"
    expect_lacks "60 of 60 while RUNNING is not 100%" "100%" "$BAR"
    expect_has "it reads 99%" "99%" "$BAR"
    expect_has "while the counter stays honest" "60/60 checks" "$BAR"

    section "11. A real denominator renders the real ratio"
    ui_stage_progress BACKEND 40 60 "checks" >/dev/null
    BAR="$(bar_text BACKEND)"
    expect_has "the percentage is cur over total" "66%" "$BAR"
    expect_has "and the counter is the real one" "40/60 checks" "$BAR"

    section "12. A finished stage keeps no stale number"
    ui_stage_done_notify BACKEND "running and healthy" >/dev/null
    BAR="$(bar_text BACKEND)"
    expect_lacks "the finished row draws no percentage" "%" "$BAR"

    expect_eq "the state file records it as SUCCESS" "SUCCESS" "$(state_field BACKEND 3)"

    # The file is the contract a second process reads: one STAGE line per stage,
    # thirteen fields each, in a fixed order.
    STAGE_LINES="$(grep -c '^STAGE|' "$AETHER_UI_STATE_FILE" || true)"
    expect_eq "one STAGE line per stage" "13" "$STAGE_LINES"
    BAD_FIELDS="$(awk -F'|' '/^STAGE\|/ && NF != 13 {n++} END {print n+0}' "$AETHER_UI_STATE_FILE")"
    expect_eq "every STAGE line has thirteen fields" "0" "$BAD_FIELDS"
    expect_has "the header names the format" "VERSION|1" "$(cat "$AETHER_UI_STATE_FILE")"
fi

# ---------------------------------------------------------------------------
# 13. A failure is reported as a failure
# ---------------------------------------------------------------------------
if [ "$HAVE_BASH4" != "true" ]; then
    section "13. Failure reporting"
    skip "needs the bash 4 stage registry"
else
    section "13. A failing operation reports FAILED with the real code"
    ui_reset
    export AETHER_UI_MODE=rich
    ui_init
    ui_stage_begin_notify CADDY "Reverse proxy and TLS" >/dev/null
    ui_stage_failed_notify CADDY "Caddy did not become healthy" 1 >/dev/null
    expect_eq "the stage reads FAILED" "FAILED" "$(state_field CADDY 3)"
    expect_eq "the exit code is the one that happened" "1" "$(state_field CADDY 11)"
    expect_has "the reason is kept" "did not become healthy" "$(state_field CADDY 10)"
    expect_eq "it is not still RUNNING" "0" "$(grep -c '^STAGE|[A-Z_]*|[^|]*|RUNNING|' "$AETHER_UI_STATE_FILE" || true)"
fi

# ---------------------------------------------------------------------------
# 14. ui_run returns the real status
# ---------------------------------------------------------------------------
if [ "$HAVE_BASH4" != "true" ]; then
    section "14. ui_run exit status"
    skip "the rich half needs the bash 4 stage registry"
else
    section "14. ui_run returns the child's real exit status"
    ui_reset
    export AETHER_UI_MODE=rich
    ui_init
    ui_run "a command that fails" bash -c 'exit 7' >/dev/null 2>&1
    expect_eq "rich mode propagates a failure" "7" "$?"
    ui_run "a command that works" bash -c 'exit 0' >/dev/null 2>&1
    expect_eq "rich mode propagates success" "0" "$?"

    export AETHER_UI_MODE=plain
    ui_init
    ui_run "a command that fails" bash -c 'exit 3' >/dev/null 2>&1
    expect_eq "plain mode propagates a failure" "3" "$?"
    ui_run "a command that does not exist" __no_such_command__ >/dev/null 2>&1
    expect_eq "a missing command is a failure, not a success" "127" "$?"
fi

# ---------------------------------------------------------------------------
# 15. Redaction
# ---------------------------------------------------------------------------
section "15. Secrets never reach the screen or the log"
ui_reset
export AETHER_UI_MODE=plain
ui_init

SECRET="s3cr3t-value-9f"
ui_secret_add "$SECRET"

REDACTED="$(ui_redact "the token is $SECRET here")"
expect_lacks "a registered literal is removed" "$SECRET" "$REDACTED"
expect_has "and replaced with a marker" "<redacted>" "$REDACTED"

expect_lacks "PASSWORD= is redacted" "hunter2xyz" "$(ui_redact "POSTGRES_PASSWORD=hunter2xyz")"
expect_lacks "a database URL credential is redacted" "hunter2xyz" \
    "$(ui_redact "postgres://aether:hunter2xyz@postgres:5432/aether")"
expect_lacks "a bearer token is redacted" "abcdefghijklmnop" \
    "$(ui_redact "Authorization: Bearer abcdefghijklmnop")"
expect_lacks "a private key body is redacted" "MIIEowIBAAKCAQEA" \
    "$(ui_redact "-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA")"

# A short value is deliberately left alone: redacting every occurrence of a short
# string would rewrite unrelated lines, and hiding real output is its own kind of
# lie. The guard is documented in ui.sh and asserted here so it cannot regress
# into mangling ordinary log text.
ui_secret_add "abc"
expect_has "a value below the length guard is left alone" "abc" "$(ui_redact "abc is a real word")"

# The path that matters in practice: a command run through ui_run whose output is
# captured to the log file. The comment in ui.sh used to claim this happened while
# the code deleted the capture; this asserts the capture is both kept and redacted.
export AETHER_UI_MODE=rich
ui_init
export UI_TEST_SECRET="$SECRET"
ui_run "a build that logs a secret" bash -c 'printf "config: %s\n" "$UI_TEST_SECRET"' >/dev/null 2>&1
LOG_CONTENT="$(cat "$AETHER_LOG_FILE")"
expect_has "captured output is written to the log" "config:" "$LOG_CONTENT"
expect_lacks "and the secret in it is redacted" "$SECRET" "$LOG_CONTENT"
expect_has "with the marker in its place" "<redacted>" "$LOG_CONTENT"
unset UI_TEST_SECRET

# ---------------------------------------------------------------------------
# 16. Interrupt
# ---------------------------------------------------------------------------
if [ "$HAVE_BASH4" != "true" ]; then
    section "16. Interrupt handling"
    skip "needs the bash 4 stage registry"
else
    section "16. An interrupt restores the terminal and tells the truth"
    ui_reset
    export AETHER_UI_MODE=rich
    ui_init
    # A real rich run hides the cursor; the interrupt has to put it back or the
    # operator is left with an invisible cursor after every Ctrl+C.
    UI_INTERACTIVE=true
    UI_COLOR=true
    ui_style_init
    ui_stage_begin_notify HOST_AGENT "Host agent" >/dev/null
    ui_cursor_hide >/dev/null

    INT_OUT="$(ui_on_interrupt INT 2>&1)"
    INT_STATUS=$?

    expect_eq "the exit status is the one for SIGINT" "130" "$INT_STATUS"
    expect_has "the panel names the interrupt" "Interrupted" "$INT_OUT"
    expect_has "the cursor is shown again" $'\033[?25h' "$INT_OUT"
    expect_eq "the interrupted stage reads FAILED" "FAILED" "$(state_field HOST_AGENT 3)"
    expect_eq "with the signal's exit code" "130" "$(state_field HOST_AGENT 11)"
    expect_eq "and nothing is left RUNNING" "0" \
        "$(grep -c '^STAGE|[A-Z_]*|[^|]*|RUNNING|' "$AETHER_UI_STATE_FILE" || true)"
fi

# ---------------------------------------------------------------------------
# 17. The deployment profile
# ---------------------------------------------------------------------------
if [ "$HAVE_BASH4" != "true" ]; then
    section "17. Deployment profile"
    skip "the profile store needs bash 4 associative arrays"
else
    section "17. The deployment profile states only what was published"

    ui_reset
    export AETHER_UI_MODE=rich
    ui_init
    UI_INTERACTIVE=true
    UI_COLOR=true
    ui_style_init

    expect_eq "an empty profile renders nothing at all" "" "$(ui_profile_render 'Profile ' 74 2)"

    ui_profile_set resources "Constrained VPS"
    ui_profile_set topology "Single-node"
    ui_profile_set mode "Production mode"
    ui_profile_set agent "Host agent: root"

    # The width a standard 80-column SSH window gives the panel is 74 columns of
    # content. All four items have to fit it on one row: this is the terminal the
    # installer is most often run from, and a spec item that is always cut there is
    # a spec item that does not exist.
    PROFILE_ONE="$(ui_profile_render 'Profile ' 74 1)"
    expect_eq "four items fit one row of an 80-column terminal" "1" "$(printf '%s\n' "$PROFILE_ONE" | awk 'END {print NR}')"
    expect_has "including the resource verdict" "Constrained VPS" "$PROFILE_ONE"
    expect_has "and the host agent scope" "Host agent: root" "$PROFILE_ONE"

    # Narrow: the row cannot hold them, so it wraps at an item boundary. The
    # separator between items is a glyph — `·` where the locale can render it, `-`
    # where it cannot — so these assertions name the items, never the join.
    PROFILE_WRAP="$(ui_profile_render 'Profile ' 50 2)"
    PROFILE_ROW1="$(printf '%s\n' "$PROFILE_WRAP" | sed -n 1p)"
    PROFILE_ROW2="$(printf '%s\n' "$PROFILE_WRAP" | sed -n 2p)"
    expect_eq "a narrow row wraps onto a second one" "2" "$(printf '%s\n' "$PROFILE_WRAP" | awk 'END {print NR}')"
    expect_has "the first row keeps whole items" "Constrained VPS" "$PROFILE_ROW1"
    expect_has "two of them" "Single-node" "$PROFILE_ROW1"
    expect_has "and the second row keeps the rest" "Production mode" "$PROFILE_ROW2"
    expect_has "including the last item" "Host agent: root" "$PROFILE_ROW2"
    case "$PROFILE_WRAP" in
        *…* | *...*)
            fail "nothing is cut when it fits across two rows"
            printf '%s\n' "$PROFILE_WRAP" | sed 's/^/         /'
            ;;
        *) ok "nothing is cut when it fits across two rows" ;;
    esac

    # No room for a second row: the cut has to be visible. The marker is a glyph
    # like the separator, so both modes are forced here rather than inherited from
    # whatever locale the runner happens to have — the point is that each mode is
    # right, not that this machine is in one of them.
    UI_UNICODE=false
    ui_style_init
    PROFILE_CUT="$(ui_profile_render 'Profile ' 30 1)"
    expect_has "with one row and no space the cut is marked" "..." "$PROFILE_CUT"
    expect_no_ascii_violation="$(printf '%s' "$PROFILE_CUT" | LC_ALL=C grep -c '[^ -~]' || true)"
    expect_eq "and the ASCII mode row is pure ASCII" "0" "$expect_no_ascii_violation"
    expect_lacks "the item that did not fit is not claimed" "Host agent: root" "$PROFILE_CUT"

    UI_UNICODE=true
    ui_style_init
    PROFILE_CUT="$(ui_profile_render 'Profile ' 30 1)"
    expect_has "the Unicode mode marks the cut with an ellipsis" "…" "$PROFILE_CUT"

    # Back to the environment's own decision for the rest of the case. Captured
    # rather than assumed: a runner in a UTF-8 locale detects Unicode and this
    # machine does not, and the assertions below have to hold for both.
    ui_reset
    export AETHER_UI_MODE=rich
    ui_init
    UI_INTERACTIVE=true
    UI_COLOR=true
    ui_style_init
    DETECTED_UNICODE="$UI_UNICODE"
    ui_profile_set resources "Constrained VPS"
    ui_profile_set topology "Single-node"
    ui_profile_set mode "Production mode"
    ui_profile_set agent "Host agent: root"

    # Finally the panel itself. Rows are counted on the real renderer's output
    # buffer, because the height is what decides whether a frame scrolls — and a
    # frame that scrolls leaves the saved cursor pointing at the wrong line, which
    # does not degrade the display so much as destroy it.
    dashboard_lines() {
        ui_render_dashboard
        printf '%s' "$UI_FRAME_TEXT" | awk 'END {print NR}'
    }

    ui_fact_set platform "Ubuntu 24.04"
    ui_fact_set arch "x86_64"
    ui_fact_set cpu "1 vCPU"
    ui_fact_set ram "1900 MB"
    ui_fact_set disk "39 GB free"
    ui_fact_set docker "Docker 27.3.1" runtime
    ui_fact_set compose "Compose v2.29.7" runtime

    UI_WIDTH=80
    UI_ROWS=24
    expect_eq "the profile row keeps the 24-row frame at its historic height" "19" "$(dashboard_lines)"

    DASH="$(ui_render_dashboard; printf '%s' "$UI_FRAME_TEXT" | ui_strip_ansi)"
    expect_has "the profile is drawn in the panel" "Constrained VPS" "$DASH"
    expect_has "the runtime row is drawn too" "Docker 27.3.1" "$DASH"
    expect_has "and the host facts are not pushed off" "39 GB free" "$DASH"

    # The whole panel in ASCII mode, because that is the only form of the check
    # that means anything: the glyphs are covered case by case elsewhere, and the
    # analysis rows are the newest place a multi-byte character could hide. Asserted
    # against the complete frame, so a row added later is covered without anyone
    # remembering to extend this.
    UI_UNICODE=false
    ui_style_init
    DASH_ASCII="$(ui_render_dashboard; printf '%s' "$UI_FRAME_TEXT" | ui_strip_ansi | LC_ALL=C grep -c '[^ -~]' || true)"
    expect_eq "the ASCII-mode panel contains no non-ASCII byte" "0" "$DASH_ASCII"
    UI_UNICODE="$DETECTED_UNICODE"
    ui_style_init

    # A taller terminal gets the full feed and the wrapped profile, and still
    # leaves the five rows the banner and the cursor above the frame need.
    UI_ROWS=30
    TALL="$(dashboard_lines)"
    if [ "$TALL" -le 25 ]; then
        ok "a 30-row terminal still leaves room above the frame ($TALL rows)"
    else
        fail "the frame at 30 rows is $TALL rows, which leaves no room above it"
    fi
fi

# ---------------------------------------------------------------------------
# 18. Every UI call from a stage library resolves
# ---------------------------------------------------------------------------
section "18. Every UI function the stage libraries call resolves without ui.sh"

# An installation updated in place from before the UI layer existed has core.sh
# but no ui.sh. The stage libraries call engine-facing UI functions directly, so
# each of those names has to be shimmed by core.sh for that install not to abort
# with "command not found" — fatal, under set -e — partway through a deployment.
# Nothing else in this file exercises that path, and it is the path nobody runs by
# hand, so the check is textual: every name a stage library calls must be both
# defined by the UI layer and shimmed for the case where it is absent.
STAGE_LIBS="preflight dependencies configure deploy finalize local-agent create-master-user"
UNSHIMMED=""
UNDEFINED=""
for lib in $STAGE_LIBS; do
    LIB_PATH="$REPO_DIR/deploy/lib/$lib.sh"
    [ -f "$LIB_PATH" ] || continue
    # Comments and declarations are stripped first: `local ui_file` is a variable,
    # not a call, and flagging it would make this check cry wolf until someone
    # stopped reading it.
    CALLS="$(grep -vE '^[[:space:]]*#' "$LIB_PATH" |
        grep -vE '^[[:space:]]*(local|declare|for)[[:space:]]' |
        grep -oE '\bui_[a-z_]+[ (]' | grep -oE 'ui_[a-z_]+' | sort -u)"
    for fn in $CALLS; do
        # Both halves are required, and they are different failures. Without the
        # shim, an installation whose lib directory has no ui.sh aborts with
        # "command not found"; without the definition, a normal install does. The
        # shim is the one that goes stale, because adding a UI function does not
        # make anyone think about the older installation.
        #
        # The UI layer is two files, and the split between them is not a contract
        # the caller sees: ui_stage_skip_range is defined in ui-state.sh alone, so
        # looking up ui.sh only would call that a missing definition.
        grep -qE "^    ${fn}\(\)" "$REPO_DIR/deploy/lib/core.sh" || UNSHIMMED+="${fn}() (${lib}.sh) "
        grep -qE "^${fn}\(\)" "$REPO_DIR/deploy/lib/ui.sh" ||
            grep -qE "^${fn}\(\)" "$REPO_DIR/deploy/lib/ui-state.sh" ||
            UNDEFINED+="${fn}() (${lib}.sh) "
    done
done

if [ -z "$UNSHIMMED" ]; then
    ok "every engine-facing UI call is shimmed for an install without ui.sh"
else
    fail "called by a stage library but not shimmed in core.sh: $UNSHIMMED"
fi
if [ -z "$UNDEFINED" ]; then
    ok "and every one of them is defined by the UI layer"
else
    fail "called by a stage library but defined nowhere in the UI layer: $UNDEFINED"
fi

# ---------------------------------------------------------------------------
printf '\n\033[1m== Summary\033[0m\n'
printf '  %d passed, %d failed, %d skipped\n\n' "$PASS" "$FAIL" "$SKIP"
[ "$FAIL" -eq 0 ]

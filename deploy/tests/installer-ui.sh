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
#   19. A stage's recorded span covers the whole stage, and a stage is opened by
#       the function that owns it, exactly once.
#   20. A stage header never names a total it does not have. The standalone CLI
#       numbered its headers against a constant that was wrong for every path
#       but one, so `aether update` printed "[8/7] Restarting the stack".
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
    export AETHER_INSTALL_DIR="${AETHER_INSTALL_DIR:-/opt/aether}"
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
# 19. A stage's recorded span covers the whole stage
# ---------------------------------------------------------------------------
# Four defects found by running the installer on a real host, none of which any
# amount of reading the source had surfaced, and each of which made a number on
# the panel mean something other than what it said:
#
#   * CADDY drew "5s" for a stage that had been running for eighteen minutes,
#     because wait_for_service reopened a stage deploy_application had already
#     opened and the reopen restarted the clock;
#   * FRONTEND drew a tick with no duration at all, because nothing ever opened
#     it — only the done and skipped notifications were ever sent;
#   * "Stage completed: finalize" was logged twice, in the same second, because
#     finalize_installation called mark_done for a key run_stage already marks;
#   * every long command's output appeared twice in the log, because a child that
#     sources core.sh writes its own lines to the shared log and ui_run then
#     replayed its captured output on top.
section "19. A stage's recorded span covers the whole stage"
if [ "$HAVE_BASH4" != "true" ]; then
    skip "the stage registry needs bash 4 associative arrays (bash ${BASH_VERSINFO[0]:-0} here)"
else
    ui_reset

    # CADDY is the stage this happened to. It is opened by deploy_application
    # before the Caddyfile exists and reopened by wait_for_service when the proxy
    # is probed, so a reopen that restarts the clock reports only the last slice.
    # A registered id, not an invented one: the state file is written from the
    # registry, so an unknown id is never flushed and the assertions below would
    # compare two empty strings and pass without testing anything.
    ui_stage_begin CADDY "Reverse proxy and TLS"
    FIRST_START="$(state_field CADDY 4)"
    sleep 2
    ui_stage_begin CADDY "Reverse proxy and TLS"
    expect_eq "reopening a running stage keeps its original start" "$FIRST_START" "$(state_field CADDY 4)"

    ui_stage_done_notify CADDY "healthy"
    SPAN=$(( $(state_field CADDY 5) - $(state_field CADDY 4) ))
    if [ "$SPAN" -ge 2 ]; then
        ok "and its span covers the whole stage, not the last slice (${SPAN}s)"
    else
        fail "the reopen restarted the clock: span is ${SPAN}s for a stage that ran at least 2s"
    fi

    # The other half: a stage reopened after it finished is a new pass, and its
    # span has to describe that pass rather than inheriting the old start. The
    # end is read before the reopen, because a begin clears it.
    PREV_END="$(state_field CADDY 5)"
    ui_stage_begin CADDY "a new pass"
    if [ "$(state_field CADDY 4)" -ge "$PREV_END" ]; then
        ok "a stage reopened after finishing gets a new start"
    else
        fail "a stage reopened after finishing kept the old start, so its span is a lie"
    fi

    # FRONTEND has to be opened by the function that owns it. The stage-ownership
    # note in deploy_application says build_frontend_bundle opens it; this is what
    # holds that note to being true.
    FRONTEND_BODY="$(awk '/^build_frontend_bundle\(\)/,/^}/' "$REPO_DIR/deploy/lib/deploy.sh")"
    case "$FRONTEND_BODY" in
        *ui_stage_begin_notify\ FRONTEND*)
            ok "build_frontend_bundle opens the FRONTEND stage it closes" ;;
        *)
            fail "build_frontend_bundle never opens FRONTEND, so it has no start time and no duration" ;;
    esac

    # run_stage marks whatever function it ran. A function that also marks itself
    # logs the completion twice — same second, twice in the log, twice on screen.
    DUPLICATE_MARKS=""
    while read -r KEY FN; do
        [ -n "$KEY" ] && [ -n "$FN" ] || continue
        BODY="$(awk "/^${FN}\\(\\)/,/^}/" "$REPO_DIR/deploy/lib/"*.sh 2>/dev/null)"
        case "$BODY" in
            *"mark_done ${KEY}"* | *"mark_done \"${KEY}\""*)
                DUPLICATE_MARKS+="mark_done ${KEY} is called by ${FN}(), but run_stage already marks '${KEY}'; " ;;
        esac
    done <<<"$(grep -hE '^[[:space:]]*run_stage [a-z_]+ [a-z_]+' "$REPO_DIR/deploy/lib/install.sh" |
        sed -E 's/^[[:space:]]*run_stage ([a-z_]+) ([a-z_]+).*/\1 \2/')"
    if [ -z "$DUPLICATE_MARKS" ]; then
        ok "no stage is marked done twice for one run"
    else
        fail "$DUPLICATE_MARKS"
    fi

    # The capture appends what a child printed without core.sh, and drops the
    # lines core.sh already wrote for it. Asserted on the log file, because that
    # is what an operator reads back after a failure.
    CAPTURE="$WORK/capture.log"
    printf '%s\n' \
        '[2000-01-01T00:00:00Z] [INFO ] already written by the child itself' \
        'the compiler said something raw' \
        'another raw line' >"$CAPTURE"
    ui_reset
    ui_log_capture "$CAPTURE" "a test command"
    if grep -qF 'already written by the child itself' "$AETHER_LOG_FILE"; then
        fail "the capture replayed a line core.sh had already logged"
    else
        ok "the capture drops lines the child already logged through core.sh"
    fi
    if grep -qF 'the compiler said something raw' "$AETHER_LOG_FILE" &&
        grep -qF 'another raw line' "$AETHER_LOG_FILE"; then
        ok "and keeps every line the child printed outside core.sh"
    else
        fail "the capture dropped raw output the log exists to keep"
    fi
    if grep -qF -- '--- a test command ---' "$AETHER_LOG_FILE"; then
        ok "and still names the operation the output came from"
    else
        fail "the capture lost its header, so the output cannot be attributed"
    fi
fi

# ---------------------------------------------------------------------------
# 20. A stage header never names a total it does not have
# ---------------------------------------------------------------------------
# The header the standalone CLI prints is `[n/total] what it is doing`, and the
# total used to be a constant — STAGE_TOTAL=7 — while `aether update` runs eight
# sections on the ordinary pull path. So the last line of every successful update
# read "[8/7] Restarting the stack": a counter that overruns its own denominator,
# which is the same defect as a percentage nobody measured, and it is what the
# operator reads to decide whether the thing is nearly done.
#
# The total is now declared by the script that knows it, and a script that
# cannot state one declares none and gets the step number alone. Both halves are
# checked here by running the real stage() out of core.sh in a child process —
# core.sh sets -euo, which this file must not inherit.
section "20. A stage header never names a total it does not have"

STAGE_HEADERS="$(
    # shellcheck disable=SC2016 # the child's variables are its own; $REPO_DIR is
    # expanded by the parent on purpose, and everything else is child-side.
    REPO_DIR="$REPO_DIR" AETHER_LOG_FILE="$WORK/stage-header.log" bash -c '
set -euo pipefail
source "$REPO_DIR/deploy/lib/core.sh"

# Guarded, because this file is also run against the core.sh from before this
# fix, to prove that the checks below fail there. Without the guard the child
# dies on "stage_total: command not found" — under core.sh'"'"'s own set -e — and
# prints no headers at all, which is a run the assertions below cannot say
# anything about.
if type -t stage_total >/dev/null 2>&1; then
    stage_total 3
fi
stage "one"
stage "two"
stage "three"

# Nothing declared: the script branches, or calls stage() through a library and
# cannot say how many headers it will print. It then prints the step number
# alone. This is the regression — eight headers, no invented denominator.
STAGE_TOTAL=0
STAGE_CURRENT=0
for i in 1 2 3 4 5 6 7 8; do
    stage "section $i"
done
' 2>&1 | sed $'s/\033\\[[0-9;]*m//g'
)"

# The sed above is ANSI-C quoted for a reason: a `\033` written inside ordinary
# single quotes is not an escape to every sed — Git Bash's ignores it and strips
# nothing — and the headers would then keep the bold sequence in front of the
# `[1/3]` the assertions below look for at the start of a line. The same problem
# expect_no_escape describes for a control character in a grep pattern.

# Every assertion below reads this output, so an output that is empty — a child
# that died, a core.sh that could not be sourced — would satisfy "does not
# contain [8/7]" and pass without testing anything, which is the same silent
# green as the bug being hunted. The run is required to have printed the eleven
# headers it was asked for before it is read.
HEADER_COUNT="$(printf '%s\n' "$STAGE_HEADERS" | grep -cE '^\[[0-9]+(/[0-9]+)?\]')"
if [ "$HEADER_COUNT" -eq 11 ]; then
    ok "stage() printed the eleven headers this case drives it with"
else
    fail "the header run produced $HEADER_COUNT headers, not 11; the checks below cannot conclude"
fi

expect_has "a declared total numbers its headers against it" "[3/3] three" "$STAGE_HEADERS"
expect_has "and counts from one" "[1/3] one" "$STAGE_HEADERS"
expect_has "an undeclared total prints the step number alone" "[8] section 8" "$STAGE_HEADERS"
expect_lacks "no header invents a denominator" "[8/7]" "$STAGE_HEADERS"

# The generic form of the same guarantee, so a future constant that is wrong for
# some *other* path is caught too: across every header this run printed, no
# numerator may exceed its denominator.
OVER_RUN="$(
    printf '%s\n' "$STAGE_HEADERS" |
        grep -oE '\[[0-9]+/[0-9]+\]' |
        tr -d '[]' |
        awk -F/ '$1 > $2 { print }'
)"
if [ -z "$OVER_RUN" ] && [ "$HEADER_COUNT" -eq 11 ]; then
    ok "and no header anywhere counts past its own total"
elif [ -n "$OVER_RUN" ]; then
    fail "headers that overrun their total: $(printf '%s' "$OVER_RUN" | tr '\n' ' ')"
else
    fail "no headers were printed, so nothing was checked for overrun"
fi

# And the static half: a script that states a *constant* total must print
# exactly that many headers. This is what would have caught STAGE_TOTAL=7 in the
# first place, on the day the eighth stage() call was added.
MISCOUNTED=""
for SCRIPT in "$REPO_DIR"/deploy/scripts/*.sh; do
    DECLARED="$(grep -oE '^[[:space:]]*stage_total [0-9]+' "$SCRIPT" | awk '{ print $2 }' | sort -u)"
    [ -n "$DECLARED" ] || continue
    # A script that also extends its total mid-run is branchy by construction and
    # cannot be checked this way; it is the dynamic declarations in update.sh and
    # restore.sh, which the runtime checks above cover.
    case "$(grep -cE '^[[:space:]]*stage_total \$\(' "$SCRIPT")" in
        0) ;;
        *) continue ;;
    esac
    HEADERS="$(grep -cE '^[[:space:]]*stage ' "$SCRIPT")"
    for n in $DECLARED; do
        [ "$n" = "$HEADERS" ] ||
            MISCOUNTED+="$(basename "$SCRIPT") declares $n but prints $HEADERS headers; "
    done
done
if [ -z "$MISCOUNTED" ]; then
    ok "a constant total matches the headers the script prints"
else
    fail "$MISCOUNTED"
fi

# ---------------------------------------------------------------------------
# 21. Alt screen buffer
# ---------------------------------------------------------------------------
if [ "$HAVE_BASH4" != "true" ]; then
    section "21. Alt screen buffer"
    skip "the rich mode needs bash 4 associative arrays"
else
    section "21. Alt screen buffer activates and restores correctly"

    ui_reset
    export AETHER_UI_MODE=rich
    ui_init
    UI_INTERACTIVE=true
    UI_COLOR=true
    ui_style_init

    # The alt screen is activated by ui_frame_flush, which is called from
    # ui_render_dashboard_if_changed only when the frame has actually changed.
    # Test the flush itself directly rather than the render path.
    ui_render_dashboard >/dev/null 2>&1 || true
    # Force the flush as if the frame had changed (first draw always changes from empty).
    ui_frame_begin
    ui_frame_flush >/dev/null 2>&1 || true
    expect_eq "UI_ALT_SCREEN is true after first flush" "true" "$UI_ALT_SCREEN"

    # Suspending the panel restores normal screen and clears the flag.
    ui_panel_suspend >/dev/null 2>&1 || true
    expect_eq "UI_ALT_SCREEN is false after panel_suspend" "false" "$UI_ALT_SCREEN"
fi

# ---------------------------------------------------------------------------
# 22. Spinner
# ---------------------------------------------------------------------------
if [ "$HAVE_BASH4" != "true" ]; then
    section "22. Spinner"
    skip "needs bash 4 associative arrays"
else
    section "22. Spinner advances with time and is disabled by --no-animation"

    ui_reset
    export AETHER_UI_MODE=rich
    ui_init
    UI_INTERACTIVE=true
    UI_COLOR=true
    ui_style_init

    ui_stage_begin_notify BACKEND "Backend" >/dev/null

    # Spinner output is non-empty when animation is on.
    SPIN="$(ui_glyph_spinner_run)"
    if [ -n "$SPIN" ]; then
        ok "spinner produces output when animation is enabled"
    else
        fail "spinner produced nothing with animation enabled"
    fi

    # Spinner output is empty when animation is off.
    UI_ANIMATION=false
    SPIN_OFF="$(ui_glyph_spinner_run)"
    if [ -z "$SPIN_OFF" ]; then
        ok "spinner produces nothing when animation is off"
    else
        fail "spinner produced '$SPIN_OFF' even with animation disabled"
    fi

    # The spinner is self-healing: rendered before ui_init has populated the
    # frame array (an early dashboard draw, an error path), the modulo must not
    # become a divide-by-zero that aborts the whole render.
    UI_ANIMATION=true
    unset UI_SPINNER UI_SPINNER_LEN
    if SPIN_BARE="$(ui_glyph_spinner_run 3 2>&1)" && [ -n "$SPIN_BARE" ]; then
        ok "spinner survives an unset frame array (no divide-by-zero)"
    else
        fail "spinner failed with the frame array unset: '$SPIN_BARE'"
    fi
fi

# ---------------------------------------------------------------------------
# 23. UFW prompt — reads AETHER_ENABLE_UFW, does not prompt in-place
# ---------------------------------------------------------------------------
# configure_firewall in finalize.sh used to call confirm() which would prompt in the
# middle of the install. It now reads AETHER_ENABLE_UFW which run_interactive_setup
# collects upfront. This test verifies the function reads the env var.
section "23. UFW decision comes from AETHER_ENABLE_UFW (no mid-install prompt)"

# Verify configure_firewall in finalize.sh reads the env var rather than calling
# confirm() directly. This is a source-level check because the function needs
# ufw and sudo to actually run.
UFW_BODY="$(cat "$REPO_DIR/deploy/lib/finalize.sh")"
case "$UFW_BODY" in
    *'AETHER_ENABLE_UFW'*)
        ok "configure_firewall reads AETHER_ENABLE_UFW from the environment"
        ;;
    *)
        fail "configure_firewall does not read AETHER_ENABLE_UFW — prompt batching not implemented"
        ;;
esac

case "$UFW_BODY" in
    *'confirm "Enable UFW'*|*'confirm.*Enable UFW'*)
        fail "configure_firewall still calls confirm() for UFW — mid-install prompt not removed"
        ;;
    *)
        ok "configure_firewall no longer calls confirm() for UFW"
        ;;
esac

# ---------------------------------------------------------------------------
# 24. Wordmark renders in rich+unicode mode, falls back otherwise
# ---------------------------------------------------------------------------
if [ "$HAVE_BASH4" != "true" ]; then
    section "24. Wordmark"
    skip "needs bash 4 associative arrays"
else
    section "24. Wordmark draws in rich+unicode mode and degrades gracefully"

    ui_reset
    export AETHER_UI_MODE=rich
    ui_init
    UI_INTERACTIVE=true
    UI_COLOR=true
    UI_UNICODE=true
    ui_style_init

    # Capture wordmark output.
    WORDMARK_OUT="$(AETHER_VERSION=9.9.9 ui_wordmark 2>&1 || true)"
    if [ -n "$WORDMARK_OUT" ]; then
        ok "ui_wordmark produces output in rich+unicode mode"
        case "$WORDMARK_OUT" in
            *'████'*|*'CLOUD OS'*) ok "output contains wordmark characters" ;;
            *) fail "ui_wordmark output does not contain expected wordmark text" ;;
        esac
        # The block art must spell AETHER, not a garbled sequence. Assert the
        # exact ANSI Shadow signatures of the letters that used to be wrong: the
        # A/E/T top row and the H/E/R crossbar row. If a join drifts, these
        # literal rows stop matching and the test fails loudly.
        if [ "${WORDMARK_OUT#* █████╗ ███████╗████████╗}" != "$WORDMARK_OUT" ] && \
           [ "${WORDMARK_OUT#*███████║█████╗     ██║   ███████║█████╗  ██████╔╝}" != "$WORDMARK_OUT" ]; then
            ok "block art spells AETHER (A·E·T top row and H·E·R body row intact)"
        else
            fail "block art does not spell AETHER — a letter is malformed"
        fi
        # The block art carries a blue→cyan gradient: distinct 256-colour ramp
        # steps across the rows, not one flat accent. Assert the top and bottom
        # of the ramp are both present.
        if [ "${WORDMARK_OUT#*38;5;33m}" != "$WORDMARK_OUT" ] && \
           [ "${WORDMARK_OUT#*38;5;87m}" != "$WORDMARK_OUT" ]; then
            ok "wordmark block art carries the blue→cyan gradient ramp"
        else
            fail "wordmark is missing the gradient ramp (flat colour)"
        fi
        # The version chip renders when a version is known...
        case "$WORDMARK_OUT" in
            *'v9.9.9'*) ok "wordmark shows the version chip when set" ;;
            *) fail "wordmark did not render the version chip" ;;
        esac
    else
        fail "ui_wordmark produced no output"
    fi

    # ...and no bare "v" is left dangling when the version is unknown.
    WM_NOVER="$(AETHER_VERSION='' ui_wordmark 2>&1 || true)"
    case "$WM_NOVER" in
        *'· v'*|*' v '*) fail "wordmark printed a bare version chip with no value" ;;
        *) ok "wordmark drops the version chip cleanly when unset" ;;
    esac

    # Falls back gracefully when not unicode.
    ui_reset
    export AETHER_UI_MODE=rich
    UI_UNICODE=false
    ui_init
    UI_COLOR=true
    ui_style_init
    WM_NOUNI="$(ui_wordmark 2>&1 || true)"
    if [ -z "$WM_NOUNI" ]; then
        ok "ui_wordmark is silent in non-unicode mode (correct fallback)"
    else
        fail "ui_wordmark produced output in non-unicode mode: $WM_NOUNI"
    fi

    # Also silent in plain mode.
    ui_reset
    export AETHER_UI_MODE=plain
    ui_init
    WM_PLAIN="$(ui_wordmark 2>&1 || true)"
    if [ -z "$WM_PLAIN" ]; then
        ok "ui_wordmark is silent in plain mode"
    else
        fail "ui_wordmark produced output in plain mode"
    fi
fi

# ---------------------------------------------------------------------------
# 25. Success panel shows AETHER IS ONLINE header
# ---------------------------------------------------------------------------
if [ "$HAVE_BASH4" != "true" ]; then
    section "25. Success panel"
    skip "needs bash 4 associative arrays"
else
    section "25. Success panel shows the premium closing message"

    ui_reset
    export AETHER_UI_MODE=rich
    ui_init
    UI_INTERACTIVE=true
    UI_COLOR=true
    UI_UNICODE=true
    UI_WIDTH=80
    ui_style_init
    export AETHER_INSTALL_DIR="/opt/aether"
    ui_stage_begin_notify BACKEND "Backend" >/dev/null
    ui_stage_done_notify BACKEND "healthy" >/dev/null

    # Capture the success panel (printed to stdout, not suppressed).
    SUCCESS_OUT="$(ui_success_panel "https://example.com" 2>&1)"
    # Strip ANSI codes before pattern-matching: ui_frame_print includes escape
    # sequences (\033[?1049l for alt-screen restore, etc.) that can break a
    # bare case glob when they wrap the text.
    SUCCESS_STRIPPED="$(printf '%s' "$SUCCESS_OUT" | sed $'s/\x1b\\[[0-9;]*[a-zA-Z]//g')"
    case "$SUCCESS_STRIPPED" in
        *'AETHER IS ONLINE'*) ok "success panel says AETHER IS ONLINE" ;;
        *) fail "success panel does not contain 'AETHER IS ONLINE'" ;;
    esac
fi

# ---------------------------------------------------------------------------
# 26. The sword finale and the per-command intros are pure presentation, but
# they carry the master password on screen and draw multibyte art, so the
# guarantees that matter are: no emoji ever, every art row the same width so the
# blade can never look crooked, the credentials shown in rich mode, nothing at
# all in quiet mode, and a per-command intro that is a strict no-op off a TTY
# (so `aether status | grep` stays clean). The module runs in the standalone CLI
# too, which never calls ui_init, so it must also source cleanly on its own.
# ---------------------------------------------------------------------------
section "26. Sword finale and per-command intros"

SWORD_LIB="$REPO_DIR/deploy/lib/ui-sword.sh"

# Char-counting (${#s}) and codepoint decoding both need a UTF-8 locale; the CI
# runner may have none. Pick the first that makes a known 3-byte glyph measure
# one cell, and gate the multibyte checks on it rather than reporting a false
# failure (a byte count) as a crooked blade.
SWORD_UTF8=""
for _loc in C.UTF-8 en_US.UTF-8 en_US.utf8 en_GB.UTF-8; do
    if LC_ALL="$_loc" bash -c 'x="▒"; [ "${#x}" -eq 1 ]' 2>/dev/null; then
        SWORD_UTF8="$_loc"; break
    fi
done

# 26a: sources cleanly under the installer's own strict flags.
if ( set -euo pipefail; source "$SWORD_LIB" ) >/dev/null 2>&1; then
    ok "ui-sword.sh sources cleanly under set -euo pipefail"
else
    fail "ui-sword.sh does not source cleanly under set -euo pipefail"
fi

# shellcheck disable=SC1090
source "$SWORD_LIB"

# 26b: both faces are 16 rows; the ASCII face is pure 7-byte rows, so its width
# is checkable in any locale.
expect_eq "unicode sword face has 16 rows" 16 "${#UI_SWORD_U[@]}"
expect_eq "ASCII sword face has 16 rows" 16 "${#UI_SWORD_A[@]}"
_asc_ok=true
for _r in "${UI_SWORD_A[@]}"; do [ "${#_r}" -eq "$SWORD_CELL" ] || _asc_ok=false; done
expect_eq "every ASCII sword row is $SWORD_CELL cells wide" true "$_asc_ok"

# 26c/26d: the unicode-face width and the no-emoji scan both need char counting,
# so they run under the picked UTF-8 locale or skip honestly.
if [ -n "$SWORD_UTF8" ]; then
    (
        export LC_ALL="$SWORD_UTF8"
        uni_ok=true
        for r in "${UI_SWORD_U[@]}"; do [ "${#r}" -eq "$SWORD_CELL" ] || uni_ok=false; done
        [ "$uni_ok" = true ] && echo "WIDTH ok" || echo "WIDTH fail"

        # Codepoint scan across every glyph the module can draw — the two faces
        # plus the per-command intro set. The art is Block Elements, box-drawing
        # and geometric shapes only, all in the BMP below U+2600; anything in a
        # symbol/pictograph block, a variation selector, or (on a host that
        # surfaces astral chars as UTF-16 halves) a surrogate is a pasted emoji
        # and a failure.
        blob="${UI_SWORD_U[*]}${UI_SWORD_A[*]}◆▲•◐◓◑◒·╱╲"
        bad=""
        for ((i = 0; i < ${#blob}; i++)); do
            c="${blob:i:1}"
            cp=$(printf '%d' "'$c" 2>/dev/null || echo 0)
            if { [ "$cp" -ge 9728 ] && [ "$cp" -le 10175 ]; } ||
                { [ "$cp" -ge 11008 ] && [ "$cp" -le 11263 ]; } ||
                { [ "$cp" -ge 55296 ] && [ "$cp" -le 57343 ]; } ||
                { [ "$cp" -ge 126976 ] && [ "$cp" -le 131071 ]; } ||
                [ "$cp" -eq 65039 ]; then
                bad="$bad $cp"
            fi
        done
        [ -z "$bad" ] && echo "EMOJI none" || echo "EMOJI$bad"
    ) >"$WORK/sec26mb.txt" 2>&1
    if grep -q '^WIDTH ok' "$WORK/sec26mb.txt"; then
        ok "every unicode sword row is $SWORD_CELL cells wide (blade stays centred)"
    else
        fail "a unicode sword row is not $SWORD_CELL cells wide"
    fi
    if grep -q '^EMOJI none' "$WORK/sec26mb.txt"; then
        ok "the sword art and intro glyphs contain no emoji"
    else
        fail "an art glyph is in an emoji block: $(grep '^EMOJI' "$WORK/sec26mb.txt")"
    fi
else
    skip_n 2 "no UTF-8 locale to count art columns or scan codepoints"
fi

# 26e: in rich mode the finale carries the domain and the master credentials.
# Captured in $(...), so [ -t 1 ] is false and the animation auto-skips — the
# still panel is what a scrollback keeps anyway.
CRED_OUT="$(
    AETHER_UI_QUIET=false
    AETHER_MASTER_USERNAME=aetheradmin
    AETHER_MASTER_PASSWORD='Sw0rd-Secret-42'
    AETHER_DOMAIN=dataku.id
    AETHER_INSTALL_DIR=/opt/aether
    ui_sword_finale 'https://dataku.id' 2>&1
)"
CRED_STRIPPED="$(printf '%s' "$CRED_OUT" | sed $'s/\x1b\\[[0-9;?]*[a-zA-Z]//g')"
expect_has "finale says AETHER IS ONLINE" 'AETHER IS ONLINE' "$CRED_STRIPPED"
expect_has "finale shows the master username" 'aetheradmin' "$CRED_STRIPPED"
expect_has "finale shows the master password" 'Sw0rd-Secret-42' "$CRED_STRIPPED"

# 26f: quiet mode prints nothing at all, and never the password.
QUIET_OUT="$(
    AETHER_UI_QUIET=true
    AETHER_MASTER_USERNAME=aetheradmin
    AETHER_MASTER_PASSWORD='Sw0rd-Secret-42'
    ui_sword_finale 'https://dataku.id' 2>&1
)"
expect_eq "finale prints nothing in quiet mode" "" "$QUIET_OUT"
expect_lacks "quiet finale never prints the password" 'Sw0rd-Secret-42' "$QUIET_OUT"

# 26g: the per-command intro is a strict no-op off a TTY (each capture is a pipe,
# so `aether status | grep` sees no escape codes and no stray glyphs).
CMD_NONTTY=""
for _c in status logs update backup restore restart doctor bogus; do
    CMD_NONTTY="$CMD_NONTTY$(ui_cmd_anim "$_c" 2>&1)"
done
expect_eq "ui_cmd_anim writes nothing without a TTY" "" "$CMD_NONTTY"

# ---------------------------------------------------------------------------
printf '\n\033[1m== Summary\033[0m\n'
printf '  %d passed, %d failed, %d skipped\n\n' "$PASS" "$FAIL" "$SKIP"
[ "$FAIL" -eq 0 ]

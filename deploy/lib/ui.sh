#!/usr/bin/env bash
# Aether Cloud OS — installer UI.
#
# A presentation layer over the installer's stage state. It renders; it never
# decides. Nothing in this file starts, skips, retries, or completes an
# operation — install.sh and the libraries it sources still do exactly what they
# did before, in the same order, with the same exit codes. Delete this file and
# core.sh falls back to its old line-based output and the install still works.
#
# Design constraints, in the order they were applied:
#
#   * One writer. A background painter drawing while the engine prints tears the
#     screen, so there is no background painter. Long operations are run by
#     ui_run, which sends the child's output to a file and lets the parent — the
#     only thing that touches the terminal — poll and redraw.
#
#   * No invented numbers. A percentage is rendered only where the caller passed
#     a real current/total. There is no code path here that estimates a total,
#     interpolates one over time, or reaches 100 before the stage is complete.
#     Where there is no denominator the bar is indeterminate and the elapsed
#     time and the operation's own last line of output carry the information.
#
#   * Never fail because of the terminal. Every rich feature is behind a
#     capability check and has a plain fallback; the plain path reproduces the
#     original behaviour, byte for byte, so a non-TTY, a dumb terminal, a pipe,
#     and CI all see what they saw before.
#
# Sourced by core.sh, never executed directly.

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
# Declared here rather than in ui_init because core.sh can log before the entry
# point has had a chance to detect anything, and under `set -u` an unset style
# variable is a fatal error rather than a formatting glitch.
UI_MODE="plain"
UI_COLOR=false
UI_UNICODE=false
UI_ANIMATION=true
UI_INTERACTIVE=false
UI_WIDTH=80
UI_ROWS=24
UI_POLL_INTERVAL=0.4
UI_PANEL_DRAWN=0
# Set while the terminal has been handed back for an interactive prompt. A log
# line arriving in this window must not repaint the panel on top of what the
# operator is typing, so the renderer records it and holds the draw until the
# next stage begins. Without this, prompting during a rich install is a race
# between `read` and the next info() call.
UI_PANEL_HOLD=false
UI_FRAME_TEXT=""
UI_FRAME_LINES=0
UI_LAST_FRAME=""
UI_CURSOR_HIDDEN=false
UI_RUN_PID=""
UI_RUN_FILE=""
# Set true by whichever end-of-run panel drew last — success, error, or
# interrupt. The installer's EXIT trap reads it to decide whether a nonzero exit
# still needs an error panel, so a run that already showed one is not painted
# over, and a bare `set -e` abort that showed nothing still gets one.
UI_FINALIZED=false
UI_ACTIVITY=()
UI_ACTIVITY_MAX=8
UI_SECRETS=()
# declare -A: an empty compound assignment to an undeclared name makes an
# *indexed* array, whose subscript is evaluated as arithmetic — so
# UI_FACTS["platform"] would expand the variable `platform` and, under `set -u`,
# die with "platform: unbound variable" instead of storing a fact.
#
# -g, not a plain -A: a `declare` inside a function creates a *local* array, and
# whether this file is sourced at the top level of a script or from inside a
# function is the caller's business, not this file's. install.sh sources core.sh
# at the top level today, so a plain -A works — and then stops working the first
# time a caller wraps that source in a function, at which point the store is
# silently gone and the next ui_fact_set dies on an arithmetic subscript.
# ui-state.sh declares its registry the same way, for the same reason.
#
# The `-A` option itself is bash 4, and this line runs at source time, before
# any function guard. On a bash 3 host it would be "declare: -A: invalid option"
# and, under `set -e`, would abort the whole installer as ui.sh is sourced. So it
# is guarded: rich mode requires bash 4 anyway, and the fact functions no-op
# below when the array could not be created. (`-g` itself needs 4.2, but core.sh
# sources ui-state.sh first and that file already needs it, so a bash too old for
# this line never reaches it.)
if [ "${BASH_VERSINFO[0]:-0}" -ge 4 ] 2>/dev/null; then
    declare -gA UI_FACTS=()
    declare -gA UI_RUNTIME=()
    declare -gA UI_PROFILE=()
fi
UI_FACTS_ORDER=()
UI_RUNTIME_ORDER=()
UI_PROFILE_ORDER=()
UI_S_RESET=""
UI_S_BOLD=""
UI_S_DIM=""
UI_S_ACCENT=""
UI_S_OK=""
UI_S_FAIL=""
UI_S_RUN=""
UI_B_TL='+'
UI_B_TR='+'
UI_B_BL='+'
UI_B_BR='+'
UI_B_H='-'
UI_B_V='|'
# The separator between items on the facts, runtime and profile lines. A
# variable rather than a literal so it follows the same Unicode decision as every
# other glyph: on a locale that gets ASCII box borders, a multi-byte `·` is the
# one thing on the row the terminal cannot render — and it also throws the width
# arithmetic off, because ${#var} counts bytes there and columns here.
UI_G_SEP='-'
# What a truncated string is marked with. Part of the glyph set for the same
# reason as the separator: `…` on a terminal that cannot render it is not a mark,
# it is a mojibake byte, and the string it was supposed to flag as cut reads as
# corrupt instead of shortened.
UI_G_ELLIPSIS='...'
UI_B_LT='+'
UI_B_RT='+'
UI_INNER=76
UI_ROW_BUF=""
UI_ROW_LEN=0

# ---------------------------------------------------------------------------
# Capability detection
# ---------------------------------------------------------------------------
# Set by the entry points before ui_init:
#
#   AETHER_UI_QUIET      --quiet          nothing on stdout, log file only
#   AETHER_UI_VERBOSE    --verbose        stream every command's output, no panel
#   AETHER_UI_ANIMATION  --no-animation   panel without spinner or timed repaint
#
# AETHER_UI_MODE in the environment overrides detection outright, which is how
# the tests exercise each path without a real terminal.
ui_capability_detect() {
    UI_INTERACTIVE=false
    [ -t 1 ] && UI_INTERACTIVE=true

    local term="${TERM:-}"

    if [ -n "${AETHER_UI_MODE:-}" ]; then
        UI_MODE="$AETHER_UI_MODE"
    elif [ "${AETHER_UI_QUIET:-false}" = "true" ]; then
        UI_MODE="quiet"
    elif [ "${AETHER_UI_VERBOSE:-false}" = "true" ]; then
        # Verbose means the operator wants the raw stream, so the panel is off
        # even on a rich terminal. A panel that swallowed the output someone
        # explicitly asked to see would be a worse answer than no panel.
        UI_MODE="plain"
    elif [ "$UI_INTERACTIVE" != "true" ]; then
        UI_MODE="plain"
    elif [ -z "$term" ] || [ "$term" = "dumb" ]; then
        UI_MODE="plain"
    elif [ "${UI_STATE_SUPPORTED:-false}" != "true" ]; then
        # The panel is drawn from the stage registry. Without associative arrays
        # there is no registry, and a panel with nothing to show is worse than
        # the line output it replaced.
        UI_MODE="plain"
    else
        UI_MODE="rich"
    fi

    [ "${AETHER_UI_ANIMATION:-true}" = "false" ] && UI_ANIMATION=false

    # Colour and Unicode are independent of layout: a dumb terminal gets the
    # plain layout, and a rich terminal with no UTF-8 locale gets the rich layout
    # drawn in ASCII. NO_COLOR is honoured because it is the one convention every
    # tool agrees on.
    UI_COLOR=false
    if [ "$UI_MODE" != "quiet" ] && [ "$UI_INTERACTIVE" = "true" ] &&
        [ -n "$term" ] && [ "$term" != "dumb" ] && [ -z "${NO_COLOR:-}" ]; then
        UI_COLOR=true
    fi

    UI_UNICODE=false
    case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
        *UTF-8* | *UTF8* | *utf-8* | *utf8*) UI_UNICODE=true ;;
    esac

    if [ "$UI_MODE" = "rich" ]; then
        UI_WIDTH="$(ui_term_width)"
        UI_ROWS="$(ui_term_rows)"
    fi
    # The drawable width inside the frame: `│` + two spaces + content + two
    # spaces + `│`. Every row and panel is laid out against this, so it is
    # computed once, here, rather than in each renderer.
    UI_INNER=$((UI_WIDTH - 6))

    ui_style_init
}

ui_term_width() {
    local cols="${COLUMNS:-}"
    if [ -z "$cols" ] && command -v tput >/dev/null 2>&1; then
        cols="$(tput cols 2>/dev/null || true)"
    fi
    case "$cols" in
        '' | *[!0-9]*) cols=80 ;;
    esac
    [ "$cols" -lt 64 ] && cols=64
    [ "$cols" -gt 100 ] && cols=100
    printf '%s' "$cols"
}

ui_term_rows() {
    local rows="${LINES:-}"
    if [ -z "$rows" ] && command -v tput >/dev/null 2>&1; then
        rows="$(tput lines 2>/dev/null || true)"
    fi
    case "$rows" in
        '' | *[!0-9]*) rows=24 ;;
    esac
    [ "$rows" -lt 10 ] && rows=24
    printf '%s' "$rows"
}

# ---------------------------------------------------------------------------
# Styling
# ---------------------------------------------------------------------------
ui_style_init() {
    if [ "$UI_COLOR" = "true" ]; then
        UI_S_RESET=$'\033[0m'
        UI_S_BOLD=$'\033[1m'
        UI_S_DIM=$'\033[2m'
        UI_S_ACCENT=$'\033[38;5;39m'
        UI_S_OK=$'\033[38;5;35m'
        UI_S_FAIL=$'\033[38;5;203m'
        UI_S_RUN=$'\033[38;5;214m'
    else
        UI_S_RESET=""
        UI_S_BOLD=""
        UI_S_DIM=""
        UI_S_ACCENT=""
        UI_S_OK=""
        UI_S_FAIL=""
        UI_S_RUN=""
    fi
    ui_border_init
}

# The frame. Box-drawing characters are the visual signature of the terminal UIs
# this is measured against, but they are only used when the locale says the
# terminal will render them: a serial console gets `+`, `-` and `|`, which lay
# out identically and read on a device that has no box-drawing font at all.
ui_border_init() {
    if [ "$UI_UNICODE" = "true" ]; then
        UI_B_TL='╭'
        UI_B_TR='╮'
        UI_B_BL='╰'
        UI_B_BR='╯'
        UI_B_H='─'
        UI_B_V='│'
        UI_B_LT='├'
        UI_B_RT='┤'
        UI_G_SEP='·'
        UI_G_ELLIPSIS='…'
    else
        UI_B_TL='+'
        UI_B_TR='+'
        UI_B_BL='+'
        UI_B_BR='+'
        UI_B_H='-'
        UI_B_V='|'
        UI_B_LT='+'
        UI_B_RT='+'
        UI_G_SEP='-'
        UI_G_ELLIPSIS='...'
    fi
}

# The glyph set. Unicode is used only where the locale says the terminal will
# render it; the ASCII set is not an afterthought, it is what a serial console
# and a `dumb` terminal get, and it has to stay readable.
ui_glyph_ok() { if [ "$UI_UNICODE" = "true" ]; then printf '✓'; else printf 'ok'; fi; }
ui_glyph_fail() { if [ "$UI_UNICODE" = "true" ]; then printf '✗'; else printf '!!'; fi; }
ui_glyph_run() { if [ "$UI_UNICODE" = "true" ]; then printf '▸'; else printf '>>'; fi; }
ui_glyph_wait() { if [ "$UI_UNICODE" = "true" ]; then printf '·'; else printf '..'; fi; }
ui_glyph_skip() { if [ "$UI_UNICODE" = "true" ]; then printf '–'; else printf '--'; fi; }
ui_glyph_bar_full() { if [ "$UI_UNICODE" = "true" ]; then printf '█'; else printf '#'; fi; }
ui_glyph_bar_half() { if [ "$UI_UNICODE" = "true" ]; then printf '▒'; else printf '+'; fi; }
ui_glyph_bar_empty() { if [ "$UI_UNICODE" = "true" ]; then printf '░'; else printf '-'; fi; }
ui_glyph_rule() { if [ "$UI_UNICODE" = "true" ]; then printf '─'; else printf '-'; fi; }

# ---------------------------------------------------------------------------
# Text helpers — fork-free on purpose. The panel is redrawn several times a
# second while a container image builds, on a host with one core, and a subshell
# per field is what turns a live panel into a stutter.
# ---------------------------------------------------------------------------
ui_repeat() {
    local char="$1" count="$2" pad
    [ "$count" -gt 0 ] || return 0
    printf -v pad '%*s' "$count" ''
    printf '%s' "${pad// /$char}"
}

ui_rule() {
    printf '%s%s%s' "$UI_S_DIM" "$(ui_repeat "$(ui_glyph_rule)" "$UI_WIDTH")" "$UI_S_RESET"
}

# printf -v rather than command substitution: same result, no process.
ui_pad() {
    local text="$1" width="$2" out
    printf -v out '%-*s' "$width" "$text"
    printf '%s' "$out"
}

# Truncation always leaves a mark, because a string that stops without one reads as
# a string that ended there — and every caller here is shortening something the
# operator is meant to read as incomplete. The mark is a glyph like any other: `…`
# where the locale renders it, three dots where it does not. It is accounted for by
# its own length rather than a hard-coded 1, so the result is still exactly `max`
# wide in both modes and a caller's column arithmetic stays true.
ui_truncate() {
    local text="$1" max="$2" mark="$UI_G_ELLIPSIS"
    [ "$max" -gt 0 ] || return 0
    if [ "${#text}" -gt "$max" ]; then
        if [ "$max" -gt "${#mark}" ]; then
            printf '%s' "${text:0:$((max - ${#mark}))}${mark}"
        else
            printf '%s' "${text:0:$max}"
        fi
    else
        printf '%s' "$text"
    fi
}

ui_strip_ansi() {
    sed $'s/\033\\[[0-9;]*[A-Za-z]//g; s/\033\\][^\007]*\007//g'
}

ui_fmt_duration() {
    local seconds="${1:-}"
    case "$seconds" in
        '' | *[!0-9]*) return 0 ;;
    esac
    if [ "$seconds" -lt 60 ]; then
        printf '%ss' "$seconds"
    else
        printf '%dm%02ds' "$((seconds / 60))" "$((seconds % 60))"
    fi
}

# ---------------------------------------------------------------------------
# Redaction
# ---------------------------------------------------------------------------
# Requirement: no password, API key, token, private key, database credential, or
# bootstrap secret may reach the screen or the log. Two mechanisms, because the
# two kinds of secret are known differently:
#
#   * a pattern pass, for anything that arrives already labelled — `PASSWORD=`,
#     `postgres://user:pw@`, `Bearer ...`, a PEM header;
#   * a literal pass over values the installer itself holds in variables, which
#     is the only way to catch a secret printed without its label.
#
# The literal pass is skipped for short values: redacting every occurrence of a
# short string would rewrite unrelated log lines, and hiding real output is its
# own kind of lie.
ui_secret_add() {
    local value="${1:-}"
    [ -n "$value" ] || return 0
    [ "${#value}" -ge 8 ] || return 0
    UI_SECRETS+=("$value")
}

ui_redact() {
    local text="$1" secret escaped
    for secret in "${UI_SECRETS[@]:-}"; do
        [ -n "$secret" ] || continue
        # Escaped for a literal sed replacement. A password containing a slash or
        # an ampersand would otherwise turn the pattern into a different one.
        escaped=$(printf '%s' "$secret" | sed -e 's/[][\\.^$*+?(){}|/&]/\\&/g')
        text=$(printf '%s' "$text" | sed -e "s/${escaped}/<redacted>/g")
    done

    # The `I` flag makes the keyword match case-insensitive, so an environment
    # variable (POSTGRES_PASSWORD, AETHER_JWT_SECRET) is caught as well as the
    # lower-case prose of a log line. GNU sed only, which is what every target —
    # Ubuntu — and both test hosts run. The keyword pattern also swallows an
    # optional `Bearer`/`Basic` prefix inside the value: without it, an
    # `Authorization: Bearer <token>` line would lose the word "Bearer" and leave
    # the token itself in the clear.
    # A private key is the one secret here that spans lines: matching to the end
    # of the BEGIN line leaves the base64 body — the part that actually is the key
    # — sitting in the clear on the following lines. So the rule is a range,
    # from BEGIN to END, collapsed to a single marker line. A truncated key with
    # no END takes the rest of the output with it, which is the right way to be
    # wrong: over-redacting a log costs some lines, leaking a key costs the host.
    printf '%s' "$text" | sed -E \
        -e 's/(password|passwd|passphrase|secret|token|api[_-]?key|private[_-]?key|authorization|credential)([[:space:]]*[:=][[:space:]]*)((bearer|basic)[[:space:]]+)?[^[:space:]"'"'"']+/\1\2<redacted>/gI' \
        -e 's#([a-zA-Z][a-zA-Z0-9+.-]*://)[^:/@[:space:]]+:[^@[:space:]]+@#\1<redacted>@#g' \
        -e 's/(bearer[[:space:]]+)[A-Za-z0-9._~+/=-]{8,}/\1<redacted>/gI' \
        -e '/-----BEGIN [A-Z ]*PRIVATE KEY-----/,/-----END [A-Z ]*PRIVATE KEY-----/c\-----BEGIN PRIVATE KEY----- <redacted>'
}

# The same rules, applied to a stream that is too large to hold in a variable.
#
# A build log runs to tens of thousands of lines. Calling ui_redact once per line
# would fork a sed per line — on one core, more work than the build that produced
# the log — so the literal secrets are folded into a single sed program and the
# whole stream goes through one process.
ui_redact_stream() {
    local program="" secret escaped
    for secret in "${UI_SECRETS[@]:-}"; do
        [ -n "$secret" ] || continue
        escaped=$(printf '%s' "$secret" | sed -e 's/[][\\.^$*+?(){}|/&]/\\&/g')
        program+="s/${escaped}/<redacted>/g;"
    done

    sed -E -e "$program" \
        -e 's/(password|passwd|passphrase|secret|token|api[_-]?key|private[_-]?key|authorization|credential)([[:space:]]*[:=][[:space:]]*)((bearer|basic)[[:space:]]+)?[^[:space:]"'"'"']+/\1\2<redacted>/gI' \
        -e 's#([a-zA-Z][a-zA-Z0-9+.-]*://)[^:/@[:space:]]+:[^@[:space:]]+@#\1<redacted>@#g' \
        -e 's/(bearer[[:space:]]+)[A-Za-z0-9._~+/=-]{8,}/\1<redacted>/gI' \
        -e '/-----BEGIN [A-Z ]*PRIVATE KEY-----/,/-----END [A-Z ]*PRIVATE KEY-----/c\-----BEGIN PRIVATE KEY----- <redacted>'
}

# ---------------------------------------------------------------------------
# Activity feed
# ---------------------------------------------------------------------------
# The panel shows the last few real log lines: the same lines that go to the log
# file, unedited, so what is on screen is what is in the log.
ui_activity_push() {
    local line="$1"
    UI_ACTIVITY+=("$line")
    while [ "${#UI_ACTIVITY[@]}" -gt "$UI_ACTIVITY_MAX" ]; do
        UI_ACTIVITY=("${UI_ACTIVITY[@]:1}")
    done
}

# ---------------------------------------------------------------------------
# System facts
# ---------------------------------------------------------------------------
# Published by the engine as preflight learns them. The panel renders whatever
# has been published and nothing else — it cannot describe a host it has not
# measured, which is the difference between an analysis and a decoration.
#
# Two groups, because they do not fit on one line and the host group is the one
# that must not be cut in half. "host" is the machine (platform, arch, cpu, ram,
# disk); "runtime" is what is installed on it (Docker, Compose). Each renders as
# its own dim row under the activity feed, the runtime row only when the terminal
# is tall enough for it — see ui_render_dashboard.
ui_fact_set() {
    [ "$UI_STATE_SUPPORTED" = "true" ] || return 0
    local key="$1" value="${2:-}" group="${3:-host}" existing
    [ -n "$value" ] || return 0
    if [ "$group" = "runtime" ]; then
        for existing in "${UI_RUNTIME_ORDER[@]:-}"; do
            if [ "$existing" = "$key" ]; then
                UI_RUNTIME["$key"]="$value"
                return 0
            fi
        done
        UI_RUNTIME_ORDER+=("$key")
        UI_RUNTIME["$key"]="$value"
        return 0
    fi
    for existing in "${UI_FACTS_ORDER[@]:-}"; do
        if [ "$existing" = "$key" ]; then
            UI_FACTS["$key"]="$value"
            return 0
        fi
    done
    UI_FACTS_ORDER+=("$key")
    UI_FACTS["$key"]="$value"
    return 0
}

ui_fact_line() {
    [ "$UI_STATE_SUPPORTED" = "true" ] || return 0
    local key joined="" i
    [ "${#UI_FACTS_ORDER[@]}" -gt 0 ] || return 0
    for key in "${UI_FACTS_ORDER[@]}"; do
        [ -n "$joined" ] && joined+=" $UI_G_SEP "
        joined+="${UI_FACTS[$key]}"
    done
    printf '%s' "$joined"
}

ui_runtime_line() {
    [ "$UI_STATE_SUPPORTED" = "true" ] || return 0
    local key joined=""
    [ "${#UI_RUNTIME_ORDER[@]}" -gt 0 ] || return 0
    for key in "${UI_RUNTIME_ORDER[@]}"; do
        [ -n "$joined" ] && joined+=" $UI_G_SEP "
        joined+="${UI_RUNTIME[$key]}"
    done
    printf '%s' "$joined"
}

# ---------------------------------------------------------------------------
# Deployment profile
# ---------------------------------------------------------------------------
# The facts line is what this host measured. The profile is what is being
# installed on it, and the two fail differently: an unmeasured fact is a guess,
# but an unearned profile line is an assumption dressed as a diagnosis. So it is
# stored and rendered exactly the same way — published by the engine at the
# point where the condition is actually observed, and empty until then. The
# renderer composes nothing here; it prints what it was given, or nothing.
ui_profile_set() {
    [ "$UI_STATE_SUPPORTED" = "true" ] || return 0
    local key="$1" value="${2:-}" existing
    [ -n "$value" ] || return 0
    for existing in "${UI_PROFILE_ORDER[@]:-}"; do
        if [ "$existing" = "$key" ]; then
            UI_PROFILE["$key"]="$value"
            return 0
        fi
    done
    UI_PROFILE_ORDER+=("$key")
    UI_PROFILE["$key"]="$value"
    return 0
}

# Render the profile as rows of at most `max` columns, breaking between items and
# never inside one, and stopping at `max_rows` rows.
#
# Wrapping rather than truncating is the point. This line replaced a blank spacer
# row in the panel, and a roomy terminal has rows to spare, so the worst case is a
# frame one line taller than it used to be — where the alternative is a spec item
# the operator cannot read because his SSH window is 80 columns. Only the last
# resort, a terminal with no room for a second row, cuts — and ui_truncate marks
# that cut with an ellipsis, so what is on screen never claims to be the whole
# profile when it is not.
ui_profile_render() {
    local prefix="$1" max="$2" max_rows="${3:-1}"
    [ "$UI_STATE_SUPPORTED" = "true" ] || return 0
    [ "${#UI_PROFILE_ORDER[@]}" -gt 0 ] || return 0
    [ "$max" -gt 0 ] || return 0

    local pad room row=1 line="" rowprefix="$prefix" item
    printf -v pad '%*s' "${#prefix}" ''
    room=$((max - ${#prefix}))
    [ "$room" -gt 0 ] || return 0

    for item in "${UI_PROFILE_ORDER[@]}"; do
        item="${UI_PROFILE[$item]}"
        [ -n "$item" ] || continue
        if [ -n "$line" ] && [ $(( ${#line} + 3 + ${#item} )) -gt "$room" ]; then
            if [ "$row" -ge "$max_rows" ]; then
                # Out of rows: fold the item into the last one and let the final
                # truncation mark where the line stopped.
                line+=" $UI_G_SEP ${item}"
                continue
            fi
            printf '%s%s\n' "$rowprefix" "$(ui_truncate "$line" "$room")"
            row=$((row + 1))
            rowprefix="$pad"
            line="$item"
            continue
        fi
        if [ -n "$line" ]; then
            line+=" $UI_G_SEP ${item}"
        else
            line="$item"
        fi
    done

    [ -n "$line" ] || return 0
    printf '%s%s\n' "$rowprefix" "$(ui_truncate "$line" "$room")"
    return 0
}

# ---------------------------------------------------------------------------
# Frame
# ---------------------------------------------------------------------------
ui_frame_begin() {
    UI_FRAME_TEXT=""
    UI_FRAME_LINES=0
}

ui_frame_line() {
    UI_FRAME_TEXT+="$1"$'\n'
    UI_FRAME_LINES=$((UI_FRAME_LINES + 1))
}

ui_frame_flush() {
    if [ "$UI_PANEL_DRAWN" -gt 0 ]; then
        # Return to the frame's saved cursor position rather than counting lines
        # back from wherever the cursor is now. The two are the same only while
        # nothing else has written to the terminal. A command that printed to
        # stdout without going through ui_run — `ufw`, `git clone`, a compose run,
        # `systemd` — leaves the cursor below the frame, and a relative move from
        # there lands *inside* the panel and clears the wrong region: a line of
        # the old frame survives above the new one, the offset grows with every
        # stray line, and the panel tears. DECRC is unaffected by that output, so
        # the erase window is correct whatever happened between frames.
        printf '\0338\033[J'
    else
        # Anchor the frame here. Every redraw below restores to this point.
        printf '\0337'
    fi
    printf '%s' "$UI_FRAME_TEXT"
    UI_PANEL_DRAWN="$UI_FRAME_LINES"
}

ui_cursor_hide() {
    [ "$UI_INTERACTIVE" = "true" ] || return 0
    [ "$UI_CURSOR_HIDDEN" = "true" ] && return 0
    printf '\033[?25l'
    UI_CURSOR_HIDDEN=true
}

ui_cursor_show() {
    [ "$UI_CURSOR_HIDDEN" = "true" ] || return 0
    printf '\033[?25h'
    UI_CURSOR_HIDDEN=false
}

# Called before anything that needs the terminal back: a prompt, an error dump,
# or exit.
ui_panel_suspend() {
    [ "$UI_PANEL_DRAWN" -gt 0 ] || return 0
    printf '\0338\033[J'
    UI_PANEL_DRAWN=0
    UI_LAST_FRAME=""
}

# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------
ui_status_glyph() {
    case "$1" in
        SUCCESS) ui_glyph_ok ;;
        FAILED) ui_glyph_fail ;;
        RUNNING) ui_glyph_run ;;
        SKIPPED) ui_glyph_skip ;;
        *) ui_glyph_wait ;;
    esac
}

ui_status_colour() {
    case "$1" in
        SUCCESS) printf '%s' "$UI_S_OK" ;;
        FAILED) printf '%s' "$UI_S_FAIL" ;;
        RUNNING) printf '%s' "$UI_S_RUN" ;;
        *) printf '%s' "$UI_S_DIM" ;;
    esac
}

# --- rows inside the frame -------------------------------------------------
# A box has to be exactly as wide on every row, and coloured text has a visible
# width that is not its string length. So a row is assembled from (colour, plain)
# pairs while the visible width is counted from the plain parts alone, and the
# padding is added at the end. One fork-free pass, and the right border lands in
# the same column on every line.
ui_row_reset() {
    UI_ROW_BUF=""
    UI_ROW_LEN=0
}

ui_row_add() {
    UI_ROW_BUF+="$1$2"
    UI_ROW_LEN=$((UI_ROW_LEN + ${#2}))
}

ui_row_fill_to() {
    # Split deliberately: bash expands every word of a single `local` before
    # performing any of its assignments, so
    # `local target="$1" pad=$((target - UI_ROW_LEN))` reads an unset `target`.
    local target="$1"
    local pad=$((target - UI_ROW_LEN))
    [ "$pad" -gt 0 ] || return 0
    UI_ROW_BUF+="$(ui_repeat ' ' "$pad")"
    UI_ROW_LEN=$target
}

ui_row_end() {
    local pad=$((UI_INNER - UI_ROW_LEN))
    [ "$pad" -lt 0 ] && pad=0
    ui_frame_line "${UI_B_V}  ${UI_ROW_BUF}$(ui_repeat ' ' "$pad")  ${UI_B_V}"
}

# The titled top border. The gap is computed from the *visible* widths so the
# closing corner lands in column UI_WIDTH exactly, matching every row below it:
#
#   ╭─ <left> <gap of ─> <right> ─╮      = 8 + len(left) + len(right) + gap
#   ╭─ <left> <gap of ─> ─╮              = 6 + len(left) + gap   (no right)
#
# The title colour is a parameter so the failure and interrupt panels can reuse
# this without the accent that reads as "healthy".
ui_box_top() {
    local left="$1" right="${2:-}" colour="${3:-$UI_S_ACCENT}"
    local used gap
    if [ -n "$right" ]; then
        used=$((8 + ${#left} + ${#right}))
    else
        used=$((6 + ${#left}))
    fi
    gap=$((UI_WIDTH - used))
    [ "$gap" -lt 1 ] && gap=1

    local rule
    rule="$(ui_repeat "$UI_B_H" "$gap")"
    if [ -n "$right" ]; then
        ui_frame_line "${UI_S_DIM}${UI_B_TL}${UI_B_H}${UI_S_RESET} ${UI_S_BOLD}${colour}${left}${UI_S_RESET} ${UI_S_DIM}${rule}${UI_S_RESET} ${UI_S_DIM}${right}${UI_S_RESET} ${UI_S_DIM}${UI_B_H}${UI_B_TR}${UI_S_RESET}"
    else
        ui_frame_line "${UI_S_DIM}${UI_B_TL}${UI_B_H}${UI_S_RESET} ${UI_S_BOLD}${colour}${left}${UI_S_RESET} ${UI_S_DIM}${rule}${UI_B_H}${UI_B_TR}${UI_S_RESET}"
    fi
}

ui_box_mid() {
    ui_frame_line "${UI_S_DIM}${UI_B_LT}$(ui_repeat "$UI_B_H" $((UI_WIDTH - 2)))${UI_B_RT}${UI_S_RESET}"
}

ui_box_bottom() {
    ui_frame_line "${UI_S_DIM}${UI_B_BL}$(ui_repeat "$UI_B_H" $((UI_WIDTH - 2)))${UI_B_BR}${UI_S_RESET}"
}

# A blank content row, for breathing room inside a box.
ui_row_blank() {
    ui_row_reset
    ui_row_end
}

# A single free-text line inside the box, already colour-styled by the caller.
ui_row_text() {
    ui_row_reset
    ui_row_add "${2:-}" "$(ui_truncate "$1" "$UI_INNER")"
    ui_row_end
}

# The panels below build a frame and print it once. Unlike the dashboard they
# are not redrawn, so they go straight to stdout with no erase — a completed
# install, a failure, and an interrupt each want to stay in the scrollback.
ui_frame_print() {
    printf '\n%s\n' "$UI_FRAME_TEXT"
}

# One stage, written straight into the current row. The id is fixed-width by
# design — it is what the state file records and what an operator greps for — so
# the only variable part is the duration, right-aligned in a fixed field.
ui_row_stage_cell() {
    local id="$1" cell_width="$2"
    local status duration="" name
    status="$(ui_stage_status "$id")"
    case "$status" in
        SUCCESS | FAILED | SKIPPED | RUNNING)
            duration="$(ui_fmt_duration "$(ui_stage_duration "$id")")"
            ;;
    esac

    local id_width=$((cell_width - 12))
    [ "$id_width" -lt 8 ] && id_width=8
    printf -v name '%s' "$(ui_pad "$(ui_truncate "$id" "$id_width")" "$id_width")"

    ui_row_add "$(ui_status_colour "$status")" "$(ui_status_glyph "$status") $name"
    ui_row_add "$UI_S_DIM" "$(ui_pad "$duration" 8)"
}

# The full stage list. One place, so the dashboard and the closing panel can
# never disagree about the layout — or about what a stage's status was.
ui_row_stage_grid() {
    local ids=() id
    for id in $(ui_stage_ids); do ids+=("$id"); done
    local columns=1
    [ "$UI_INNER" -ge 70 ] && columns=2
    local rows=$(((${#ids[@]} + columns - 1) / columns))
    local cell_width=$UI_INNER
    [ "$columns" -eq 2 ] && cell_width=$(((UI_INNER - 3) / 2))

    local r c index
    for ((r = 0; r < rows; r++)); do
        ui_row_reset
        for ((c = 0; c < columns; c++)); do
            index=$((c * rows + r))
            [ "$index" -lt "${#ids[@]}" ] || continue
            [ "$c" -gt 0 ] && ui_row_add "$UI_S_DIM" " ${UI_B_V} "
            ui_row_stage_cell "${ids[$index]}" "$cell_width"
        done
        ui_row_end
    done
}

# A label and its value, aligned on a shared column. Used by the panels that
# report a result rather than a running state.
ui_row_field() {
    local label="$1" value="$2" width="${3:-12}"
    ui_row_reset
    ui_row_add "$UI_S_BOLD" "$(ui_pad "$label" "$width")"
    ui_row_add "$UI_S_RESET" "$(ui_truncate "$value" $((UI_INNER - width)))"
    ui_row_end
}

# The bar, written into the current row.
#
# Which of the two forms is drawn is decided by the caller having passed a total,
# never by a heuristic. A determinate bar's fill is cur/total — and while the
# stage is still RUNNING the percentage is held below 100, because a bar that
# reads 100% while the operation is still going is exactly the claim this whole
# file exists to avoid making. The counters show the honest cur/total either way.
ui_row_bar() {
    local id="$1"
    local cur="${UI_STAGE_CUR[$id]:-}" total="${UI_STAGE_TOTAL[$id]:-}" unit="${UI_STAGE_UNIT[$id]:-}"
    local width=24 i

    ui_row_add "$UI_S_DIM" "["
    if [ -n "$cur" ] && [ -n "$total" ] && [ "$total" -gt 0 ]; then
        local filled=$((cur * width / total))
        local pct=$((cur * 100 / total))
        [ "$filled" -gt "$width" ] && filled=$width
        if [ "$(ui_stage_status "$id")" = "RUNNING" ] && [ "$pct" -ge 100 ]; then
            pct=99
            filled=$((width - 1))
        fi
        [ "$filled" -lt 0 ] && filled=0
        for ((i = 0; i < filled; i++)); do ui_row_add "$UI_S_OK" "$(ui_glyph_bar_full)"; done
        for ((i = filled; i < width; i++)); do ui_row_add "$UI_S_DIM" "$(ui_glyph_bar_empty)"; done
        ui_row_add "$UI_S_DIM" "] "
        local pct_text
        printf -v pct_text '%3d%%' "$pct"
        ui_row_add "$UI_S_DIM" "$pct_text"
        ui_row_add "$UI_S_DIM" "   ${cur}/${total}${unit:+ }${unit}"
        return 0
    fi

    # No denominator: an indeterminate sweep. Its position comes from the clock,
    # which is the one thing here that is definitely real. With animation off it
    # is a still track, and the elapsed time beside it still moves.
    local offset=-1
    if [ "$UI_ANIMATION" = "true" ]; then
        offset=$(( $(date +%s) % (width - 5) ))
    fi
    for ((i = 0; i < width; i++)); do
        if [ "$offset" -ge 0 ] && [ "$i" -ge "$offset" ] && [ "$i" -lt $((offset + 5)) ]; then
            ui_row_add "$UI_S_RUN" "$(ui_glyph_bar_half)"
        else
            ui_row_add "$UI_S_DIM" "$(ui_glyph_bar_empty)"
        fi
    done
    ui_row_add "$UI_S_DIM" "]"
    return 0
}

ui_render_dashboard() {
    ui_frame_begin
    UI_INNER=$((UI_WIDTH - 6))

    local done_count=0 total_count=0 id
    for id in $(ui_stage_ids); do
        total_count=$((total_count + 1))
        case "$(ui_stage_status "$id")" in
            SUCCESS | SKIPPED | FAILED) done_count=$((done_count + 1)) ;;
        esac
    done

    # The live counters go in the frame's own title bar: the position in the plan
    # and the elapsed time are the two facts an operator checks first, and they
    # belong where the eye already is rather than in a row of their own.
    local elapsed summary
    elapsed="$(ui_fmt_duration "$(ui_elapsed_total)")"
    summary="${done_count} of ${total_count} done"
    [ -n "$elapsed" ] && summary+=" $UI_G_SEP ${elapsed}"
    ui_box_top "AETHER CLOUD OS" "$summary"

    # The deployment profile sits under the title, above the plan: it describes
    # what is being installed, where the facts line at the bottom describes where.
    # It takes the row that used to be blank spacer, and gets a second row on a
    # terminal with the height for it — see ui_profile_render. Empty until
    # preflight has observed something to say, and then it is the blank row again.
    # Two rows only from 26 rows up. In the band below that the frame has no
    # height to spare — the rows the wrap would need are the rows the feed and the
    # facts line are using — so a narrow terminal gets the one row and the
    # ellipsis, which is honest about being cut.
    local profile_rows=1 profile_line profile_drawn=false
    if [ "$UI_ROWS" -ge 26 ]; then
        profile_rows=2
    fi
    while IFS= read -r profile_line; do
        [ -n "$profile_line" ] || continue
        profile_drawn=true
        ui_row_reset
        ui_row_add "$UI_S_DIM" "$profile_line"
        ui_row_end
    done < <(ui_profile_render "Profile " "$UI_INNER" "$profile_rows")
    if [ "$profile_drawn" = false ]; then
        # Nothing published yet — preflight has not measured anything to say. The
        # row stays as the blank spacer it replaced, so the frame has the same
        # shape before and after the first item lands.
        ui_row_reset
        ui_row_end
    fi

    # Stage list in two columns: thirteen rows would push the activity feed and
    # the host line off a 24-row terminal, and the feed is the part that proves
    # the panel is live.
    ui_row_stage_grid

    ui_box_mid

    # The current operation: the stage's own id and message, the operation's own
    # last line of output via the message, and its real elapsed time.
    local current="${UI_CURRENT_STAGE:-}"
    ui_row_reset
    if [ -n "$current" ]; then
        local dur dur_text message room
        dur="$(ui_fmt_duration "$(ui_stage_duration "$current")")"
        dur_text="$dur"
        message="${UI_STAGE_MSG[$current]:-}"
        room=$((UI_INNER - ${#current} - ${#dur_text} - 5))
        [ "$room" -lt 4 ] && room=4
        ui_row_add "$UI_S_RUN" "$(ui_glyph_run)"
        ui_row_add "$UI_S_RESET" " "
        ui_row_add "$UI_S_BOLD" "$current"
        ui_row_add "$UI_S_RESET" "  $(ui_truncate "$message" "$room")"
        ui_row_fill_to $((UI_INNER - ${#dur_text}))
        ui_row_add "$UI_S_DIM" "$dur_text"
    fi
    ui_row_end

    ui_row_reset
    if [ -n "$current" ]; then
        ui_row_bar "$current"
    fi
    ui_row_end

    ui_box_mid

    # The activity feed: real log lines, the same ones the log file holds.
    #
    # Three lines need a terminal with rows to spare. In the middle band one of
    # them is spent on the runtime facts row below instead — a 24-row SSH window
    # has no free row, and a frame that outgrows the screen scrolls, which moves
    # the text out from under the cursor the frame is anchored to and tears the
    # panel. Trading one log line for the Docker and Compose versions keeps the
    # frame exactly as tall as it has always been; the lines that lose are still
    # in the log file and still in the feed, just one scroll further back.
    local activity_lines=1
    if [ "$UI_ROWS" -ge 30 ]; then
        activity_lines=3
    elif [ "$UI_ROWS" -ge 22 ]; then
        activity_lines=2
    fi
    local from=$((${#UI_ACTIVITY[@]} - activity_lines))
    [ "$from" -lt 0 ] && from=0
    local i
    for ((i = 0; i < activity_lines; i++)); do
        ui_row_reset
        local line_index=$((from + i))
        if [ "$line_index" -lt "${#UI_ACTIVITY[@]}" ]; then
            ui_row_add "$UI_S_DIM" "$(ui_truncate "${UI_ACTIVITY[$line_index]}" "$UI_INNER")"
        fi
        ui_row_end
    done

    local facts runtime
    facts="$(ui_fact_line)"
    runtime="$(ui_runtime_line)"
    # The runtime row is dropped, not truncated, on a short terminal: the host
    # group above it holds the measurements every later decision was made against,
    # and this file does not print a fact it had to cut in half. The same
    # UI_ROWS threshold the activity feed uses decides it, so a terminal that
    # gets the full feed gets the runtime versions too.
    [ "$UI_ROWS" -lt 22 ] && runtime=""
    if [ -n "$facts" ] || [ -n "$runtime" ]; then
        ui_box_mid
        if [ -n "$facts" ]; then
            ui_row_reset
            ui_row_add "$UI_S_DIM" "$(ui_truncate "$facts" "$UI_INNER")"
            ui_row_end
        fi
        if [ -n "$runtime" ]; then
            ui_row_reset
            ui_row_add "$UI_S_DIM" "$(ui_truncate "$runtime" "$UI_INNER")"
            ui_row_end
        fi
    fi

    ui_box_bottom
}

# Redraw only when something actually changed. ui_run polls four times a second
# and most polls find the same state; writing an identical frame is pure terminal
# I/O, and on a 1 vCPU host that is CPU the image build wants.
ui_render_dashboard_if_changed() {
    [ "$UI_MODE" = "rich" ] || return 0
    # The run has ended and its final panel is drawn: a late log line still lands
    # in the file and the activity buffer, but the live dashboard is done and must
    # not be painted back over the success or error panel below it.
    [ "$UI_FINALIZED" = "true" ] && return 0
    # A prompt owns the terminal right now: record the state (the caller already
    # pushed the line into the activity feed) but do not draw over the prompt.
    [ "$UI_PANEL_HOLD" = "true" ] && return 0
    ui_render_dashboard
    [ "$UI_FRAME_TEXT" = "$UI_LAST_FRAME" ] && return 0
    UI_LAST_FRAME="$UI_FRAME_TEXT"
    ui_cursor_hide
    ui_frame_flush
}

# ---------------------------------------------------------------------------
# Panels
# ---------------------------------------------------------------------------
ui_banner() {
    [ "$UI_MODE" = "rich" ] || return 0

    # scripts/deploy/setup.sh draws the wordmark before it clones the repository,
    # which is the only way the one-liner can look deliberate during the download
    # rather than after it. That was seconds ago and a few lines up; drawing it
    # again here would read as a bug, so only the version goes out — the one part
    # setup.sh could not know.
    if [ "${AETHER_UI_BANNER_SHOWN:-false}" = "true" ]; then
        printf '%s  %s%s\n' "$UI_S_DIM" "$AETHER_VERSION" "$UI_S_RESET"
        return 0
    fi

    printf '\n%s%s  AETHER CLOUD OS%s %s%s%s\n' \
        "$UI_S_BOLD" "$UI_S_ACCENT" "$UI_S_RESET" "$UI_S_DIM" "$AETHER_VERSION" "$UI_S_RESET"
    printf '%s  %s%s\n' "$UI_S_DIM" "$(ui_rule)" "$UI_S_RESET"
}

# Where the install stands when it ends. Every line is a value the run actually
# produced; nothing here is a template with an assumed answer.
ui_success_panel() {
    local url="${1:-}"
    ui_panel_suspend
    ui_cursor_show
    UI_FINALIZED=true
    ui_stage_settle_waiting "not reached"

    [ "$UI_MODE" = "quiet" ] && return 0

    local elapsed
    elapsed="$(ui_fmt_duration "$(ui_elapsed_total)")"

    if [ "$UI_MODE" != "rich" ]; then
        printf '\nAether Cloud OS is installed.\n'
        [ -n "$url" ] && printf '  URL:   %s\n' "$url"
        printf '  Log:   %s\n' "$AETHER_LOG_FILE"
        [ -n "$elapsed" ] && printf '  Time:  %s\n' "$elapsed"
        return 0
    fi

    ui_frame_begin
    ui_box_top "$(ui_glyph_ok)  Aether Cloud OS is installed" "" "$UI_S_OK"
    ui_row_blank
    ui_row_stage_grid
    ui_box_mid
    [ -n "$url" ] && ui_row_field "Open" "$url"
    ui_row_field "Install" "$AETHER_INSTALL_DIR"
    ui_row_field "Log" "$AETHER_LOG_FILE"
    [ -n "$elapsed" ] && ui_row_field "Elapsed" "$elapsed"
    ui_box_bottom
    ui_frame_print
}

# The failure panel. It names the stage that failed, how long it had been
# running, the exit code, and the diagnostics that actually exist on this host —
# every command below is one the CLI really implements, and the log file is the
# one this run wrote.
ui_error_panel() {
    local stage="${1:-}" message="${2:-}" code="${3:-}"
    ui_panel_suspend
    ui_cursor_show
    UI_FINALIZED=true

    [ "$UI_MODE" = "quiet" ] && return 0

    if [ "$UI_MODE" != "rich" ]; then
        printf '\nInstallation failed: %s\n' "$message" >&2
        [ -n "$stage" ] && printf 'Stage: %s\n' "$stage" >&2
        [ -n "$code" ] && printf 'Exit code: %s\n' "$code" >&2
        printf 'Log: %s\n' "$AETHER_LOG_FILE" >&2
        return 0
    fi

    local dur
    dur="$(ui_fmt_duration "$(ui_stage_duration "$stage")")"

    ui_frame_begin
    ui_box_top "$(ui_glyph_fail)  Installation failed" "" "$UI_S_FAIL"
    ui_row_blank
    ui_row_field "Stage" "$stage"
    ui_row_field "Reason" "$message"
    [ -n "$code" ] && ui_row_field "Exit code" "$code"
    [ -n "$dur" ] && ui_row_field "Duration" "$dur"

    # The tail of what the failing command actually printed. These lines are
    # about to be lost with the run's temp file, so the panel is the last place
    # they can be shown; they were redacted on the way into the feed.
    local from=$((${#UI_ACTIVITY[@]} - 6))
    [ "$from" -lt 0 ] && from=0
    local i shown=0
    for ((i = from; i < ${#UI_ACTIVITY[@]}; i++)); do
        [ -n "${UI_ACTIVITY[$i]}" ] || continue
        [ "$shown" -eq 0 ] && ui_box_mid && ui_row_text "Last output" "$UI_S_BOLD"
        ui_row_text "  ${UI_ACTIVITY[$i]}" "$UI_S_DIM"
        shown=$((shown + 1))
    done
    UI_ACTIVITY=()

    ui_box_mid
    ui_row_text "State is preserved. Nothing was rolled back automatically." "$UI_S_BOLD"
    ui_row_blank
    ui_row_field "aether doctor" "diagnose the host" 24
    ui_row_field "aether logs backend" "backend container output" 24
    ui_row_field "aether status" "service and agent state" 24
    ui_row_text "tail -n 100 ${AETHER_LOG_FILE}" "$UI_S_ACCENT"
    ui_row_text "re-run with --resume to continue from the last completed stage" "$UI_S_DIM"
    ui_box_bottom
    ui_frame_print
}

ui_interrupt_panel() {
    local signal="${1:-INT}"
    ui_panel_suspend
    ui_cursor_show
    UI_FINALIZED=true

    [ "$UI_MODE" = "quiet" ] && return 0

    local stage="${UI_CURRENT_STAGE:-}"
    if [ "$UI_MODE" != "rich" ]; then
        printf '\nInterrupted (%s)' "$signal" >&2
        [ -n "$stage" ] && printf ' during %s' "$stage" >&2
        printf '. Nothing further was started.\n' >&2
        return 0
    fi

    ui_frame_begin
    ui_box_top "Interrupted $UI_G_SEP SIG${signal}" "" "$UI_S_FAIL"
    ui_row_blank
    if [ -n "$stage" ]; then
        ui_row_field "Stage" "$stage"
        local dur
        dur="$(ui_fmt_duration "$(ui_stage_duration "$stage")")"
        [ -n "$dur" ] && ui_row_field "Ran for" "$dur"
        ui_box_mid
    fi
    ui_row_text "The running command was stopped. Whatever it had already" "$UI_S_DIM"
    ui_row_text "finished is on disk and recorded as done, so --resume continues." "$UI_S_DIM"
    ui_box_bottom
    ui_frame_print
}

# ---------------------------------------------------------------------------
# Engine-facing API
# ---------------------------------------------------------------------------
ui_init() {
    ui_capability_detect
    AETHER_UI_STATE_FILE="${AETHER_UI_STATE_FILE:-${AETHER_STATE_DIR:-/tmp}/ui.state}"
    [ -n "${AETHER_LOG_FILE:-}" ] || AETHER_LOG_FILE=/tmp/aether-install.log
    UI_PANEL_DRAWN=0
    UI_LAST_FRAME=""
    UI_PANEL_HOLD=false
    UI_FINALIZED=false
    ui_state_reset
}

# Append one line to the log file in the same shape ui_write_log uses, and
# nothing on screen. fatal() calls this after a rich panel has already been torn
# down: sending the message through ui_write_log would push it into the activity
# feed and repaint the very panel that was just erased.
ui_log_line() {
    local level="$1" message="$2" ts
    [ -n "${AETHER_LOG_FILE:-}" ] || return 0
    ts=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
    printf '[%s] [%s] %s\n' "$ts" "$level" "$(ui_redact "$message")" \
        >>"$AETHER_LOG_FILE" 2>/dev/null || true
}

# Appends a command's captured output to the log file, redacted, under a header
# that names the operation it came from, so a failure can be read back later
# without guessing which build produced which lines.
ui_log_capture() {
    local file="$1" label="$2" ts
    [ -n "${AETHER_LOG_FILE:-}" ] || return 0
    [ -s "$file" ] || return 0
    ts=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
    printf '[%s] [OUTPUT] --- %s ---\n' "$ts" "$label" >>"$AETHER_LOG_FILE" 2>/dev/null || true
    ui_redact_stream <"$file" >>"$AETHER_LOG_FILE" 2>/dev/null || true
    return 0
}

# --- logging ---------------------------------------------------------------
# The single path for every message the engine produces. In every mode the line
# is appended to the log file in the same `[timestamp] [LEVEL] message` shape as
# before, so anything that reads it keeps working; what differs is the screen.
ui_write_log() {
    local level="$1" message="$2" ts line
    ts=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
    line="$(ui_redact "$message")"

    # One append, not `| tee`: tee is a second process per log line, and it
    # writes to stdout — the terminal the panel owns.
    if [ -n "${AETHER_LOG_FILE:-}" ]; then
        printf '[%s] [%s] %s\n' "$ts" "$level" "$line" >>"$AETHER_LOG_FILE" 2>/dev/null || true
    fi

    case "$UI_MODE" in
        quiet) return 0 ;;
        rich)
            ui_activity_push "$line"
            ui_render_dashboard_if_changed
            ;;
        *) printf '[%s] [%s] %s\n' "$ts" "$level" "$line" ;;
    esac
    return 0
}

# --- stages ----------------------------------------------------------------
ui_stage_begin_notify() {
    local id="$1" label="$2"
    # The install flow has resumed after any prompt, so the panel may draw again.
    UI_PANEL_HOLD=false
    ui_stage_label "$id" "$label"
    ui_stage_begin "$id"
    case "$UI_MODE" in
        quiet) return 0 ;;
        rich) ui_render_dashboard_if_changed ;;
        *) printf '\n%s== %s ==%s\n' "$UI_S_BOLD" "$label" "$UI_S_RESET" ;;
    esac
    return 0
}

ui_stage_done_notify() {
    ui_stage_complete "$1" "${2:-}"
    ui_render_dashboard_if_changed
}

ui_stage_failed_notify() {
    ui_stage_fail "$1" "$2" "${3:-}"
    ui_panel_suspend
}

ui_stage_skipped_notify() {
    ui_stage_skip "$1" "$2"
    ui_render_dashboard_if_changed
}

ui_note() {
    ui_stage_message "$1" "$2"
    ui_render_dashboard_if_changed
}

ui_progress() {
    ui_stage_progress "$1" "$2" "$3" "${4:-}"
    ui_render_dashboard_if_changed
}

# Drop a stage back to an indeterminate bar. Called when it moves from a phase
# that has a real denominator — a counted loop — into one that does not, a single
# long command. Without it the last N/M would linger and the RUNNING bar would
# sit near 100% for the whole of an operation that had barely started, which is
# the false "almost done" this file exists to avoid.
ui_progress_clear() {
    ui_stage_progress "$1" "" ""
    ui_render_dashboard_if_changed
}

# --- prompting -------------------------------------------------------------
# Hand the terminal back for a `read`. Lighter than ui_shutdown: it does not
# stop a running child or discard the run file, because a prompt is a pause in
# the same run, not the end of it. The panel is erased and the cursor is shown
# so the operator can see what they type; the next state change redraws the
# panel. In plain and quiet mode there is no panel and no hidden cursor, so this
# is a no-op and the prompt prints exactly as it did before.
ui_prompt_prepare() {
    [ "$UI_MODE" = "rich" ] || return 0
    ui_panel_suspend
    ui_cursor_show
    # Hold every subsequent repaint until a stage begins again: an installer that
    # prompts also logs, and a log line here would redraw the panel over the
    # prompt. ui_stage_begin_notify clears it when the install flow resumes.
    UI_PANEL_HOLD=true
    return 0
}

# --- running an operation --------------------------------------------------
# Runs a command that takes minutes and keeps the panel live while it does.
#
# In plain mode this is a pass-through with no redirection at all: a non-TTY
# caller sees byte-for-byte what it saw before this file existed, which is the
# property the compatibility requirement is really asking for. In quiet mode the
# output goes to the log file, because the operator asked for a silent terminal,
# not for the evidence to be thrown away.
#
# In rich mode the child is backgrounded with its output going to a file, so the
# parent remains the only writer to the terminal. The child's exit status is
# returned unchanged, and on a signal the child is killed before the parent
# unwinds — a backgrounded apt-get that outlives the installer is exactly the
# mess the interruption requirement is about.
#
# The `|| rc=$?` form is deliberate and not a style choice: under `set -e` a bare
# `"$@"` that fails would abort the shell here, so the status would never be
# returned and every caller's error handling would be dead code.
ui_run() {
    local label="$1"
    shift
    [ "$#" -gt 0 ] || return 0

    local stage="${UI_CURRENT_STAGE:-}"
    [ -n "$stage" ] && ui_stage_message "$stage" "$label"

    local rc=0
    case "$UI_MODE" in
        rich) ;;
        quiet)
            "$@" >>"${AETHER_LOG_FILE:-/dev/null}" 2>&1 || rc=$?
            return "$rc"
            ;;
        *)
            printf '%s  -> %s%s\n' "$UI_S_DIM" "$label" "$UI_S_RESET"
            "$@" || rc=$?
            return "$rc"
            ;;
    esac

    UI_RUN_FILE="${AETHER_STATE_DIR:-/tmp}/.ui-run.$$.log"
    : >"$UI_RUN_FILE" 2>/dev/null || UI_RUN_FILE=/dev/null

    "$@" >"$UI_RUN_FILE" 2>&1 </dev/null &
    UI_RUN_PID=$!

    local last_note="" line
    while kill -0 "$UI_RUN_PID" 2>/dev/null; do
        line="$(ui_tail_line "$UI_RUN_FILE")"
        if [ -n "$line" ] && [ "$line" != "$last_note" ]; then
            last_note="$line"
            [ -n "$stage" ] && ui_stage_message "$stage" "$line"
        fi
        ui_render_dashboard_if_changed
        sleep "$UI_POLL_INTERVAL"
    done

    wait "$UI_RUN_PID" || rc=$?
    UI_RUN_PID=""

    # Everything the command printed goes to the log file before the run file is
    # deleted. This is the step the previous comment here assumed already
    # happened — "the whole build log is in the log file" was not true: the rich
    # path sent the output to a temp file and then removed it, so an install kept
    # the panel's last few lines and lost the build output an operator is told to
    # go and read.
    ui_log_capture "$UI_RUN_FILE" "$label"

    # The last lines of a failed command are the part worth putting on screen, and
    # they are about to be discarded with the temp file, so they also go into the
    # activity feed. On success only the stage message keeps the command's own
    # last line: replaying a whole build log on the panel would bury it.
    if [ "$rc" -ne 0 ]; then
        while IFS= read -r line; do
            [ -n "$line" ] && ui_activity_push "$(ui_redact "$line")"
        done < <(ui_tail_lines "$UI_RUN_FILE" 6)
    fi

    rm -f "$UI_RUN_FILE" 2>/dev/null || true
    UI_RUN_FILE=""
    return "$rc"
}

# The last line of a command's output worth showing: not blank, with carriage
# returns treated as line breaks (docker build redraws one status line with \r)
# and escape sequences removed, since an unstripped sequence would corrupt the
# frame it is drawn into.
ui_tail_line() {
    local file="$1" text line result=""
    [ -f "$file" ] || return 0
    text=$(tail -c 8192 "$file" 2>/dev/null | tr '\r' '\n' | ui_strip_ansi)
    while IFS= read -r line; do
        [ -n "${line//[[:space:]]/}" ] && result="$line"
    done <<<"$text"
    printf '%s' "$result"
}

ui_tail_lines() {
    local file="$1" count="$2" text line
    [ -f "$file" ] || return 0
    text=$(tail -c 16384 "$file" 2>/dev/null | tr '\r' '\n' | ui_strip_ansi)
    local -a lines=()
    while IFS= read -r line; do
        [ -n "${line//[[:space:]]/}" ] && lines+=("$line")
    done <<<"$text"
    local from=$((${#lines[@]} - count))
    [ "$from" -lt 0 ] && from=0
    local i
    for ((i = from; i < ${#lines[@]}; i++)); do
        printf '%s\n' "${lines[$i]}"
    done
}

# --- teardown --------------------------------------------------------------
# Restores everything the rich renderer changed. Called from the EXIT trap, so a
# failure anywhere still leaves a usable terminal.
ui_shutdown() {
    if [ -n "${UI_RUN_PID:-}" ]; then
        kill -TERM "$UI_RUN_PID" 2>/dev/null || true
        wait "$UI_RUN_PID" 2>/dev/null || true
        UI_RUN_PID=""
    fi
    if [ -n "${UI_RUN_FILE:-}" ]; then
        rm -f "$UI_RUN_FILE" 2>/dev/null || true
    fi
    UI_RUN_FILE=""
    ui_cursor_show
    ui_panel_suspend
    return 0
}

# ---------------------------------------------------------------------------
# Interrupt handling
# ---------------------------------------------------------------------------
# Installed by install.sh as the INT and TERM trap. It stops the running child,
# names the stage that was interrupted, restores the cursor, and exits with the
# conventional status for the signal — a caller checking for 130 or 143 gets what
# it expects, and none of it depends on the terminal being intact, because the
# cursor is restored before anything else is printed.
ui_on_interrupt() {
    local signal="${1:-INT}"
    local stage="${UI_CURRENT_STAGE:-}"
    local code=130
    [ "$signal" = "TERM" ] && code=143

    if [ -n "${UI_RUN_PID:-}" ]; then
        kill -TERM "$UI_RUN_PID" 2>/dev/null || true
        wait "$UI_RUN_PID" 2>/dev/null || true
        UI_RUN_PID=""
    fi

    if [ -n "$stage" ]; then
        ui_stage_fail "$stage" "interrupted by SIG${signal}" "$code"
    fi

    ui_interrupt_panel "$signal"
    ui_shutdown

    # The EXIT trap still runs afterwards: it releases the install lock, which an
    # interrupt must not leave behind or the next install refuses to start.
    exit "$code"
}

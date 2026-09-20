#!/usr/bin/env bash
# Aether Cloud OS — installer stage state.
#
# The installer's deployment logic already reports what it is doing, but it
# reports it as free text on stdout: a line is printed, it scrolls away, and
# nothing downstream can tell a stage that finished from one that never ran.
# This file gives those stages a shape — an id, a status, a start time, a
# duration, a message, an exit code — so a renderer can show the real thing
# instead of guessing.
#
# It is a presentation-layer record only. Nothing here decides whether an
# operation runs: install.sh still keys resume on install.state and still calls
# the same functions in the same order. If every function in this file were
# replaced with a no-op the installer would behave identically, which is the
# property that keeps the UI from becoming a second source of truth.
#
# Two things are kept in step:
#
#   * in-memory arrays, which the renderer reads on every frame, and
#   * AETHER_UI_STATE_FILE, rewritten on every change, so a second process can
#     read the same state without IPC.
#
# Sourced by core.sh, never executed directly.

# Associative arrays need bash 4. Ubuntu 20.04 ships 5.x, and so does Git Bash,
# but a bash 3 host must degrade rather than misbehave: ui_supported says no and
# core.sh keeps its old line-based output.
if [ "${BASH_VERSINFO[0]:-0}" -ge 4 ] 2>/dev/null; then
    UI_STATE_SUPPORTED=true
else
    UI_STATE_SUPPORTED=false
fi

# The stage vocabulary in the order a full install reaches them. The ids are the
# spec's, the labels are what an operator reads, and the order is the order the
# panel draws them in — which is not the order install.sh calls them, because
# prepare_data_dirs runs inside deploy_application while the database and cache
# containers start after it.
UI_STAGE_ORDER=(
    PRECHECK
    DEPENDENCIES
    SOURCE
    CONFIGURATION
    STORAGE
    DATABASE
    REDIS
    BACKEND
    FRONTEND
    CADDY
    HOST_AGENT
    HEALTH_CHECK
    FINALIZATION
)

ui_stage_label_default() {
    case "$1" in
        PRECHECK) printf 'Preflight checks' ;;
        DEPENDENCIES) printf 'Dependencies' ;;
        SOURCE) printf 'Source tree' ;;
        CONFIGURATION) printf 'System configuration' ;;
        STORAGE) printf 'Storage layout' ;;
        DATABASE) printf 'PostgreSQL' ;;
        REDIS) printf 'Redis' ;;
        BACKEND) printf 'Backend' ;;
        FRONTEND) printf 'Frontend' ;;
        CADDY) printf 'Reverse proxy and TLS' ;;
        HOST_AGENT) printf 'Host agent' ;;
        HEALTH_CHECK) printf 'Health verification' ;;
        FINALIZATION) printf 'Finalization' ;;
        *) printf '%s' "$1" ;;
    esac
}

# ---------------------------------------------------------------------------
# In-memory state
# ---------------------------------------------------------------------------
ui_state_reset() {
    [ "$UI_STATE_SUPPORTED" = true ] || return 0

    # declare -A, not `VAR=()`. Assigning an empty compound to a name that has
    # never been declared makes it an *indexed* array, and an indexed array
    # evaluates its subscript as arithmetic — so `UI_STAGE_STATUS["PRECHECK"]`
    # expands the variable PRECHECK, which under `set -u` is a fatal unbound
    # variable rather than a bug you can see.
    declare -gA UI_STAGE_LABEL=()
    declare -gA UI_STAGE_STATUS=()
    declare -gA UI_STAGE_START=()
    declare -gA UI_STAGE_END=()
    declare -gA UI_STAGE_CUR=()
    declare -gA UI_STAGE_TOTAL=()
    declare -gA UI_STAGE_UNIT=()
    declare -gA UI_STAGE_MSG=()
    declare -gA UI_STAGE_ERR=()
    declare -gA UI_STAGE_CODE=()
    declare -gA UI_STAGE_NOTE=()

    local id
    for id in "${UI_STAGE_ORDER[@]}"; do
        UI_STAGE_LABEL["$id"]="$(ui_stage_label_default "$id")"
        UI_STAGE_STATUS["$id"]="WAITING"
        UI_STAGE_START["$id"]=""
        UI_STAGE_END["$id"]=""
        UI_STAGE_CUR["$id"]=""
        UI_STAGE_TOTAL["$id"]=""
        UI_STAGE_UNIT["$id"]=""
        UI_STAGE_MSG["$id"]=""
        UI_STAGE_ERR["$id"]=""
        UI_STAGE_CODE["$id"]=""
        UI_STAGE_NOTE["$id"]=""
    done

    UI_CURRENT_STAGE=""
    UI_FIRST_STAGE_AT=""
    ui_state_flush
}

# ---------------------------------------------------------------------------
# Writes
# ---------------------------------------------------------------------------
# A stage's own label can be overridden — "Source tree" reads better as
# "Fetching source" once the operation itself is known — and a note records the
# honest reason a stage was skipped rather than leaving a blank.
ui_stage_label() {
    [ "$UI_STATE_SUPPORTED" = true ] || return 0
    local id="$1" label="$2"
    UI_STAGE_LABEL["$id"]="$label"
    ui_state_flush
}

ui_stage_begin() {
    [ "$UI_STATE_SUPPORTED" = true ] || return 0
    local id="$1" msg="${2:-}"
    # A stage that spans two functions is opened by the first and reopened by the
    # second — CADDY is opened by deploy_application before the Caddyfile exists,
    # then reopened by wait_for_service when the proxy is probed. Restarting the
    # clock on that second open reports only the last slice of the stage: a real
    # install drew "CADDY 5s" for a stage the operator had been watching for
    # eighteen minutes, because the five seconds were the caddy health check
    # alone. The first open is when the stage's work began, so it stands.
    #
    # Only a stage already RUNNING keeps its clock. A stage reopened after it
    # finished — a resumed run, a retry — is a new pass and gets a new start,
    # which is what makes its duration describe the pass that is running.
    if [ "${UI_STAGE_STATUS[$id]:-}" != "RUNNING" ] || [ -z "${UI_STAGE_START[$id]:-}" ]; then
        UI_STAGE_START["$id"]="$(date +%s)"
    fi
    UI_STAGE_STATUS["$id"]="RUNNING"
    UI_STAGE_END["$id"]=""
    UI_STAGE_ERR["$id"]=""
    UI_STAGE_CODE["$id"]=""
    # Progress is cleared on entry, never inherited. A stage that begins twice —
    # a resumed run, or a stage reopened around a second operation — would
    # otherwise draw the previous pass's counter as its own, which is a number
    # about work that already finished.
    UI_STAGE_CUR["$id"]=""
    UI_STAGE_TOTAL["$id"]=""
    [ -n "$msg" ] && UI_STAGE_MSG["$id"]="$msg"
    UI_CURRENT_STAGE="$id"
    [ -n "$UI_FIRST_STAGE_AT" ] || UI_FIRST_STAGE_AT="$(date +%s)"
    ui_state_flush
}

# Free text describing what is happening right now inside the stage. Called from
# the engine at the points where an operator would otherwise see nothing for
# minutes; it never invents a number.
ui_stage_message() {
    [ "$UI_STATE_SUPPORTED" = true ] || return 0
    local id="$1" msg="$2"
    UI_STAGE_MSG["$id"]="$msg"
    ui_state_flush
}

# Progress is only ever called where a real denominator exists: the Nth package
# of a known list, the Nth attempt of a bounded probe loop, the Nth container of
# a fixed set. There is no branch here that fabricates a total, and no stage
# without a total renders a percentage.
ui_stage_progress() {
    [ "$UI_STATE_SUPPORTED" = true ] || return 0
    local id="$1" cur="$2" total="$3" unit="${4:-}"
    UI_STAGE_CUR["$id"]="$cur"
    UI_STAGE_TOTAL["$id"]="$total"
    [ -n "$unit" ] && UI_STAGE_UNIT["$id"]="$unit"
    ui_state_flush
}

ui_stage_complete() {
    [ "$UI_STATE_SUPPORTED" = true ] || return 0
    local id="$1" msg="${2:-}"
    UI_STAGE_STATUS["$id"]="SUCCESS"
    UI_STAGE_END["$id"]="$(date +%s)"
    UI_STAGE_CUR["$id"]=""
    UI_STAGE_TOTAL["$id"]=""
    [ -n "$msg" ] && UI_STAGE_MSG["$id"]="$msg"
    ui_stage_clear_current "$id"
    ui_state_flush
}

ui_stage_fail() {
    [ "$UI_STATE_SUPPORTED" = true ] || return 0
    local id="$1" msg="$2" code="${3:-}"
    UI_STAGE_STATUS["$id"]="FAILED"
    UI_STAGE_END["$id"]="$(date +%s)"
    UI_STAGE_ERR["$id"]="$msg"
    UI_STAGE_CODE["$id"]="$code"
    ui_stage_clear_current "$id"
    ui_state_flush
}

ui_stage_skip() {
    [ "$UI_STATE_SUPPORTED" = true ] || return 0
    local id="$1" reason="$2"
    # A stage that already succeeded is not downgraded: on a resumed install the
    # skip is the same fact as the earlier success, and losing the SUCCESS would
    # hide that the work really was done.
    [ "${UI_STAGE_STATUS[$id]:-}" = "SUCCESS" ] && return 0
    UI_STAGE_STATUS["$id"]="SKIPPED"
    UI_STAGE_NOTE["$id"]="$reason"
    UI_STAGE_END["$id"]="$(date +%s)"
    ui_stage_clear_current "$id"
    ui_state_flush
}

ui_stage_clear_current() {
    [ "${UI_CURRENT_STAGE:-}" = "$1" ] && UI_CURRENT_STAGE=""
    return 0
}

ui_stage_skip_range() {
    [ "$UI_STATE_SUPPORTED" = true ] || return 0
    local reason="$1" id
    shift
    for id in "$@"; do
        ui_stage_skip "$id" "$reason"
    done
}

# Any stage still WAITING when the run ends did not happen. Marking them is how
# the panel avoids the lie of a stage that looks pending forever: at the end of
# a run, WAITING must not exist.
ui_stage_settle_waiting() {
    [ "$UI_STATE_SUPPORTED" = true ] || return 0
    local reason="${1:-not reached}" id
    for id in "${UI_STAGE_ORDER[@]}"; do
        [ "${UI_STAGE_STATUS[$id]:-}" = "WAITING" ] || continue
        UI_STAGE_STATUS["$id"]="SKIPPED"
        UI_STAGE_NOTE["$id"]="$reason"
    done
    ui_state_flush
}

# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------
ui_stage_status() {
    [ "$UI_STATE_SUPPORTED" = true ] || return 0
    printf '%s' "${UI_STAGE_STATUS[$1]:-}"
}

# Integer seconds a stage took: the completed duration once it is done, the
# running duration while it is still going, and empty for a stage that has not
# started. Never a guess.
ui_stage_duration() {
    [ "$UI_STATE_SUPPORTED" = true ] || return 0
    local id="$1" start end
    start="${UI_STAGE_START[$id]:-}"
    [ -n "$start" ] || return 0
    end="${UI_STAGE_END[$id]:-}"
    [ -n "$end" ] || end="$(date +%s)"
    printf '%s' "$((end - start))"
}

ui_stage_ids() {
    [ "$UI_STATE_SUPPORTED" = true ] || return 0
    printf '%s\n' "${UI_STAGE_ORDER[@]}"
}

ui_elapsed_total() {
    [ "$UI_STATE_SUPPORTED" = true ] || return 0
    [ -n "$UI_FIRST_STAGE_AT" ] || return 0
    printf '%s' "$(( $(date +%s) - UI_FIRST_STAGE_AT ))"
}

# ---------------------------------------------------------------------------
# File mirror
# ---------------------------------------------------------------------------
# One line per stage, pipe-delimited, fields in a fixed order. Rewritten whole
# rather than edited in place: thirteen short lines are cheaper to write than to
# seek into, and a partial rewrite can never leave a half-updated record.
ui_state_flush() {
    [ "$UI_STATE_SUPPORTED" = true ] || return 0
    local file="${AETHER_UI_STATE_FILE:-}"
    [ -n "$file" ] || return 0

    local dir="${file%/*}"
    [ -d "$dir" ] || mkdir -p "$dir" 2>/dev/null || return 0

    local tmp="$file.tmp.$$" id
    local label status start end cur total unit msg err code note
    {
        printf 'VERSION|1\n'
        printf 'CURRENT|%s\n' "$UI_CURRENT_STAGE"
        printf 'FIRST_AT|%s\n' "$UI_FIRST_STAGE_AT"
        for id in "${UI_STAGE_ORDER[@]}"; do
            label="${UI_STAGE_LABEL[$id]:-}"
            status="${UI_STAGE_STATUS[$id]:-}"
            start="${UI_STAGE_START[$id]:-}"
            end="${UI_STAGE_END[$id]:-}"
            cur="${UI_STAGE_CUR[$id]:-}"
            total="${UI_STAGE_TOTAL[$id]:-}"
            unit="${UI_STAGE_UNIT[$id]:-}"
            msg="${UI_STAGE_MSG[$id]:-}"
            err="${UI_STAGE_ERR[$id]:-}"
            code="${UI_STAGE_CODE[$id]:-}"
            note="${UI_STAGE_NOTE[$id]:-}"

            # The delimiter is the field separator, so a value containing one
            # would shift every field after it; line breaks would too, since the
            # format is line-oriented. Sanitising by parameter expansion keeps
            # this fork-free — `$(ui_field_safe ...)` here was seventy-eight
            # subshells per frame, which on a 1 vCPU host is the difference
            # between a live panel and a stuttering one.
            label="${label//|//}"; label="${label//$'\n'/ }"; label="${label//$'\r'/ }"
            unit="${unit//|//}"; unit="${unit//$'\n'/ }"; unit="${unit//$'\r'/ }"
            msg="${msg//|//}"; msg="${msg//$'\n'/ }"; msg="${msg//$'\r'/ }"
            err="${err//|//}"; err="${err//$'\n'/ }"; err="${err//$'\r'/ }"
            code="${code//|//}"; code="${code//$'\n'/ }"; code="${code//$'\r'/ }"
            note="${note//|//}"; note="${note//$'\n'/ }"; note="${note//$'\r'/ }"

            printf 'STAGE|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\n' \
                "$id" "$label" "$status" "$start" "$end" \
                "$cur" "$total" "$unit" "$msg" "$err" "$code" "$note"
        done
    } >"$tmp" 2>/dev/null || {
        rm -f "$tmp"
        return 0
    }
    mv -f "$tmp" "$file" 2>/dev/null || rm -f "$tmp"
    return 0
}

# The delimiter is the field separator, so a message containing one would shift
# every field after it. Line breaks would too — the format is line-oriented.
ui_state_reset

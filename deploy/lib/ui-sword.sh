#!/usr/bin/env bash
# Aether Cloud OS — installer sword finale and per-command intros.
#
# Presentation only. Sourced by core.sh right after ui.sh; nothing here decides
# whether an operation runs. If every function were a no-op the installer would
# behave identically.
#
# The art is the "Thousand Demon Daggers" katana (魔刀千刃, Scissor Seven): a slim
# silver blade, black wrapped grip, blue detailing. It STANDS — grip at the top,
# blade pointing down — and every glyph is a Block Element or box-drawing
# character exactly one cell wide, so the shape is perfectly symmetric about a
# single centre column and never drifts. No emoji, ever.
#
# Two things matter and are guaranteed by construction:
#   * the blade shape is fixed and centred, so it can never look crooked; the
#     "Thousand Demon Daggers" motion radiates daggers SYMMETRICALLY around a
#     blade that itself does not move, and
#   * each frame is drawn as one full clear-and-print, so two half-frames are
#     never on screen at once ("double-double" is impossible), and the frame
#     builder is fork-free so it does not stutter on a 1 vCPU host.

# ---------------------------------------------------------------------------
# Capability probe — independent of ui_init, because the CLI never calls it.
# ---------------------------------------------------------------------------
_ui_sword_caps() {
    SWORD_TTY=false;   [ -t 1 ] && SWORD_TTY=true
    SWORD_QUIET=false; [ "${AETHER_UI_QUIET:-false}" = "true" ] && SWORD_QUIET=true

    local term="${TERM:-}"
    SWORD_UNICODE=false
    case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
        *UTF-8* | *UTF8* | *utf-8* | *utf8*) SWORD_UNICODE=true ;;
    esac

    SWORD_COLOR=false
    if [ "$SWORD_TTY" = true ] && [ -n "$term" ] && [ "$term" != dumb ] &&
        [ -z "${NO_COLOR:-}" ]; then
        SWORD_COLOR=true
    fi

    # Motion needs a real terminal and has to be opt-out-able. AETHER_NO_INTRO
    # silences the per-command flourish without disabling the installer's panel.
    SWORD_ANIM=false
    if [ "$SWORD_TTY" = true ] && [ "$SWORD_QUIET" != true ] &&
        [ -n "$term" ] && [ "$term" != dumb ] &&
        [ "${AETHER_UI_ANIMATION:-true}" != false ]; then
        SWORD_ANIM=true
    fi

    if [ "$SWORD_COLOR" = true ]; then
        S_RST=$'\033[0m'; S_B=$'\033[1m'; S_D=$'\033[2m'
        S_AC=$'\033[38;5;39m'; S_OK=$'\033[38;5;35m'
        SG=( $'\033[38;5;33m' $'\033[38;5;39m' $'\033[38;5;45m' $'\033[38;5;51m' $'\033[38;5;87m' )
    else
        S_RST=""; S_B=""; S_D=""; S_AC=""; S_OK=""
        SG=( "" "" "" "" "" )
    fi
}

# ---------------------------------------------------------------------------
# The art. Both faces are the same 16 rows, each exactly 7 cells wide and
# centred on column 3, so the two never disagree about geometry and the
# animation can index blade rows the same way in either.
#   0     pommel        4-5   guard
#   1-3   wrapped grip  6-14  blade + shoulder + neck   15  point
# ---------------------------------------------------------------------------
UI_SWORD_U=(
    "  ╭─╮  " "  │╳│  " "  │╳│  " "  │╳│  " " ╭┴─┴╮ " " ╰─┬─╯ "
    "  ▒█▒  " "  ▒█▒  " "  ▒█▒  " "  ▒█▒  " "  ▒█▒  " "  ▒█▒  " "  ▒█▒  "
    "  ▝█▘  " "   █   " "   ▀   "
)
UI_SWORD_A=(
    "  +-+  " "  |X|  " "  |X|  " "  |X|  " " /+-+\\ " " \\_+_/ "
    "  |#|  " "  |#|  " "  |#|  " "  |#|  " "  |#|  " "  |#|  " "  |#|  "
    "  \\#/  " "   #   " "   v   "
)
SWORD_CELL=7
SWORD_BLADE_LO=6
SWORD_BLADE_HI=14

# Per-row colour: the grip reads as dark wrapped leather, the guard as steel,
# and the blade runs the blue→cyan gradient brightest at its heart.
_ui_sword_row_colour() {
    local idx="$1"
    if [ "$idx" -le 3 ]; then
        printf '%s' "$S_D"
    elif [ "$idx" -le 5 ]; then
        printf '%s%s' "$S_B" "$S_AC"
    else
        local g=$(( (idx - SWORD_BLADE_LO) % 5 ))
        printf '%s' "${SG[$g]}"
    fi
}

# ---------------------------------------------------------------------------
# The "Thousand Demon Daggers" motion. The blade never moves — daggers radiate
# from it in mirrored pairs that fan outward and are drawn back, so it can never
# look crooked. Runs in the alt-screen so nothing lands in scrollback; each frame
# is one clear-and-print and the builder is fork-free, so it neither tears nor
# stutters. Bounded: a fixed 21-frame programme at ~60 ms, well under 1.5 s.
# ---------------------------------------------------------------------------
_ui_sword_animate() {
    local -a art
    if [ "$SWORD_UNICODE" = true ]; then art=( "${UI_SWORD_U[@]}" ); else art=( "${UI_SWORD_A[@]}" ); fi
    local lg rg og
    if [ "$SWORD_UNICODE" = true ]; then lg='╱'; rg='╲'; og='·'; else lg='/'; rg='\'; og='.'; fi

    local CANVAS_W=31 MARGIN=12 CENTER=15
    local termw="${UI_WIDTH:-80}" termh="${UI_ROWS:-24}"
    local leftpad=$(( (termw - CANVAS_W) / 2 )); [ "$leftpad" -lt 0 ] && leftpad=0
    local toppad=$(( (termh - ${#art[@]} - 2) / 2 )); [ "$toppad" -lt 0 ] && toppad=0
    local lpad; printf -v lpad '%*s' "$leftpad" ''

    local -a prog=(0 1 2 3 4 5 6 7 8 8 8 7 6 5 4 3 2 1 0 0 0)
    local -a flashp=(0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 1 0)

    printf '\033[?1049h\033[?25l'
    UI_SWORD_ABORT=0
    trap 'UI_SWORD_ABORT=1' INT
    local fidx r flash i row buf pos d g colour t
    for fidx in "${!prog[@]}"; do
        [ "$UI_SWORD_ABORT" -eq 1 ] && break
        r="${prog[$fidx]}"; flash="${flashp[$fidx]}"
        buf=""
        for ((t = 0; t < toppad; t++)); do buf+=$'\n'; done
        for i in "${!art[@]}"; do
            printf -v row '%*s%s' "$MARGIN" '' "${art[$i]}"
            printf -v row '%-*s' "$CANVAS_W" "$row"
            if [ "$i" -ge "$SWORD_BLADE_LO" ] && [ "$i" -le "$SWORD_BLADE_HI" ] && [ "$r" -gt 0 ]; then
                for ((d = 1; d <= r; d++)); do
                    [ "$d" -eq "$r" ] && g="$og" || g="$lg"
                    pos=$((CENTER - 2 - d)); [ "$pos" -ge 0 ] && row="${row:0:pos}$g${row:$((pos + 1))}"
                    [ "$d" -eq "$r" ] && g="$og" || g="$rg"
                    pos=$((CENTER + 2 + d)); row="${row:0:pos}$g${row:$((pos + 1))}"
                done
            fi
            if [ "$flash" -eq 1 ] && [ "$i" -ge "$SWORD_BLADE_LO" ]; then colour="$S_B${SG[4]}"
            elif [ "$i" -le 3 ]; then colour="$S_D"
            elif [ "$i" -le 5 ]; then colour="$S_B$S_AC"
            else colour="${SG[$(((i - SWORD_BLADE_LO) % 5))]}"; fi
            buf+="${lpad}${colour}${row}${S_RST}"$'\n'
        done
        printf '\033[H\033[J%s' "$buf"
        sleep 0.06
    done
    trap - INT
    printf '\033[?1049l\033[?25h'
}

# ---------------------------------------------------------------------------
# The install-completion finale: the standing katana at the left, the master
# data (Domain / User / Password) set beside its blade on the right. Prints to
# the normal screen so it persists in scrollback. Reads the master credentials
# from the globals the installer already holds; when there is no master account
# (a resumed run that created none) it shows the access details alone.
# ---------------------------------------------------------------------------
ui_sword_finale() {
    _ui_sword_caps
    [ "$SWORD_QUIET" = true ] && return 0

    local url="${1:-}"
    local user="${AETHER_MASTER_USERNAME:-}"
    local pass="${AETHER_MASTER_PASSWORD:-}"
    local dir="${AETHER_INSTALL_DIR:-}"
    local dlabel="Access"; [ -n "${AETHER_DOMAIN:-}" ] && dlabel="Domain"
    local elapsed=""
    if declare -F ui_fmt_duration >/dev/null 2>&1 && declare -F ui_elapsed_total >/dev/null 2>&1; then
        elapsed="$(ui_fmt_duration "$(ui_elapsed_total)")"
    fi

    [ "$SWORD_ANIM" = true ] && _ui_sword_animate

    local -a art
    if [ "$SWORD_UNICODE" = true ]; then art=( "${UI_SWORD_U[@]}" ); else art=( "${UI_SWORD_A[@]}" ); fi

    # Right-hand content, one slot per sword row, so the fields sit beside the
    # blade rather than above it. "NOTE|" marks the dim reminder line.
    local -a right=( "" "" "" "" "" "" "" "" "" "" "" "" "" "" "" "" )
    if [ -n "$user" ] && [ -n "$pass" ]; then
        right[6]="${dlabel}|${url}"
        right[8]="User|${user}"
        right[10]="Password|${pass}"
        right[12]="Install|${dir}"
        [ -n "$elapsed" ] && right[13]="Elapsed|${elapsed}"
        right[15]="NOTE|Save these now — the password is shown only this once."
        AETHER_CREDENTIALS_ON_SCREEN=1
    else
        right[7]="${dlabel}|${url}"
        right[9]="Install|${dir}"
        [ -n "$elapsed" ] && right[10]="Elapsed|${elapsed}"
    fi

    printf '\n  %s%sAETHER IS ONLINE%s\n\n' "$S_B" "$S_OK" "$S_RST"
    local i entry lab val colour rtxt
    for i in "${!art[@]}"; do
        entry="${right[$i]}"
        rtxt=""
        if [ -n "$entry" ]; then
            lab="${entry%%|*}"; val="${entry#*|}"
            if [ "$lab" = "NOTE" ]; then
                rtxt="${S_D}${val}${S_RST}"
            else
                printf -v rtxt '%s%-10s%s%s' "$S_B" "$lab" "$S_RST" "${val:0:52}"
            fi
        fi
        colour="$(_ui_sword_row_colour "$i")"
        printf '  %s%s%s    %s\n' "$colour" "${art[$i]}" "$S_RST" "$rtxt"
    done
    printf '\n'
}

# ---------------------------------------------------------------------------
# Per-command intro. A short, themed sweep drawn INLINE on a single line: each
# frame is one carriage-return redraw with clear-to-end-of-line, so nothing
# stacks up and "double-double" is structurally impossible; the line is fully
# erased before the real command output prints, so no residue lands in
# scrollback and `aether status | grep` (a non-TTY) sees nothing at all. Each
# command gets its own motif, label, and accent so the CLI reads as one tool.
# Bounded: ≤17 frames at ~35 ms, well under a second. No forks in the loop.
# ---------------------------------------------------------------------------
ui_cmd_anim() {
    local cmd="${1:-}"
    _ui_sword_caps
    [ "$SWORD_ANIM" = true ] || return 0
    [ "${AETHER_NO_INTRO:-0}" = "1" ] && return 0

    local label motif glyph accent
    case "$cmd" in
        status)  label="STATUS";  motif=sweep;    glyph='◆'; accent="${SG[2]}" ;;
        logs)    label="LOGS";    motif=stream;   glyph='◆'; accent="${SG[1]}" ;;
        update)  label="UPDATE";  motif=spark;    glyph='▲'; accent="${SG[4]}" ;;
        backup)  label="BACKUP";  motif=fill;     glyph='█'; accent="${SG[0]}" ;;
        restore) label="RESTORE"; motif=assemble; glyph='█'; accent="${SG[3]}" ;;
        restart) label="RESTART"; motif=cycle;    glyph='◆'; accent="${SG[2]}" ;;
        doctor)  label="DOCTOR";  motif=pulse;    glyph='•'; accent="${SG[1]}" ;;
        *)       return 0 ;;
    esac

    local base spin
    if [ "$SWORD_UNICODE" = true ]; then
        base='·'; spin='◐◓◑◒'
    else
        base='.'; spin='|/-\'
        case "$glyph" in ◆) glyph='*' ;; ▲) glyph='^' ;; •) glyph='o' ;; █) glyph='#' ;; esac
    fi

    local W=16 step=0.035 FN
    case "$motif" in
        fill | assemble) FN=$((W + 1)) ;;
        pulse) FN=12 ;;
        *) FN=$W ;;
    esac

    printf '\033[?25l'
    UI_SWORD_ABORT=0
    trap 'UI_SWORD_ABORT=1' INT
    local f c line sc si sg
    for ((f = 0; f < FN; f++)); do
        [ "$UI_SWORD_ABORT" -eq 1 ] && break
        line=""
        case "$motif" in
            sweep)
                for ((c = 0; c < W; c++)); do [ "$c" -eq "$f" ] && line+="$glyph" || line+="$base"; done ;;
            spark)
                for ((c = 0; c < W; c++)); do
                    if [ "$c" -eq "$f" ] || [ "$c" -eq $((f - 1)) ]; then line+="$glyph"; else line+="$base"; fi
                done ;;
            stream)
                for ((c = 0; c < W; c++)); do
                    if [ "$c" -ge $((f - 1)) ] && [ "$c" -le $((f + 1)) ]; then line+="$glyph"; else line+="$base"; fi
                done ;;
            fill)
                for ((c = 0; c < W; c++)); do [ "$c" -lt "$f" ] && line+="$glyph" || line+="$base"; done ;;
            assemble)
                for ((c = 0; c < W; c++)); do [ "$c" -ge $((W - f)) ] && line+="$glyph" || line+="$base"; done ;;
            cycle)
                for ((c = 0; c < W; c++)); do line+="$base"; done
                sc=$((W / 2)); si=$((f % 4)); sg="${spin:si:1}"
                line="${line:0:sc}${sg}${line:$((sc + 1))}" ;;
            pulse)
                for ((c = 0; c < W; c++)); do line+="$glyph"; done ;;
        esac
        if [ "$motif" = pulse ] && [ $((f % 2)) -eq 1 ]; then
            printf '\r  %s%-8s%s %s%s%s%s\033[K' "$S_B" "$label" "$S_RST" "$S_D" "$accent" "$line" "$S_RST"
        else
            printf '\r  %s%-8s%s %s%s%s\033[K' "$S_B" "$label" "$S_RST" "$accent" "$line" "$S_RST"
        fi
        sleep "$step"
    done
    trap - INT
    # Erase the intro line completely so the real command output starts clean.
    printf '\r\033[K\033[?25h'
}

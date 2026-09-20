#!/usr/bin/env bash
# Aether Cloud OS — installer orchestrator.
#
# Entry point invoked by /install.sh at the repo root (curl | bash, or a
# checkout). Runs the five stages in order, checkpointing each so an
# interrupted install resumes instead of redoing finished work.
#
# Environment overrides (all optional):
#   AETHER_INSTALL_DIR   where to install            (default /opt/aether)
#   AETHER_DOMAIN        domain for TLS + routing    (prompted if unset)
#   AETHER_ADMIN_EMAIL   Let's Encrypt notices       (prompted if unset)
#   AETHER_VERSION       version stamp               (default 0.1.0)
#   AETHER_YES           "true" = non-interactive, accept defaults
#   AETHER_FORCE_BUILD   "true" = rebuild the frontend bundle
#   AETHER_RESUME        "true" = skip stages already marked done
#   AETHER_APT_LOCK_TIMEOUT  seconds apt waits for a held dpkg lock (default 900)
#   AETHER_NO_SWAP       "true" = never create a swapfile on a low-memory host
#   AETHER_SKIP_APT_PREPARE  "true" = do not pause boot-time apt jobs

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=./core.sh
source "$SCRIPT_DIR/core.sh"
# shellcheck source=./utils.sh
source "$SCRIPT_DIR/utils.sh"
# shellcheck source=./secrets.sh
source "$SCRIPT_DIR/secrets.sh"
# shellcheck source=./preflight.sh
source "$SCRIPT_DIR/preflight.sh"
# shellcheck source=./dependencies.sh
source "$SCRIPT_DIR/dependencies.sh"
# shellcheck source=./configure.sh
source "$SCRIPT_DIR/configure.sh"
# shellcheck source=./deploy.sh
source "$SCRIPT_DIR/deploy.sh"
# shellcheck source=./finalize.sh
source "$SCRIPT_DIR/finalize.sh"
# shellcheck source=./interactive-setup.sh
source "$SCRIPT_DIR/interactive-setup.sh"
# shellcheck source=./create-master-user.sh
source "$SCRIPT_DIR/create-master-user.sh"

usage() {
    cat <<EOF
Aether Cloud OS installer

Usage: install.sh [options]

Options:
  --domain DOMAIN        public domain pointing at this host
  --email  EMAIL         admin email for certificate notices
  --dir    PATH          installation directory (default /opt/aether)
  --yes                  non-interactive; accept defaults
  --resume               skip stages already completed in this directory
  --dry-run              validate everything but make no changes to the system
  --no-https              serve HTTP only (domain remains optional)
  --full-host-access     the host agent manages the WHOLE filesystem as root, so
                         every file on the VPS shows in Files and Terminal (this
                         is the default). Anyone who logs in as owner can then
                         read and write the entire disk through the GUI.
  --no-full-host-access  confine the host agent to its workspace directory and
                         run it unprivileged (Files shows only the workspace)
  --quiet                no progress on screen; write only to the log file
  --verbose              stream every command's output instead of the live panel
  --no-animation         draw the panel without the spinner or timed repaint
  --version              show installer version
  --help                 show this message

Environment: see the header comment in $(basename "$0").
EOF
}

parse_args() {
    local dir_overridden=false

    while [ $# -gt 0 ]; do
        case "$1" in
            --domain) AETHER_DOMAIN="$2"; shift 2 ;;
            --email) AETHER_ADMIN_EMAIL="$2"; shift 2 ;;
            --dir) AETHER_INSTALL_DIR="$2"; dir_overridden=true; shift 2 ;;
            --yes) AETHER_YES=true; shift ;;
            --resume) AETHER_RESUME=true; shift ;;
            --dry-run) AETHER_DRY_RUN=true; shift ;;
            --no-https) AETHER_NO_HTTPS=true; shift ;;
            --full-host-access) AETHER_FULL_HOST_ACCESS=true; AETHER_FULL_HOST_ACCESS_EXPLICIT=true; shift ;;
            --no-full-host-access) AETHER_FULL_HOST_ACCESS=false; AETHER_FULL_HOST_ACCESS_EXPLICIT=true; shift ;;
            --quiet) AETHER_UI_QUIET=true; shift ;;
            --verbose) AETHER_UI_VERBOSE=true; shift ;;
            --no-animation) AETHER_UI_ANIMATION=false; shift ;;
            --version) printf '%s\n' "$AETHER_VERSION"; exit 0 ;;
            --help) usage; exit 0 ;;
            *) printf 'Unknown option: %s\n\n' "$1" >&2; usage; exit 2 ;;
        esac
    done

    # core.sh derived the secrets directory from the default install root before
    # --dir was parsed. Move it with the root, unless the caller set it
    # explicitly, so a --dir install keeps its secrets under --dir.
    if [ "$dir_overridden" = true ] && [ "${AETHER_SECRETS_DIR_DEFAULTED:-false}" = "true" ]; then
        AETHER_SECRETS_DIR="$AETHER_INSTALL_DIR/secrets"
    fi

    export AETHER_DOMAIN="${AETHER_DOMAIN:-}" AETHER_ADMIN_EMAIL="${AETHER_ADMIN_EMAIL:-}" \
        AETHER_YES="${AETHER_YES:-false}" AETHER_RESUME="${AETHER_RESUME:-false}" \
        AETHER_DRY_RUN="${AETHER_DRY_RUN:-false}" \
        AETHER_NO_HTTPS="${AETHER_NO_HTTPS:-false}" \
        AETHER_FULL_HOST_ACCESS="${AETHER_FULL_HOST_ACCESS:-true}" \
        AETHER_FULL_HOST_ACCESS_EXPLICIT="${AETHER_FULL_HOST_ACCESS_EXPLICIT:-}" \
        AETHER_UI_QUIET="${AETHER_UI_QUIET:-}" AETHER_UI_VERBOSE="${AETHER_UI_VERBOSE:-}" \
        AETHER_UI_ANIMATION="${AETHER_UI_ANIMATION:-}" \
        AETHER_INSTALL_DIR AETHER_SECRETS_DIR
}

run_stage() {
    local key="$1"; shift
    if [ "${AETHER_RESUME:-false}" = "true" ] && state_done "$key"; then
        info "Skipping completed stage: $key"
        return
    fi
    "$@"
    mark_done "$key"
}

# Puts back the configuration a resumed run no longer derives.
#
# A resumed run does not re-run configure — its checkpoint says done — and
# configure is the only place that turns the operator's answers into
# AETHER_DOMAIN / AETHER_ADMIN_EMAIL / AETHER_NO_HTTPS. Everything downstream
# still needs them: write_caddyfile picks HTTPS or IP-only from AETHER_DOMAIN,
# installation_url builds the health check's URL from it, and `docker compose`
# interpolates `{$AETHER_DOMAIN}` in the Caddyfile from the environment before it
# ever looks at .env — so the empty string parse_args exports is not a fallback
# to the recorded value, it overrides it and leaves the site block with no
# address at all.
#
# Read from .env, as the update path does (scripts/update.sh) and for the same
# reason, and only where the caller left a blank: --domain and --email still win.
# A blank that is genuinely recorded stays blank, because an IP-only install
# records an empty domain and inventing one here would turn it into an ACME
# install against a name that may not resolve.
load_recorded_settings() {
    [ "${AETHER_RESUME:-false}" = "true" ] || return 0

    local env_file="$AETHER_INSTALL_DIR/.env"
    if [ ! -f "$env_file" ]; then
        return 0
    fi

    if [ -z "${AETHER_DOMAIN:-}" ]; then
        AETHER_DOMAIN="$(env_value AETHER_DOMAIN "$env_file" || true)"
    fi
    if [ -z "${AETHER_ADMIN_EMAIL:-}" ]; then
        AETHER_ADMIN_EMAIL="$(env_value AETHER_ADMIN_EMAIL "$env_file" || true)"
    fi
    # There is no --https flag, so "true" is the only way to have said this
    # explicitly: --no-https and AETHER_NO_HTTPS=true stand, and anything else
    # defers to the recorded choice. Without this a resumed HTTP-only install
    # would silently promote itself to ACME on a domain it was told not to use.
    if [ "${AETHER_NO_HTTPS:-false}" != "true" ]; then
        AETHER_NO_HTTPS="$(env_value AETHER_NO_HTTPS "$env_file" || true)"
        AETHER_NO_HTTPS="${AETHER_NO_HTTPS:-false}"
    fi

    export AETHER_DOMAIN AETHER_ADMIN_EMAIL AETHER_NO_HTTPS

    if [ -n "$AETHER_DOMAIN" ]; then
        info "Resuming with the recorded domain: $AETHER_DOMAIN"
    fi
}

# Runs on every exit. Its first duty is the one the installer always had —
# release the lock so the next run can start. Its second, only when the rich UI
# is active, is to guarantee a failed run ends with the error panel and a
# restored terminal, even when the failure was a bare `set -e` abort deep in a
# library that never reached fatal(). A run that already drew a panel — the
# success panel, a fatal(), or an interrupt — set UI_FINALIZED, and is left
# exactly as it was. Rich mode implies bash 4, so the stage arrays this reads are
# real associative arrays; in plain and quiet mode fatal() already printed the
# reason and this branch is skipped.
on_exit() {
    local rc=$?
    if [ "${AETHER_UI_AVAILABLE:-false}" = "true" ] && [ "${UI_MODE:-plain}" = "rich" ] &&
        [ "$rc" -ne 0 ] && [ "${UI_FINALIZED:-false}" != "true" ]; then
        local stage="${UI_CURRENT_STAGE:-}" msg="${AETHER_FATAL_MESSAGE:-}"
        if [ -z "$msg" ] && [ -n "$stage" ]; then
            msg="${UI_STAGE_MSG[$stage]:-}"
        fi
        [ -n "$msg" ] || msg="the installer exited before finishing (code $rc)"
        [ -n "$stage" ] && ui_stage_fail "$stage" "$msg" "$rc"
        ui_error_panel "$stage" "$msg" "$rc"
        ui_shutdown
    fi
    release_lock

    # This trap's status becomes the installer's. Every statement above is
    # written to succeed, and this line keeps it that way if one of them ever
    # stops being: an EXIT trap that fails turns a run that finished correctly
    # into exit 1 (bash 5.2; the E2E harness caught exactly that in
    # scripts/deploy/setup.sh). It cannot mask a real failure — a trap that
    # succeeds leaves the failing run's own status untouched.
    return 0
}

main() {
    parse_args "$@"

    # Unique id for this run, shown in errors and stored in instance.json so
    # support can correlate a failure with the exact log file.
    AETHER_INSTALLATION_ID="$(date +%Y%m%d-%H%M)-$(openssl rand -hex 4 2>/dev/null || echo 00000000)"
    export AETHER_INSTALLATION_ID

    mkdir -p "$(dirname "$AETHER_LOG_FILE")"
    touch "$AETHER_LOG_FILE"
    chmod 600 "$AETHER_LOG_FILE" 2>/dev/null || true

    # Bring the presentation layer up before anything is logged: it detects the
    # terminal's capabilities, resets the stage registry, and points the state
    # mirror at the install directory. When the UI files are absent (an older
    # installation's lib directory) this is a no-op and the installer keeps its
    # original line output.
    if [ "${AETHER_UI_AVAILABLE:-false}" = "true" ]; then
        ui_init
        ui_banner
    fi

    acquire_lock
    # on_exit both releases the lock and, in rich mode, renders the failure panel
    # for an unhandled abort. The INT and TERM traps hand off to the UI's own
    # interrupt handler, which stops any running child, marks the stage, restores
    # the terminal, and exits 130/143 — after which this EXIT trap still runs and
    # releases the lock, so a Ctrl+C never strands one behind.
    trap on_exit EXIT
    if [ "${AETHER_UI_AVAILABLE:-false}" = "true" ]; then
        trap 'ui_on_interrupt INT' INT
        trap 'ui_on_interrupt TERM' TERM
    fi

    info "Aether Cloud OS install ${AETHER_VERSION} (id ${AETHER_INSTALLATION_ID})"
    info "Install dir: ${AETHER_INSTALL_DIR} | Log: ${AETHER_LOG_FILE}"

    # Reconnect to the terminal for the interactive prompts. Invoked through
    # `curl … | bash`, this process inherits the download pipe as stdin, so
    # `[ -t 0 ]` is false and prompt_domain / prompt_master_account would be
    # skipped without asking anything — the installer would silently deploy with
    # no domain and no admin account. The controlling terminal is still reachable
    # at /dev/tty, so point stdin at it. If opening /dev/tty fails — a CI runner,
    # a detached service, a genuinely headless boot — stdin is left as-is and the
    # prompts fall back to non-interactive defaults. This is safe because this
    # script is read from a file, not from stdin, so moving stdin cannot truncate
    # it. --yes opts out entirely.
    if [ ! -t 0 ] && [ "${AETHER_YES:-false}" != "true" ]; then
        if { exec 3</dev/tty; } 2>/dev/null; then
            exec <&3 3<&-
            info "Connected to the terminal for interactive setup."
        else
            info "No terminal available; interactive prompts will be skipped."
        fi
    fi

    if [ "${AETHER_DRY_RUN:-false}" = "true" ]; then
        info "=== DRY RUN MODE — no changes will be made ==="
        run_preflight
        prompt_for_settings
        info "Dry run complete. Everything above would be executed on a real install."
        info "Install dir: $AETHER_INSTALL_DIR | Domain: $AETHER_DOMAIN | Email: $AETHER_ADMIN_EMAIL"
        # A dry run exits cleanly, so the EXIT trap's failure path never runs;
        # restore the terminal here so a rich preflight panel does not stay drawn.
        if [ "${AETHER_UI_AVAILABLE:-false}" = "true" ]; then
            ui_shutdown
        fi
        exit 0
    fi

    # The stage total covers configure through finalize; preflight and
    # dependencies already called stage() themselves.
    run_stage preflight run_preflight

    # Hand the terminal back before the conversational part of the install. In
    # rich mode this erases the live panel and holds further repaints, so the
    # domain, email and master-account prompts — and the existing-install prompt
    # below — print cleanly and do not race a background log line. The next stage
    # (dependencies) redraws the panel. In every other mode this is a no-op.
    if [ "${AETHER_UI_AVAILABLE:-false}" = "true" ]; then
        ui_prompt_prepare
    fi

    # Interactive setup: prompt for domain (with DNS validation) and master account
    # This runs BEFORE dependencies installation so user knows what will be configured
    if [ "${AETHER_RESUME:-false}" != "true" ] || ! state_done "interactive_setup"; then
        run_interactive_setup
        mark_done "interactive_setup"
    fi

    # Handle existing installation: offer resume / reinstall / abort.
    if [ -n "${EXISTING_STATE:-}" ] && [ "${AETHER_RESUME:-false}" != "true" ]; then
        warn "An existing Aether installation was found at $AETHER_INSTALL_DIR"
        if [ -t 0 ]; then
            printf 'Resume the previous install? [Y/n]: '
            read -r answer || answer=""
            case "$answer" in
                ""|[Yy]*) AETHER_RESUME=true ;;
                *)
                    fatal "Aborted. To reinstall from scratch, remove $AETHER_INSTALL_DIR first, or pass --resume."
                    ;;
            esac
        else
            info "Non-interactive: resuming existing installation automatically."
            AETHER_RESUME=true
        fi
        export AETHER_RESUME
    fi

    # After the decision above, so it covers both --resume and the automatic
    # resume a non-interactive run makes on its own, and before the stages, so
    # everything downstream sees the recorded configuration.
    load_recorded_settings

    run_stage dependencies install_dependencies
    run_stage configure configure_system
    run_stage deploy deploy_application
    run_stage finalize finalize_installation

    state_set status completed

    # The success panel is drawn only now — after finalize_installation, which
    # includes the health verification. It is the WOW moment the spec asks for,
    # and it is never shown before the run actually finished. It also tears the
    # live panel down and restores the cursor, so print_summary's credentials and
    # next-steps block prints normally beneath it. print_summary keeps the
    # one-time master password on screen; it is deliberately not redacted.
    if [ "${AETHER_UI_AVAILABLE:-false}" = "true" ]; then
        ui_success_panel "$(installation_url 2>/dev/null || true)"
    fi

    print_summary
    info "Installation complete."
}

if [ "$0" = "${BASH_SOURCE:-$0}" ]; then
    main "$@"
fi

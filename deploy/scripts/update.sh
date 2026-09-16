#!/usr/bin/env bash
# Aether Cloud OS — update.
#
# Takes an installed instance to the latest source, rebuilding and restarting it
# in place. Named volumes (database, workspace, uploads) are never touched by a
# normal update — only `uninstall --purge` removes them.
#
# The previous version of this script was inoperable. It ran `git pull` in the
# install *root* (the source lives in `<install>/src`, so there is no repository
# there), built the frontend from `<install>/packages/frontend` (that path does
# not exist), and restarted `aether-backend`/`aether-host-agent` systemd units
# (the unit is named `aether`). Under `set -e` it died at the first of those, so
# `aether update` had never worked. Everything below operates on the layout the
# installer actually creates.
#
# Options:
#   --check     report whether an update is available, then exit
#   --no-pull   rebuild from the current source without fetching
#   --yes       do not prompt

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AETHER_INSTALL_DIR="${AETHER_INSTALL_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"

# shellcheck source=../lib/core.sh
source "$SCRIPT_DIR/../lib/core.sh"
# shellcheck source=../lib/utils.sh
source "$SCRIPT_DIR/../lib/utils.sh"

AETHER_SRC_DIR="$AETHER_INSTALL_DIR/src"
AETHER_STATIC_DIR="$AETHER_INSTALL_DIR/static"
COMPOSE_FILE="$AETHER_INSTALL_DIR/docker-compose.yml"

AETHER_CHECK_ONLY=false
AETHER_PULL=true

for arg in "$@"; do
    case "$arg" in
        --check) AETHER_CHECK_ONLY=true ;;
        --no-pull) AETHER_PULL=false ;;
        --yes) AETHER_YES=true ;;
        -h | --help)
            printf 'Usage: %s [--check] [--no-pull] [--yes]\n' "$0"
            exit 0
            ;;
        *) fatal "Unknown update option: $arg" ;;
    esac
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
compose() {
    compose_cmd -f "$COMPOSE_FILE" "$@"
}

require_deployment() {
    [ -f "$COMPOSE_FILE" ] || fatal "No deployment found at $AETHER_INSTALL_DIR (missing docker-compose.yml)."
    [ -d "$AETHER_SRC_DIR" ] || fatal "No source tree at $AETHER_SRC_DIR."
    command_exists docker || fatal "docker is not installed."
}

current_revision() {
    if [ -d "$AETHER_SRC_DIR/.git" ]; then
        git -C "$AETHER_SRC_DIR" rev-parse --short HEAD 2>/dev/null || printf 'unknown'
    else
        # Installed from a local rsync rather than a clone; there is no revision
        # to report and no upstream to pull from.
        printf 'local-copy'
    fi
}

# ---------------------------------------------------------------------------
# Steps
# ---------------------------------------------------------------------------

sync_source() {
    if [ -d "$AETHER_SRC_DIR/.git" ]; then
        command_exists git || fatal "git is required to update a git-based install."
        info "Fetching the latest source"
        git -C "$AETHER_SRC_DIR" fetch --depth 1 origin
        local branch
        branch=$(git -C "$AETHER_SRC_DIR" rev-parse --abbrev-ref HEAD)
        # --ff-only on purpose: a deployed instance must never end up in a
        # conflicted merge state with nobody around to resolve it.
        git -C "$AETHER_SRC_DIR" merge --ff-only "origin/$branch"
        info "Source updated to $(git -C "$AETHER_SRC_DIR" rev-parse --short HEAD)"
        return 0
    fi

    if [ -n "${AETHER_REPO_DIR:-}" ] && [ -d "$AETHER_REPO_DIR" ] && [ "$AETHER_REPO_DIR" != "$AETHER_INSTALL_DIR" ]; then
        info "Re-syncing source from $AETHER_REPO_DIR"
        if command_exists rsync; then
            rsync -a --delete \
                --exclude node_modules --exclude .git --exclude dist \
                --exclude '*.log' \
                "$AETHER_REPO_DIR/" "$AETHER_SRC_DIR/"
        else
            (cd "$AETHER_REPO_DIR" && tar cf - --exclude=node_modules --exclude=.git --exclude=dist .) \
                | (cd "$AETHER_SRC_DIR" && tar xf -)
        fi
        return 0
    fi

    warn "Source is neither a git checkout nor backed by a repo directory; rebuilding as-is."
}

# Rebuilds the frontend bundle into <install>/static, which the backend image
# serves. The build runs in a container, so the host needs no Node toolchain.
build_frontend() {
    stage "Rebuilding the frontend bundle"
    mkdir -p "$AETHER_STATIC_DIR"

    cat > "$AETHER_SRC_DIR/docker-compose.frontend.yml" <<'COMPOSE_EOF'
name: aether-frontend-build
services:
  frontend-build:
    build:
      context: .
      dockerfile: packages/frontend/Dockerfile
      target: builder
    entrypoint: ["sh", "-c", "rm -rf /out/* && cp -r /build/packages/frontend/dist/. /out/"]
    volumes:
      - ../static:/out
COMPOSE_EOF

    compose_cmd -f "$AETHER_SRC_DIR/docker-compose.frontend.yml" run --rm --build frontend-build
    [ -f "$AETHER_STATIC_DIR/index.html" ] || fatal "Frontend build produced no bundle at $AETHER_STATIC_DIR"
    info "Frontend bundle refreshed"
}

rebuild_backend() {
    stage "Rebuilding the backend image"
    compose build --pull backend
}

restart_stack() {
    stage "Restarting the stack"
    compose up -d
}

health_check() {
    info "Waiting for the backend to report healthy"

    local attempts=60
    while [ "$attempts" -gt 0 ]; do
        if compose exec -T backend node -e \
            "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
            >/dev/null 2>&1; then
            info "Backend is healthy"
            return 0
        fi
        attempts=$((attempts - 1))
        sleep 3
    done

    warn "The backend did not report healthy within 3 minutes."
    warn "Inspect the logs with:  aether logs backend"
    warn "Roll back with:         aether rollback <archive>"
    warn "The backup taken before this update is in $AETHER_INSTALL_DIR/backups/"
    return 1
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
update_aether() {
    require_deployment

    local before
    before=$(current_revision)
    info "Current revision: $before"

    if [ "$AETHER_CHECK_ONLY" = true ]; then
        if [ -d "$AETHER_SRC_DIR/.git" ]; then
            git -C "$AETHER_SRC_DIR" fetch --quiet --depth 1 origin
            local remote
            remote=$(git -C "$AETHER_SRC_DIR" rev-parse --short FETCH_HEAD)
            if [ "$before" = "$remote" ]; then
                info "Up to date ($before)"
            else
                info "Update available: $before → $remote"
            fi
        else
            info "Not a git checkout; use --no-pull to rebuild the current source."
        fi
        return 0
    fi

    # Back up before touching anything. This is a real backup — database
    # included — and it is what makes `aether rollback` possible.
    stage "Backing up before the update"
    AETHER_INSTALL_DIR="$AETHER_INSTALL_DIR" bash "$SCRIPT_DIR/backup.sh"

    if [ "$AETHER_PULL" = true ]; then
        stage "Updating source"
        sync_source
    fi

    build_frontend
    rebuild_backend
    restart_stack

    if health_check; then
        printf '\n'
        info "Update complete: $before → $(current_revision)"
        printf '\n'
    else
        fatal "Update finished but the backend is not healthy. See the rollback instructions above."
    fi
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    update_aether
fi

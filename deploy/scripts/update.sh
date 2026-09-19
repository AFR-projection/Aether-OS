#!/usr/bin/env bash
# Aether Cloud OS — update.
#
# Takes an installed instance to the latest source: compares the checkout with
# `origin/main`, takes a full backup, fast-forwards, rebuilds, migrates,
# restarts, and health-checks. Any failure rolls the instance back to the
# commit and archive it started from.
#
# Nothing here pushes to a remote. The update is pull-only.
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
COMPOSE_FILE="$AETHER_INSTALL_DIR/docker-compose.yml"
AETHER_BACKUP_DIR="${AETHER_BACKUP_DIR:-$AETHER_INSTALL_DIR/backups}"
AETHER_UPDATE_LOCK="${AETHER_UPDATE_LOCK:-$AETHER_INSTALL_DIR/state/update.lock}"
AETHER_UPDATE_BRANCH="${AETHER_UPDATE_BRANCH:-main}"
LAST_UPDATE_RECORD="$AETHER_BACKUP_DIR/last-update.json"

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

compose() {
    compose_cmd -f "$COMPOSE_FILE" "$@"
}

require_deployment() {
    [ -f "$COMPOSE_FILE" ] || fatal "No deployment found at $AETHER_INSTALL_DIR (missing docker-compose.yml)."
    [ -d "$AETHER_SRC_DIR" ] || fatal "No source tree at $AETHER_SRC_DIR."
    command_exists docker || fatal "docker is not installed."
}

# --- Concurrency -----------------------------------------------------------

acquire_update_lock() {
    mkdir -p "$(dirname "$AETHER_UPDATE_LOCK")"
    if [ -f "$AETHER_UPDATE_LOCK" ]; then
        local pid
        pid=$(cat "$AETHER_UPDATE_LOCK" 2>/dev/null || true)
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            fatal "Another update is running (PID $pid). Wait for it, or remove $AETHER_UPDATE_LOCK if it is stale."
        fi
        warn "Removing a stale update lock."
        rm -f "$AETHER_UPDATE_LOCK"
    fi
    echo $$ > "$AETHER_UPDATE_LOCK"
}

release_update_lock() {
    rm -f "$AETHER_UPDATE_LOCK"
}

# --- Git -------------------------------------------------------------------

is_git_checkout() {
    [ -d "$AETHER_SRC_DIR/.git" ]
}

current_revision() {
    if is_git_checkout; then
        git -C "$AETHER_SRC_DIR" rev-parse HEAD 2>/dev/null || printf 'unknown'
    else
        printf 'local-copy'
    fi
}

current_revision_short() {
    if is_git_checkout; then
        git -C "$AETHER_SRC_DIR" rev-parse --short HEAD 2>/dev/null || printf 'unknown'
    else
        printf 'local-copy'
    fi
}

current_branch() {
    if is_git_checkout; then
        git -C "$AETHER_SRC_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || printf 'unknown'
    else
        printf 'local-copy'
    fi
}

# Refuses to update a tree with uncommitted work. A deployed instance should
# never be in that state, and silently discarding local edits would destroy
# whatever someone was debugging at 2am.
#
# Only *tracked* changes count. Untracked files here are build leftovers copied
# in by the source sync, and refusing over one would block updates forever for a
# file nobody edited. They are not a safety hole either: if an untracked file
# would be overwritten, git refuses the fast-forward itself and the update aborts
# before anything moves.
require_clean_tree() {
    is_git_checkout || return 0
    local dirty
    dirty=$(git -C "$AETHER_SRC_DIR" status --porcelain --untracked-files=no 2>/dev/null || true)
    [ -z "$dirty" ] && return 0
    error "The source tree has local modifications:"
    printf '%s\n' "$dirty" | sed 's/^/    /' >&2
    fatal "Refusing to update. Commit or discard them in $AETHER_SRC_DIR first."
}

# Fetches origin/<branch> in a way that leaves ancestry intact.
#
# A `--depth 1` fetch onto the installer's shallow clone leaves the local HEAD
# and the fetched commit as two independent grafted roots with no shared
# ancestor. Git then reports "refusing to merge unrelated histories" and blocks
# even a legitimate fast-forward. Deepening the history (--unshallow on a shallow
# repo) makes the real parent chain visible so the fast-forward succeeds.
fetch_origin() {
    local branch="$1"
    command_exists git || fatal "git is required to update a git-based install."
    local git_dir
    git_dir=$(git -C "$AETHER_SRC_DIR" rev-parse --git-dir 2>/dev/null || echo "$AETHER_SRC_DIR/.git")
    if [ -f "$git_dir/shallow" ]; then
        git -C "$AETHER_SRC_DIR" fetch --quiet --unshallow origin "$branch" 2>/dev/null \
            || git -C "$AETHER_SRC_DIR" fetch --quiet origin "$branch"
    else
        git -C "$AETHER_SRC_DIR" fetch --quiet origin "$branch"
    fi
}

# Compares with origin/<branch> and prints the decision: "same" or "ahead".
fetch_and_compare() {
    local branch="$1"
    fetch_origin "$branch"
    local local_rev remote_rev
    local_rev=$(git -C "$AETHER_SRC_DIR" rev-parse HEAD)
    remote_rev=$(git -C "$AETHER_SRC_DIR" rev-parse FETCH_HEAD)

    if [ "$local_rev" = "$remote_rev" ]; then
        printf 'same'
    else
        printf 'ahead'
    fi
}

fast_forward() {
    local branch="$1"
    # --ff-only first: a deployed instance must never end up in a conflicted
    # merge state with nobody around to resolve it.
    if git -C "$AETHER_SRC_DIR" merge --ff-only FETCH_HEAD 2>/dev/null; then
        info "Source is now at $(current_revision_short)"
        return 0
    fi
    # The fast-forward was refused. On a deploy target this is not a real
    # divergence to preserve: require_clean_tree already proved there is no
    # uncommitted tracked work to lose, and the tree only ever tracks
    # origin/<branch>. The usual cause is a shallow clone whose graft boundary
    # hides the shared ancestor. Resetting hard to the fetched revision is the
    # correct non-interactive resolution — the deployment mirrors origin exactly.
    warn "Fast-forward was refused (diverged or shallow history); resetting the deployment to origin/$branch."
    git -C "$AETHER_SRC_DIR" reset --hard FETCH_HEAD \
        || fatal "Could not align the source tree with origin/$branch. Resolve it manually in $AETHER_SRC_DIR."
    info "Source is now at $(current_revision_short)"
}

reset_to_revision() {
    local revision="$1"
    is_git_checkout || return 0
    [ -n "$revision" ] && [ "$revision" != "local-copy" ] || return 0
    git -C "$AETHER_SRC_DIR" reset --hard "$revision" >/dev/null 2>&1 \
        || warn "Could not reset the source tree back to $revision."
}

sync_from_repo_dir() {
    # The rsync below uses --delete, so a wrong AETHER_REPO_DIR would not merely
    # fail — it would replace the source tree with whatever that directory
    # happens to hold. Require the directory to actually look like the
    # repository before pointing anything destructive at it.
    if [ -n "${AETHER_REPO_DIR:-}" ] &&
        [ -f "$AETHER_REPO_DIR/package.json" ] &&
        [ -f "$AETHER_REPO_DIR/deploy/lib/install.sh" ] &&
        [ "$AETHER_REPO_DIR" != "$AETHER_INSTALL_DIR" ]; then
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

# --- Build and migrate -----------------------------------------------------

build_frontend() {
    stage "Rebuilding the frontend bundle"
    # Built into ./static.new and swapped in only once complete, so a failed
    # build cannot take the running instance's frontend away. Shared with the
    # installer and `aether restore` via utils.sh.
    install_frontend_bundle \
        || fatal "The frontend bundle could not be rebuilt. The instance is still on the previous version."
}

rebuild_backend() {
    stage "Rebuilding the backend image"
    compose build --pull backend
}

# Migrations are forward-only and checksummed, and the container also runs them
# at boot. Doing it explicitly makes a failed migration a failed *update* —
# caught here, before the health check, with the old archive still on disk.
run_migrations() {
    stage "Applying database migrations"
    compose run --rm --no-deps --entrypoint node backend dist/scripts/migrate.js \
        || fatal "Migrations failed. The instance is still on the previous version."
    info "Database schema is up to date"
}

restart_stack() {
    stage "Restarting the stack"
    compose up -d
}

# --- Health ----------------------------------------------------------------

# Full health check: the backend answering, its database reachable, and the
# local host agent reconnected. A backend that answers while the agent is down
# is a half-working instance, so it counts as failure.
#
# "Connected" is read from both ends: the backend logged that it accepted this
# agent id, and the agent's own journal logged that it saw the acknowledgement.
# Either one alone can be true of a socket that is already dead.
health_check() {
    info "Waiting for the stack to report healthy"

    local attempts=60
    while [ "$attempts" -gt 0 ]; do
        if compose exec -T backend node -e \
            "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
            >/dev/null 2>&1; then
            break
        fi
        attempts=$((attempts - 1))
        sleep 3
    done

    if [ "$attempts" -eq 0 ]; then
        warn "The backend did not report healthy within 3 minutes."
        return 1
    fi
    info "Backend is healthy"

    local body
    body=$(compose exec -T backend node -e \
        "fetch('http://127.0.0.1:3000/api/health').then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>process.exit(1))" \
        2>/dev/null || true)
    case "$body" in
        *'"database":{"ok":true'*) info "Database is reachable" ;;
        *)
            warn "The readiness probe does not report a healthy database."
            return 1
            ;;
    esac

    verify_local_agent
}

verify_local_agent() {
    [ -f "$AETHER_INSTALL_DIR/local-agent.json" ] || return 0

    local agent_id
    agent_id=$(sed -n 's/.*"agentId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
        "$AETHER_INSTALL_DIR/local-agent.json" | head -n1)
    if [ -z "$agent_id" ]; then
        warn "local-agent.json has no agentId; skipping the agent check."
        return 0
    fi

    info "Waiting for the host agent to reconnect"

    local agent_attempts=20
    while [ "$agent_attempts" -gt 0 ]; do
        if compose logs --since 5m backend 2>/dev/null \
            | grep -q "\"agentId\":\"$agent_id\".*agent connected" \
            && $SUDO journalctl -u aether-host-agent --since "-5min" --no-pager 2>/dev/null \
                | grep -q "paired with backend"; then
            info "Host agent is connected (confirmed on both sides)"
            return 0
        fi
        agent_attempts=$((agent_attempts - 1))
        sleep 3
    done

    warn "The host agent is not confirmed connected after the update."
    warn "  backend: aether logs --tail 50 backend"
    warn "  agent:   sudo journalctl -u aether-host-agent -n 50 --no-pager"
    return 1
}

# --- Rollback --------------------------------------------------------------

write_update_record() {
    local prev_revision="$1" prev_short="$2" archive="$3"
    mkdir -p "$AETHER_BACKUP_DIR"
    cat > "$LAST_UPDATE_RECORD" <<EOF
{"previousRevision":"$prev_revision","previousShort":"$prev_short","archive":"$archive","attemptedAt":"$(date -u '+%Y-%m-%dT%H:%M:%SZ')"}
EOF
}

write_deployment_metadata() {
    local revision="$1" branch="$2"
    local metadata_file="$AETHER_INSTALL_DIR/deployment.json"
    mkdir -p "$(dirname "$metadata_file")"
    cat > "$metadata_file" <<EOF
{
  "revision": "$revision",
  "revisionShort": "$(git -C "$AETHER_SRC_DIR" rev-parse --short HEAD 2>/dev/null || echo "$revision")",
  "branch": "$branch",
  "deployedAt": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "deploymentMethod": "aether-update",
  "instanceId": "$(sed -n 's/.*"installationId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$AETHER_INSTALL_DIR/instance.json" 2>/dev/null | head -n1)"
}
EOF
    info "Deployment metadata written to $metadata_file"
}

roll_back() {
    local prev_revision="$1" prev_short="$2" archive="$3"

    warn "Update failed. Rolling back to $prev_short."

    reset_to_revision "$prev_revision"

    if [ -n "$archive" ] && [ -f "$archive" ]; then
        stage "Restoring the pre-update backup"
        if AETHER_INSTALL_DIR="$AETHER_INSTALL_DIR" AETHER_YES=true bash "$SCRIPT_DIR/restore.sh" "$archive"; then
            info "Rollback successful — running the previous version ($prev_short)."
        else
            error "Rollback could not restore the backup automatically."
            error "Run it by hand:  aether restore $archive"
            return 1
        fi
    else
        warn "No pre-update archive was available; the source tree was reverted only."
        warn "Rebuild and restart to finish:  aether repair"
    fi
    return 0
}

# --- Entry point -----------------------------------------------------------

update_aether() {
    require_deployment

    local before before_short
    before=$(current_revision)
    before_short=$(current_revision_short)
    info "Current revision: $before_short (branch $(current_branch))"

    if [ "$AETHER_CHECK_ONLY" = true ]; then
        if is_git_checkout; then
            local decision
            decision=$(fetch_and_compare "$AETHER_UPDATE_BRANCH")
            if [ "$decision" = "same" ]; then
                info "Already up to date ($before_short)"
            else
                info "Update available: $before_short → $(git -C "$AETHER_SRC_DIR" rev-parse --short FETCH_HEAD)"
            fi
        else
            info "Not a git checkout; use --no-pull to rebuild the current source."
        fi
        return 0
    fi

    acquire_update_lock
    trap 'release_update_lock' EXIT

    if [ "$AETHER_PULL" = true ] && is_git_checkout; then
        require_clean_tree

        stage "Checking for updates"
        local decision
        decision=$(fetch_and_compare "$AETHER_UPDATE_BRANCH")
        if [ "$decision" = "same" ]; then
            info "Already up to date ($before_short)"
            return 0
        fi
        info "Update available: $before_short → $(git -C "$AETHER_SRC_DIR" rev-parse --short FETCH_HEAD)"
    fi

    # Back up before touching anything. This is a real backup — database
    # included — and it is what makes the rollback below possible.
    stage "Backing up before the update"
    local archive
    archive=$(AETHER_INSTALL_DIR="$AETHER_INSTALL_DIR" bash "$SCRIPT_DIR/backup.sh" 2>&1 \
        | grep -oE "$AETHER_BACKUP_DIR/aether-backup-[0-9]{8}-[0-9]{6}\.tar\.gz" | tail -n1 || true)
    [ -n "$archive" ] && [ -f "$archive" ] \
        || fatal "The pre-update backup did not produce an archive. Aborting before any change."
    info "Pre-update backup: $archive"

    write_update_record "$before" "$before_short" "$archive"

    if [ "$AETHER_PULL" = true ]; then
        if is_git_checkout; then
            stage "Updating source"
            fast_forward "$AETHER_UPDATE_BRANCH"
        else
            stage "Syncing source"
            sync_from_repo_dir
        fi
    fi

    # Regenerate compose file after source update to ensure build context and
    # mounts match the new source tree structure. Critical: without this, the
    # update builds from stale configuration and may silently run old code.
    stage "Regenerating configuration"
    if [ -f "$AETHER_SRC_DIR/deploy/lib/deploy.sh" ]; then
        # Load this instance's domain settings before regenerating the
        # Caddyfile. write_caddyfile picks HTTPS when AETHER_DOMAIN is non-empty
        # and HTTP otherwise, so an unset domain here rewrites an ACME
        # deployment's Caddyfile to the HTTP-only template on :80 — a silent
        # downgrade to plain HTTP that the update's own health check cannot see,
        # because it probes the container rather than through Caddy.
        AETHER_DOMAIN="$(env_value AETHER_DOMAIN "$AETHER_INSTALL_DIR/.env" || true)"
        AETHER_ADMIN_EMAIL="$(env_value AETHER_ADMIN_EMAIL "$AETHER_INSTALL_DIR/.env" || true)"
        AETHER_NO_HTTPS="$(env_value AETHER_NO_HTTPS "$AETHER_INSTALL_DIR/.env" || true)"
        AETHER_NO_HTTPS="${AETHER_NO_HTTPS:-false}"

        # The preview range is read back for the same reason: it decides both the
        # published ports in the compose file and the site blocks in the
        # Caddyfile, and regenerating them from a default while .env holds a
        # different range would leave the backend serving previews on addresses
        # Docker never forwards.
        AETHER_PREVIEW_ENABLED="$(env_value AETHER_PREVIEW_ENABLED "$AETHER_INSTALL_DIR/.env" || true)"
        AETHER_PREVIEW_PORT_START="$(env_value AETHER_PREVIEW_PORT_START "$AETHER_INSTALL_DIR/.env" || true)"
        AETHER_PREVIEW_PORT_COUNT="$(env_value AETHER_PREVIEW_PORT_COUNT "$AETHER_INSTALL_DIR/.env" || true)"

        # Defaulted rather than left empty, because an install made before
        # previews existed has none of these keys and an empty range is not a
        # range: the port arithmetic would fail and the update would stop before
        # it wrote anything. The defaults are the ones the shipped compose file
        # and utils.sh already agree on.
        AETHER_PREVIEW_ENABLED="${AETHER_PREVIEW_ENABLED:-true}"
        AETHER_PREVIEW_PORT_START="${AETHER_PREVIEW_PORT_START:-8443}"
        AETHER_PREVIEW_PORT_COUNT="${AETHER_PREVIEW_PORT_COUNT:-10}"

        export AETHER_DOMAIN AETHER_ADMIN_EMAIL AETHER_NO_HTTPS
        export AETHER_PREVIEW_ENABLED AETHER_PREVIEW_PORT_START AETHER_PREVIEW_PORT_COUNT

        # Source deploy functions for install_compose_file and write_caddyfile
        # shellcheck source=../lib/deploy.sh
        source "$AETHER_SRC_DIR/deploy/lib/deploy.sh"
        install_compose_file
        write_caddyfile
    else
        warn "Could not find deploy/lib/deploy.sh in updated source; keeping existing config"
    fi

    # From here on, any failure is rolled back rather than left half-applied.
    if ! (build_frontend && rebuild_backend && run_migrations && restart_stack && health_check); then
        roll_back "$before" "$before_short" "$archive" || true
        fatal "Update failed and was rolled back. The instance is on $before_short."
    fi

    # Verify the running code matches the target revision. The health check proves
    # the stack is up, but not that it's running the new code — a stale image or
    # missed rebuild would pass health while still serving the old version.
    local after after_short target_short
    after=$(current_revision)
    after_short=$(current_revision_short)

    if [ "$AETHER_PULL" = true ] && is_git_checkout; then
        target_short=$(git -C "$AETHER_SRC_DIR" rev-parse --short HEAD 2>/dev/null || echo "$after_short")
        if [ "$after_short" != "$target_short" ]; then
            error "Source was updated but running revision does not match target"
            error "  Expected: $target_short"
            error "  Running:  $after_short"
            roll_back "$before" "$before_short" "$archive" || true
            fatal "Update verification failed. Rolled back to $before_short."
        fi
    fi

    # Record deployment metadata for `aether status` and future updates
    write_deployment_metadata "$after" "$(current_branch)"

    printf '\n'
    info "Update complete: $before_short → $(current_revision_short)"
    printf '\n'
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    update_aether
fi

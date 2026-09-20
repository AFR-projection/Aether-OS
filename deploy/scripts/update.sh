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

# The repository a source tree with no Git history of its own is fetched from.
# The installer clones this same URL, and it is named here as well because
# `aether update` has to reach the repository on its own — there is no installer
# around, and nothing from install time is recorded that says where the source
# came from. Overridable for a fork or a mirror.
AETHER_REPO_URL="${AETHER_REPO_URL:-https://github.com/AFR-projection/Aether-OS.git}"

AETHER_CHECK_ONLY=false
AETHER_PULL=true

# Set by adopt_git_checkout to the tree it replaced, so a failed update can put
# it back. Empty on every other path.
ADOPTED_PREVIOUS_SRC=""

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

# Fetches origin/<branch> in a way that leaves ancestry intact. Non-zero means
# the fetch itself failed — see fetch_and_compare, which must not read that as an
# answer about the remote.
#
# A `--depth 1` fetch onto the installer's shallow clone leaves the local HEAD
# and the fetched commit as two independent grafted roots with no shared
# ancestor. Git then reports "refusing to merge unrelated histories" and blocks
# even a legitimate fast-forward. Deepening the history (--unshallow on a shallow
# repo) makes the real parent chain visible so the fast-forward succeeds.
fetch_origin() {
    local branch="$1" git_dir
    command_exists git || fatal "git is required to update a git-based install."
    git_dir=$(git -C "$AETHER_SRC_DIR" rev-parse --git-dir 2>/dev/null || echo "$AETHER_SRC_DIR/.git")

    # The deepening is an optimisation on top of the fetch, never a substitute
    # for it: a remote that cannot serve the graft — a history that was rewritten
    # as this repository's was, an older server — still has the branch, and
    # fetching that is what the caller asked for. Only when neither attempt
    # reaches origin is this a failure.
    if [ -f "$git_dir/shallow" ] &&
        git -C "$AETHER_SRC_DIR" fetch --quiet --unshallow origin "$branch"; then
        return 0
    fi

    git -C "$AETHER_SRC_DIR" fetch --quiet origin "$branch"
}

# The revision origin/<branch> is at, read without a local repository so that
# `--check` can still promise it changes nothing. Prints the full sha; fails if
# the branch does not exist or the remote cannot be reached.
remote_branch_revision() {
    local branch="$1" output
    command_exists git || return 1
    output=$(git ls-remote --exit-code "$AETHER_REPO_URL" "refs/heads/$branch" 2>/dev/null) || return 1
    printf '%s' "${output%%[[:space:]]*}"
}

# Compares with origin/<branch> and prints "same", "ahead", or "unknown" when the
# remote could not be reached and the question cannot be answered.
#
# "unknown" is a decision of its own, not a silent "ahead". It used to answer
# "ahead" whenever the two revisions differed — and a failed fetch left the
# remote revision empty, so the difference was always exactly that. On a host
# whose remote could not be reached the operator got "Update available: <rev> →"
# with nothing after the arrow, followed by the whole update cycle — backup,
# frontend rebuild, restart — against source that had not changed, and a closing
# "Update complete: <rev> → <rev>".
fetch_and_compare() {
    local branch="$1"
    if ! fetch_origin "$branch"; then
        printf 'unknown'
        return 0
    fi

    local local_rev remote_rev
    local_rev=$(git -C "$AETHER_SRC_DIR" rev-parse HEAD 2>/dev/null || true)
    # A fetch that reported success has written FETCH_HEAD, so an empty one here
    # is a fetch that did not do what it said. Answered as unknown rather than as
    # a revision to move to.
    remote_rev=$(git -C "$AETHER_SRC_DIR" rev-parse FETCH_HEAD 2>/dev/null || true)
    if [ -z "$local_rev" ] || [ -z "$remote_rev" ]; then
        printf 'unknown'
        return 0
    fi

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

# True when the directory is the checkout the installer was run from: it has the
# repository root, the installer, and it is not the install directory itself.
is_repo_dir() {
    [ -n "${1:-}" ] &&
        [ "$1" != "$AETHER_INSTALL_DIR" ] &&
        [ -f "$1/package.json" ] &&
        [ -f "$1/deploy/lib/install.sh" ]
}

# Replaces the source tree with a copy of a local checkout. Used when the
# installer ran from a checkout it wants the deployment to mirror.
sync_from_repo_dir() {
    # The rsync below uses --delete, so a wrong AETHER_REPO_DIR would not merely
    # fail — it would replace the source tree with whatever that directory
    # happens to hold. Require the directory to actually look like the
    # repository before pointing anything destructive at it.
    if is_repo_dir "${AETHER_REPO_DIR:-}"; then
        info "Re-syncing source from $AETHER_REPO_DIR"
        # `.git` is copied, not excluded. Excluding it is what turns an
        # updatable install into one that can never update again: the files
        # arrive without the history that says which revision they are, and
        # every later `aether update` then finds no origin to fetch from and
        # silently rebuilds what is already there.
        if command_exists rsync; then
            rsync -a --delete \
                --exclude node_modules --exclude dist \
                --exclude '*.log' \
                "$AETHER_REPO_DIR/" "$AETHER_SRC_DIR/"
        else
            (cd "$AETHER_REPO_DIR" && tar cf - --exclude=node_modules --exclude=dist .) \
                | (cd "$AETHER_SRC_DIR" && tar xf -)
        fi
        return 0
    fi

    return 1
}

# Gives a source tree that has no Git history one, by cloning the repository and
# swapping the clone in.
#
# The state this repairs is the one an install from a downloaded tarball lands
# in, and the one this deployment was found in: `<install>/src` holds the files
# but no `.git`, so there is nothing to fetch and `aether update` degenerates
# into rebuilding whatever is already there — an update that reports success and
# changes nothing.
#
# The tree is replaced rather than adopted in place. `git init` over the existing
# files would leave every file upstream has deleted since as an untracked
# leftover, and a tree with no history cannot say which those are. src holds
# nothing but upstream source — the sync that fills it excludes .env, dist and
# node_modules — so the clone and the tree it replaces differ only in revision.
adopt_git_checkout() {
    local branch="$1"
    local staging="$AETHER_INSTALL_DIR/src.adopting"
    local previous="$AETHER_INSTALL_DIR/src.pre-git"

    command_exists git || fatal "git is required to update from $AETHER_REPO_URL."

    info "The source tree at $AETHER_SRC_DIR is not a Git checkout; fetching $AETHER_REPO_URL"
    rm -rf "$staging"
    git clone --quiet --depth 1 --branch "$branch" "$AETHER_REPO_URL" "$staging" \
        || fatal "Could not clone $AETHER_REPO_URL. Check the network and the URL, then try again."

    # A clone that exited 0 is not necessarily this repository: a captive portal
    # or a misconfigured mirror answers with something else and git says nothing
    # about it. Check for the same two files the installer checks for before
    # letting this anywhere near the running source tree.
    if [ ! -f "$staging/package.json" ] || [ ! -f "$staging/deploy/lib/install.sh" ]; then
        rm -rf "$staging"
        fatal "$AETHER_REPO_URL does not look like Aether Cloud OS (no deploy/lib/install.sh)."
    fi

    # The replaced tree is kept until the new one has been built, migrated and
    # health-checked, because `roll_back` cannot put it back by itself: it reverts
    # the revision the update started from, and a tree with no `.git` has no
    # revision to revert to.
    rm -rf "$previous"
    mv "$AETHER_SRC_DIR" "$previous"
    mv "$staging" "$AETHER_SRC_DIR"
    ADOPTED_PREVIOUS_SRC="$previous"

    info "Source is now at $(current_revision_short)"
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

    # Both logs are read into variables and tested without a pipeline. Reading
    # them with `... | grep -q` is what made this check fail on instances that
    # had a log worth reading: see `matches` in lib/core.sh.
    local agent_attempts=20 backend_logs agent_journal
    while [ "$agent_attempts" -gt 0 ]; do
        backend_logs=$(compose logs --since 5m backend 2>/dev/null || true)
        agent_journal=$($SUDO journalctl -u aether-host-agent --since "-5min" --no-pager 2>/dev/null || true)

        if matches "$backend_logs" "\"agentId\":\"$agent_id\".*agent connected" \
            && matches "$agent_journal" "paired with backend"; then
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

    # If this update adopted a tree that had no Git history, there is no revision
    # to reset to — so the tree that was replaced goes back instead. Done before
    # the reset below so that the reset sees a tree with no checkout again and
    # correctly does nothing, rather than leaving the new tree in place while
    # claiming to have reverted it.
    if [ -n "$ADOPTED_PREVIOUS_SRC" ] && [ -d "$ADOPTED_PREVIOUS_SRC" ]; then
        warn "Restoring the source tree this deployment replaced on adoption."
        rm -rf "$AETHER_SRC_DIR"
        mv "$ADOPTED_PREVIOUS_SRC" "$AETHER_SRC_DIR"
        ADOPTED_PREVIOUS_SRC=""
    fi

    reset_to_revision "$prev_revision"

    # Rebuild from the source that was just restored, before the data goes back
    # and the stack is started. The image the failed update built is still on
    # disk, and everything that follows — the restore's `compose up -d`, and any
    # later restart — reuses it, so reverting the tree alone leaves the instance
    # serving the new build under a source tree that says otherwise. That is the
    # difference between claiming a rollback and performing one: a build that
    # cannot start cannot be rolled back by putting the source back, because the
    # source is not what runs.
    #
    # No --pull, unlike the update's own build: the point is to rebuild from the
    # restored source, not to refresh base images, and a rollback that needs the
    # registry cannot run on a host whose network or registry is why the update
    # failed. The layers built before the update are still cached, so this is
    # normally seconds rather than the minutes the update's own build took.
    #
    # A failure here is reported and the rollback continues to the data: the
    # backup is the one thing the operator cannot rebuild, so it is restored
    # either way.
    stage "Rebuilding the backend from the restored source"
    if ! compose build backend; then
        warn "The backend image could not be rebuilt from the restored source."
        warn "The instance may still be running the build that failed. After fixing: aether repair"
    fi

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

# Repairs the host-level settings that the configuration an update writes
# depends on — today, the firewall rule without which the preview ports the
# compose file publishes cannot be reached.
#
# It runs from the source tree that is on disk *now*, in a subshell, for the
# same reason the CLI refresh below does: sourcing a second copy of these
# libraries into this shell would redefine the functions this update is still
# running on. A tree old enough to have no such function has nothing to
# reconcile and says nothing, which is why this is called again once the updated
# tree has been installed.
reconcile_host_settings() {
    [ -f "$AETHER_SRC_DIR/deploy/lib/finalize.sh" ] || return 0

    # Read from .env rather than from the values the caller happens to have set,
    # so the call is not order-dependent: the settings stage sets these later,
    # and this may run before it.
    AETHER_PREVIEW_ENABLED="$(env_value AETHER_PREVIEW_ENABLED "$AETHER_INSTALL_DIR/.env" || true)"
    AETHER_PREVIEW_PORT_START="$(env_value AETHER_PREVIEW_PORT_START "$AETHER_INSTALL_DIR/.env" || true)"
    AETHER_PREVIEW_PORT_COUNT="$(env_value AETHER_PREVIEW_PORT_COUNT "$AETHER_INSTALL_DIR/.env" || true)"
    export AETHER_PREVIEW_ENABLED="${AETHER_PREVIEW_ENABLED:-true}"
    export AETHER_PREVIEW_PORT_START="${AETHER_PREVIEW_PORT_START:-8443}"
    export AETHER_PREVIEW_PORT_COUNT="${AETHER_PREVIEW_PORT_COUNT:-10}"

    (
        # shellcheck source=/dev/null
        source "$AETHER_SRC_DIR/deploy/lib/core.sh"
        # shellcheck source=/dev/null
        source "$AETHER_SRC_DIR/deploy/lib/utils.sh"
        # shellcheck source=/dev/null
        source "$AETHER_SRC_DIR/deploy/lib/finalize.sh"
        declare -F ensure_preview_firewall_rule >/dev/null || exit 0
        ensure_preview_firewall_rule
    ) || warn "The host firewall could not be reconciled; previews may not be reachable."
}

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
            elif [ "$decision" = "unknown" ]; then
                # A check that cannot reach the remote is not a failed check: it
                # is a check that cannot answer, and it says so. Nothing was
                # changed either way, so this is not an error exit.
                warn "Could not fetch from $AETHER_REPO_URL, so the available revision is unknown."
                info "The instance is unchanged. Use --no-pull to rebuild the source already on disk."
            else
                info "Update available: $before_short → $(git -C "$AETHER_SRC_DIR" rev-parse --short FETCH_HEAD)"
            fi
        else
            local remote_revision
            if remote_revision=$(remote_branch_revision "$AETHER_UPDATE_BRANCH"); then
                info "The source tree is not a Git checkout; the next update will adopt $AETHER_UPDATE_BRANCH at ${remote_revision:0:7} from $AETHER_REPO_URL."
            else
                warn "The source tree is not a Git checkout and $AETHER_REPO_URL could not be reached."
                info "Use --no-pull to rebuild the current source without fetching."
            fi
        fi
        return 0
    fi

    acquire_update_lock
    trap 'release_update_lock' EXIT

    # Before the up-to-date check, so that an instance already on the newest
    # revision is still repaired: ufw enabled after the install leaves the
    # preview ports unreachable, and an update that only ever answers "Already
    # up to date" would never fix it.
    reconcile_host_settings

    if [ "$AETHER_PULL" = true ] && is_git_checkout; then
        require_clean_tree

        stage "Checking for updates"
        local decision
        decision=$(fetch_and_compare "$AETHER_UPDATE_BRANCH")
        if [ "$decision" = "same" ]; then
            info "Already up to date ($before_short)"
            return 0
        fi
        if [ "$decision" = "unknown" ]; then
            # Stop here rather than carry on. Everything below assumes there is a
            # revision to move to: the backup, the rebuild, the restart, and the
            # "Update complete: X → Y" at the end. With no reachable remote, Y
            # does not exist, and the whole cycle would run against source that
            # had not moved while reporting that it had. Nothing has been touched
            # at this point, so stopping costs the operator nothing.
            error "Could not fetch from $AETHER_REPO_URL, so there is no revision to update to."
            error "The instance is unchanged. Check DNS, the network, and that this host can"
            error "reach $AETHER_REPO_URL — or re-run with --no-pull to rebuild the source"
            error "already on disk."
            fatal "Update aborted before any change."
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
        elif is_repo_dir "${AETHER_REPO_DIR:-}"; then
            stage "Syncing source"
            sync_from_repo_dir
        else
            stage "Adopting the source tree into Git"
            adopt_git_checkout "$AETHER_UPDATE_BRANCH"
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

    # Again, now that the compose file naming these ports has been written and
    # the updated source is in place: this is the call that opens them on an
    # instance that was installed before previews existed, where the earlier one
    # had no such function to find.
    reconcile_host_settings

    # The management CLI is a *copy* of the scripts in the source tree, taken at
    # install time, and `aether update` execs that copy — so the update engine is
    # whatever was installed, and a fix to the updater itself can never reach an
    # instance through it. Re-install the CLI from the tree that was just
    # updated, so the next run is the engine that belongs to this revision.
    #
    # Without this, a deployment that could not update itself stays unable to
    # update itself no matter how the updater is fixed: reaching the fix would
    # require the very update that is broken.
    #
    # Taken from the updated source, not from the installed copy, and run in a
    # subshell: sourcing a second copy of these libraries into this shell would
    # redefine the functions this update is still running on — `health_check`
    # exists in both, with different meanings.
    if [ -f "$AETHER_SRC_DIR/deploy/lib/finalize.sh" ]; then
        (
            # shellcheck source=/dev/null
            source "$AETHER_SRC_DIR/deploy/lib/core.sh"
            # shellcheck source=/dev/null
            source "$AETHER_SRC_DIR/deploy/lib/utils.sh"
            # shellcheck source=/dev/null
            source "$AETHER_SRC_DIR/deploy/lib/finalize.sh"
            install_cli
        ) || warn "The installed CLI could not be refreshed; a later update will retry."
    else
        warn "Could not find deploy/lib/finalize.sh in the updated source; keeping the installed CLI."
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

    # The tree kept aside by an adoption is only for a rollback that can no
    # longer happen: this update has been built, migrated, restarted and
    # verified, and the revision check above proved the new source is what runs.
    if [ -n "$ADOPTED_PREVIOUS_SRC" ]; then
        rm -rf "$ADOPTED_PREVIOUS_SRC"
        ADOPTED_PREVIOUS_SRC=""
    fi

    printf '\n'
    info "Update complete: $before_short → $(current_revision_short)"
    printf '\n'
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    update_aether
fi

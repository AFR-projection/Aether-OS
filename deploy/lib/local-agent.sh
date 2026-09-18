#!/usr/bin/env bash
# Aether Cloud OS — local host agent.
#
# Installs the host agent on the same machine as the backend and pairs it with
# that backend, so a fresh install manages its own host with no manual pairing
# step. Remote hosts are unaffected: they still use deploy/scripts/setup-host.sh
# with a token the operator copies out of the UI. This file generates its own
# token, stores only its SHA-256 hash, and hands the plaintext to the agent
# through a mode-600 EnvironmentFile. The token is never printed.
#
# Sourced by finalize.sh, which calls install_local_agent as the last stage
# after the stack is healthy. Running it directly does the same thing.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=./core.sh
source "$SCRIPT_DIR/core.sh"
# shellcheck source=./utils.sh
source "$SCRIPT_DIR/utils.sh"

# AETHER_INSTALL_DIR comes from core.sh (default /opt/aether, or whatever
# --dir/the environment set). It is deliberately not derived from $SCRIPT_DIR:
# this file sits at <install>/src/deploy/lib, so "/.." is not the install root —
# and the same file is also sourced from a repo checkout, where it differs again.
AETHER_SRC_DIR="${AETHER_SRC_DIR:-$AETHER_INSTALL_DIR/src}"
AETHER_AGENT_DIR="${AETHER_AGENT_DIR:-$AETHER_INSTALL_DIR/local-agent}"
AETHER_AGENT_RECORD="$AETHER_INSTALL_DIR/local-agent.json"
AETHER_AGENT_ENV="$AETHER_AGENT_DIR/agent.env"
AETHER_AGENT_USER="${AETHER_AGENT_USER:-aether-agent}"
AETHER_AGENT_GROUP="${AETHER_AGENT_GROUP:-aether-agent}"
AETHER_AGENT_SERVICE="aether-host-agent"
COMPOSE_FILE="$AETHER_INSTALL_DIR/docker-compose.yml"
ENV_FILE="$AETHER_INSTALL_DIR/.env"

# The data lives at <install>/data, the same tree the compose bind mounts map to
# /opt/aether/workspace and /opt/aether/uploads inside the backend container, and
# it is chowned to the container's uid below.
AETHER_LOCAL_DATA_DIR="${AETHER_LOCAL_DATA_DIR:-$AETHER_INSTALL_DIR/data}"
AETHER_LOCAL_WORKSPACE_DIR="$AETHER_LOCAL_DATA_DIR/workspace"

# The uid/gid the backend container runs as (packages/backend/Dockerfile). The
# agent shares it numerically so both processes own the workspace outright —
# a shared group is not enough, because files the backend writes are mode 644
# and the agent could not rewrite them.
AETHER_APP_UID="${AETHER_APP_UID:-1001}"
AETHER_APP_GID="${AETHER_APP_GID:-1001}"

compose() {
    compose_cmd -f "$COMPOSE_FILE" "$@"
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

config_value() {
    env_value "$1" "$AETHER_AGENT_ENV" 2>/dev/null || true
}

generate_agent_id() {
    if [ -r /proc/sys/kernel/random/uuid ]; then
        head -n1 /proc/sys/kernel/random/uuid
        return
    fi
    # Fallback for kernels without that pseudo-file, formatted as a UUID.
    openssl rand -hex 16 | sed -E 's/^(.{8})(.{4})(.{4})(.{4})(.{12})$/\1-\2-\3-\4-\5/'
}

# Same format the backend mints in agent-pairing.service.ts.
generate_token() {
    printf 'aether-agent_%s' "$(openssl rand -base64 32 | tr -d '\n=' | tr '+/' '-_')"
}

hash_token() {
    printf '%s' "$1" | sha256sum | cut -d' ' -f1
}

# The URL the agent dials. The backend container publishes no port, so the
# agent reaches it through Caddy. Caddy matches on Host, which is why a domain
# install must use the domain rather than 127.0.0.1.
backend_ws_url() {
    local domain no_https
    domain=$(env_value AETHER_DOMAIN "$ENV_FILE" 2>/dev/null || true)
    no_https=$(env_value AETHER_NO_HTTPS "$ENV_FILE" 2>/dev/null || true)

    if [ -z "$domain" ]; then
        printf 'ws://127.0.0.1'
    elif [ "$no_https" = "true" ]; then
        printf 'ws://%s' "$domain"
    else
        printf 'wss://%s' "$domain"
    fi
}

require_deployment() {
    [ -f "$COMPOSE_FILE" ] || fatal "No deployment at $AETHER_INSTALL_DIR (missing docker-compose.yml)."
    [ -f "$ENV_FILE" ] || fatal "No .env at $ENV_FILE."
    [ -d "$AETHER_SRC_DIR/packages/host-agent" ] || fatal "No host-agent source at $AETHER_SRC_DIR."
    command_exists docker || fatal "docker is not installed."
}

# Waits for the backend to answer *and* report a reachable database. The
# liveness probe alone would pass while migrations were still running.
wait_for_backend() {
    info "Waiting for the backend to accept connections"

    local attempts="${1:-60}"
    while [ "$attempts" -gt 0 ]; do
        if compose exec -T backend node -e \
            "fetch('http://127.0.0.1:3000/api/health').then(r=>r.json()).then(j=>process.exit(j.checks&&j.checks.database&&j.checks.database.ok?0:1)).catch(()=>process.exit(1))" \
            >/dev/null 2>&1; then
            info "Backend is up and its database is reachable"
            return 0
        fi
        attempts=$((attempts - 1))
        sleep 3
    done

    fatal "The backend did not become ready. Check: aether logs --tail 100 backend"
}

# ---------------------------------------------------------------------------
# Identity
# ---------------------------------------------------------------------------

# Creates the group and user the agent runs as, and leaves the data directory
# owned by the same numeric uid/gid the backend container uses.
ensure_agent_identity() {
    local existing_gid existing_uid owner

    existing_gid=$(getent group "$AETHER_APP_GID" | cut -d: -f1 || true)
    if [ -z "$existing_gid" ]; then
        info "Creating group $AETHER_AGENT_GROUP (gid $AETHER_APP_GID)"
        $SUDO groupadd --system --gid "$AETHER_APP_GID" "$AETHER_AGENT_GROUP"
    elif [ "$existing_gid" != "$AETHER_AGENT_GROUP" ]; then
        # Reusing it is correct — the data directory is already owned by this
        # gid — but say so rather than silently attaching to a foreign group.
        info "gid $AETHER_APP_GID already exists as group '$existing_gid'; reusing it"
        AETHER_AGENT_GROUP="$existing_gid"
    fi

    existing_uid=$(getent passwd "$AETHER_APP_UID" | cut -d: -f1 || true)
    if [ -z "$existing_uid" ]; then
        info "Creating user $AETHER_AGENT_USER (uid $AETHER_APP_UID)"
        $SUDO useradd --system \
            --uid "$AETHER_APP_UID" \
            --gid "$AETHER_APP_GID" \
            --home-dir "$AETHER_AGENT_DIR" \
            --shell /usr/sbin/nologin \
            --comment "Aether Cloud OS host agent" \
            "$AETHER_AGENT_USER"
    elif [ "$existing_uid" = "$AETHER_AGENT_USER" ]; then
        info "User $AETHER_AGENT_USER already exists"
    else
        fatal "uid $AETHER_APP_UID belongs to user '$existing_uid', not '$AETHER_AGENT_USER'. The agent must share the backend's uid to own the workspace. Free that uid, or install with AETHER_APP_UID/AETHER_APP_GID set to a pair you control."
    fi

    owner=$(id -un)
    if [ "$(id -u)" -eq 0 ]; then
        owner=root
    fi

    mkdir -p "$AETHER_LOCAL_DATA_DIR/workspace" "$AETHER_LOCAL_DATA_DIR/uploads"
    $SUDO chown -R "$AETHER_APP_UID:$AETHER_APP_GID" "$AETHER_LOCAL_DATA_DIR"
    info "Data directory owned by $AETHER_APP_UID:$AETHER_APP_GID ($owner keeps read access via group)"
}

# ---------------------------------------------------------------------------
# Pairing
# ---------------------------------------------------------------------------

# Registers the local agent by running the backend's own registration script in
# a one-off container. Doing it through the application rather than `psql` keeps
# one implementation of "what a local agent row is" — the same code the
# migration's constraint and the gateway's NULL-owner mapping expect.
#
# Only the hash is passed, so the plaintext token never enters the backend
# process, and only the hash is ever stored.
pair_local_agent() {
    local agent_id="$1" token_hash="$2"

    info "Registering the local agent with the backend"

    compose run --rm --no-deps \
        -e AETHER_AGENT_ID="$agent_id" \
        -e AETHER_AGENT_LABEL="Local host" \
        -e AETHER_AGENT_TOKEN_HASH="$token_hash" \
        --entrypoint node backend dist/scripts/pair-local-agent.js \
        || fatal "Could not register the local agent. Check: aether logs --tail 50 backend"

    info "Local agent registered (token hash only)"
}

write_agent_record() {
    local agent_id="$1"
    umask 022
    cat > "$AETHER_AGENT_RECORD" <<EOF
{"agentId":"$agent_id","label":"Local host","scope":"local","pairedAt":"$(date -u '+%Y-%m-%dT%H:%M:%SZ')"}
EOF
    chmod 644 "$AETHER_AGENT_RECORD"
}

# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------

agent_unit_active() {
    systemctl is-active --quiet "$AETHER_AGENT_SERVICE" 2>/dev/null
}

agent_journal_paired() {
    $SUDO journalctl -u "$AETHER_AGENT_SERVICE" --since "-10min" --no-pager 2>/dev/null \
        | grep -q "paired with backend"
}

backend_log_saw_agent() {
    local agent_id="$1"
    compose logs --since 10m backend 2>/dev/null \
        | grep -q "\"agentId\":\"$agent_id\".*agent connected"
}

# The only definition of "connected" in this codebase: the agent's own journal
# says the backend acknowledged its handshake, AND the backend's log says it
# accepted that agent. Either one alone is a half-open connection.
verify_agent_connection() {
    local agent_id="$1"
    local attempts="${2:-20}"

    info "Verifying the agent on both sides"

    while [ "$attempts" -gt 0 ]; do
        if agent_journal_paired && backend_log_saw_agent "$agent_id"; then
            info "Agent journal: paired with backend"
            info "Backend log: agent connected ($agent_id)"
            return 0
        fi
        attempts=$((attempts - 1))
        sleep 3
    done

    error "The agent is not confirmed connected on both sides."
    error "  agent side:   sudo journalctl -u $AETHER_AGENT_SERVICE -n 50 --no-pager"
    error "  backend side: aether logs --tail 50 backend"
    return 1
}

# True when this install already has a working local agent, so a resumed or
# repeated run does not rotate its token or rebuild the agent for nothing.
local_agent_healthy() {
    [ -f "$AETHER_AGENT_ENV" ] || return 1
    [ -f "$AETHER_AGENT_RECORD" ] || return 1
    agent_unit_active || return 1

    local agent_id
    agent_id=$(config_value AETHER_AGENT_ID)
    [ -n "$agent_id" ] || return 1

    agent_journal_paired && backend_log_saw_agent "$agent_id"
}

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------

install_local_agent() {
    require_deployment
    wait_for_backend

    if local_agent_healthy; then
        info "The local host agent is already installed and connected"
        return 0
    fi

    local agent_id token token_hash
    agent_id=$(config_value AETHER_AGENT_ID)
    token=$(config_value AETHER_PAIRING_TOKEN)

    if [ -z "$agent_id" ] || [ -z "$token" ]; then
        if [ -d "$AETHER_AGENT_DIR" ] && [ -f "$AETHER_AGENT_ENV" ]; then
            fatal "$AETHER_AGENT_ENV exists but is missing AETHER_AGENT_ID or AETHER_PAIRING_TOKEN. Refusing to silently re-pair; repair the file or remove $AETHER_AGENT_DIR to pair again."
        fi
        agent_id=$(generate_agent_id)
        token=$(generate_token)
        info "Generated a new pairing token (stored hashed; not shown)"
    else
        info "Reusing the existing agent identity from $AETHER_AGENT_ENV"
    fi

    token_hash=$(hash_token "$token")

    ensure_agent_identity
    pair_local_agent "$agent_id" "$token_hash"

    # Write the record as soon as the identity is paired, BEFORE the runtime
    # install that can fail. The record ("a local agent is paired on this host")
    # is true the moment pair_local_agent commits its DB row; it does not depend
    # on the build succeeding. Writing it after setup-host.sh meant a failed
    # build (e.g. the CHDIR permission bug) left a paired agent with no
    # local-agent.json, so `aether doctor`/`status`/`repair` could not even tell
    # an agent existed here — reporting "record is missing" instead of guiding a
    # retry. Recording it first makes the failure recoverable.
    write_agent_record "$agent_id"

    # setup-host.sh owns one implementation of: copy the source, build the
    # agent, write agent.env (600), install the unit, start it. Passing the
    # service user is what makes this the unprivileged local agent rather than
    # the root one remote hosts get.
    info "Installing the agent runtime into $AETHER_AGENT_DIR"
    bash "$AETHER_SRC_DIR/deploy/scripts/setup-host.sh" \
        --backend-url "$(backend_ws_url)" \
        --token "$token" \
        --agent-id "$agent_id" \
        --workspace "$AETHER_LOCAL_WORKSPACE_DIR" \
        --install-dir "$AETHER_AGENT_DIR" \
        --repo-dir "$AETHER_SRC_DIR" \
        --service-user "$AETHER_AGENT_USER"

    verify_agent_connection "$agent_id" \
        || fatal "Local host agent installation failed: the connection was not confirmed on both sides."

    info "Local host agent installed and verified"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    install_local_agent
fi

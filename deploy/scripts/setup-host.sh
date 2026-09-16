#!/usr/bin/env bash
# Aether Cloud OS — host agent setup.
#
# Installs the Aether host agent on a machine so an Aether instance can manage
# it: read its processes and system information, browse and edit its files, and
# open terminals on it.
#
# This script runs on the machine that is being MANAGED (the "host"), which is
# usually not the machine running the Aether backend.
#
# Pairing is not initiated here. The operator pairs an agent in the Aether UI
# (Settings → Host agents → Pair an agent) and is shown a token exactly once.
# That token is the input to this script; there is no endpoint that mints one
# from this side, and the token cannot be retrieved again afterwards.
#
# Usage:
#   sudo ./setup-host.sh --backend-url wss://aether.example.com --token <TOKEN>
#
# Options:
#   --backend-url URL   WebSocket URL of the Aether backend (ws:// or wss://)
#   --token TOKEN       Pairing token shown by the Aether UI (required)
#   --agent-id UUID     Agent id shown by the Aether UI (required)
#   --workspace DIR     Directory the agent may touch (default: /opt/aether/workspace)
#   --install-dir DIR   Where to install the agent (default: /opt/aether-host-agent)
#   --repo-dir DIR      Source checkout to install from (default: this checkout)
#   --no-service        Configure only; do not install or start the systemd unit
#   --uninstall         Stop the agent and remove its unit, install dir, and config
#   -h, --help          Show this help

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The libraries ship beside the installer; a standalone copy of this script may
# not have them, so fall back to self-contained helpers rather than failing.
if [ -f "$SCRIPT_DIR/../lib/core.sh" ]; then
    # shellcheck source=../lib/core.sh
    source "$SCRIPT_DIR/../lib/core.sh"
    # shellcheck source=../lib/utils.sh
    source "$SCRIPT_DIR/../lib/utils.sh"
else
    info() { printf '\033[0;36m[INFO]\033[0m %s\n' "$*" >&2; }
    warn() { printf '\033[0;33m[WARN]\033[0m %s\n' "$*" >&2; }
    error() { printf '\033[0;31m[ERROR]\033[0m %s\n' "$*" >&2; }
    fatal() { error "$@"; exit 1; }
    command_exists() { command -v "$1" >/dev/null 2>&1; }
fi

SERVICE_NAME="aether-host-agent"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
NODE_MAJOR_REQUIRED=20

# --- Defaults --------------------------------------------------------------
AETHER_BACKEND_URL="${AETHER_BACKEND_URL:-}"
AETHER_PAIRING_TOKEN="${AETHER_PAIRING_TOKEN:-}"
AETHER_AGENT_ID="${AETHER_AGENT_ID:-}"
AETHER_WORKSPACE_ROOT="${AETHER_WORKSPACE_ROOT:-/opt/aether/workspace}"
AETHER_HOST_INSTALL_DIR="${AETHER_HOST_INSTALL_DIR:-/opt/aether-host-agent}"
AETHER_REPO_DIR="${AETHER_REPO_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
AETHER_INSTALL_SERVICE=true
AETHER_UNINSTALL=false

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
usage() {
    sed -n '3,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

parse_args() {
    while [ $# -gt 0 ]; do
        case "$1" in
            --backend-url) AETHER_BACKEND_URL="${2:-}"; shift 2 ;;
            --token)       AETHER_PAIRING_TOKEN="${2:-}"; shift 2 ;;
            --agent-id)    AETHER_AGENT_ID="${2:-}"; shift 2 ;;
            --workspace)   AETHER_WORKSPACE_ROOT="${2:-}"; shift 2 ;;
            --install-dir) AETHER_HOST_INSTALL_DIR="${2:-}"; shift 2 ;;
            --repo-dir)    AETHER_REPO_DIR="${2:-}"; shift 2 ;;
            --no-service)  AETHER_INSTALL_SERVICE=false; shift ;;
            --uninstall)   AETHER_UNINSTALL=true; shift ;;
            -h|--help)     usage; exit 0 ;;
            *)             error "Unknown option: $1"; usage; exit 2 ;;
        esac
    done
}

# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------
run_as_root() {
    # The install directory, the config file, and the systemd unit are all
    # root-owned, so the whole run needs root. Re-exec rather than sprinkling
    # sudo through every write.
    if [ "$(id -u)" -eq 0 ]; then
        SUDO=""
        return
    fi
    if command_exists sudo; then
        info "Re-running with sudo"
        exec sudo -E bash "${BASH_SOURCE[0]}" "$@"
    fi
    fatal "This script must run as root (or with sudo available)."
}

validate_backend_url() {
    [ -n "$AETHER_BACKEND_URL" ] || fatal \
        "--backend-url is required (e.g. --backend-url wss://aether.example.com)"

    case "$AETHER_BACKEND_URL" in
        ws://*|wss://*) : ;;
        *) fatal "The backend URL must use the ws:// or wss:// scheme. Got: $AETHER_BACKEND_URL" ;;
    esac

    # A user JWT belongs on the browser socket, not here. Catching the common
    # mistake up front saves a confusing 401 in the journal.
    case "$AETHER_BACKEND_URL" in
        https://*|http://*) fatal "Use wss:// or ws:// for the agent socket, not http(s)://." ;;
    esac
}

validate_token() {
    if [ -z "$AETHER_PAIRING_TOKEN" ]; then
        error "A pairing token is required."
        error ""
        error "Pair an agent first, then copy the token it shows you:"
        error "  1. Open the Aether UI → Settings → Host agents"
        error "  2. Choose 'Pair an agent'"
        error "  3. Copy AETHER_PAIRING_TOKEN from the dialog (shown once)"
        error "  4. Re-run:  sudo $0 --backend-url wss://your-host --token <TOKEN>"
        exit 1
    fi

    if [ "${#AETHER_PAIRING_TOKEN}" -lt 16 ]; then
        fatal "The pairing token is too short to be valid (the agent requires at least 16 characters)."
    fi
}

validate_agent_id() {
    # The agent id is NOT ours to choose. `authenticateAgent` looks the agent up
    # by primary key (`WHERE id = $1`), and that row was created by the backend
    # when the operator paired the agent. An id generated here would be looked up,
    # not found, and rejected as "Unknown agent" — so this must be the id the UI
    # displayed, never a fresh one.
    if [ -z "$AETHER_AGENT_ID" ]; then
        error "An agent id is required."
        error ""
        error "It is shown in the same dialog as the pairing token:"
        error "  1. Open the Aether UI → Settings → Host agents"
        error "  2. Choose 'Pair an agent'"
        error "  3. Copy AETHER_AGENT_ID from the dialog (shown once)"
        error "  4. Re-run:  sudo $0 --backend-url wss://your-host --agent-id <UUID> --token <TOKEN>"
        exit 1
    fi

    case "$AETHER_AGENT_ID" in
        *[!0-9a-fA-F-]*)
            fatal "The agent id must be the UUID shown by the Aether UI. Got: $AETHER_AGENT_ID"
            ;;
    esac
}

validate_node() {
    if ! command_exists node; then
        info "Node.js is not installed; installing version ${NODE_MAJOR_REQUIRED}"
        install_nodejs
    fi

    local major
    major="$(node --version | sed 's/^v\([0-9]*\).*/\1/')"
    if [ "$major" -lt "$NODE_MAJOR_REQUIRED" ]; then
        warn "Node.js $(node --version) is older than the required v${NODE_MAJOR_REQUIRED}; upgrading"
        install_nodejs
    fi

    info "Node.js $(node --version) present"
}

install_nodejs() {
    if ! command_exists curl; then
        fatal "curl is required to install Node.js."
    fi

    info "Installing Node.js ${NODE_MAJOR_REQUIRED}.x from NodeSource"
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR_REQUIRED}.x" | bash -
    $SUDO apt-get install -y nodejs

    command_exists node || fatal "Node.js installation failed."
}

ensure_build_tools() {
    # node-pty is a native module; without a compiler the build fails with an
    # opaque gyp error. Checking first turns that into a clear message.
    local missing=()
    command_exists cc || missing+=(build-essential)
    command_exists python3 || missing+=(python3)
    command_exists make || missing+=(build-essential)

    if [ ${#missing[@]} -eq 0 ]; then
        return
    fi

    info "Installing build tools needed to compile the terminal backend: ${missing[*]}"
    $SUDO apt-get update -qq
    $SUDO apt-get install -y "${missing[@]}"
}

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------
stage_line() {
    printf '\n\033[1;36m==> %s\033[0m\n' "$1" >&2
}

install_agent_source() {
    stage_line "Installing the agent into $AETHER_HOST_INSTALL_DIR"

    if [ ! -d "$AETHER_REPO_DIR/packages/host-agent" ]; then
        fatal "No host-agent package at $AETHER_REPO_DIR/packages/host-agent. Pass --repo-dir pointing at an Aether checkout."
    fi

    mkdir -p "$AETHER_HOST_INSTALL_DIR"

    info "Copying sources"
    if command_exists rsync; then
        rsync -a --delete \
            --exclude node_modules --exclude .git --exclude dist \
            --exclude '*.tsbuildinfo' \
            "$AETHER_REPO_DIR/" "$AETHER_HOST_INSTALL_DIR/"
    else
        # tar fallback for images without rsync.
        rm -rf "${AETHER_HOST_INSTALL_DIR:?}/"*
        (cd "$AETHER_REPO_DIR" && tar cf - \
            --exclude=./node_modules --exclude=./.git \
            --exclude=./*/dist --exclude=./*/node_modules .) \
            | (cd "$AETHER_HOST_INSTALL_DIR" && tar xf -)
    fi

    build_agent
}

build_agent() {
    stage_line "Building the agent"

    local package_manager="npm"
    if command_exists pnpm; then
        package_manager="pnpm"
    fi

    cd "$AETHER_HOST_INSTALL_DIR"

    info "Installing dependencies with $package_manager"
    if [ "$package_manager" = "pnpm" ]; then
        pnpm install --frozen-lockfile --filter "@aether/host-agent..." --filter @aether/shared
    else
        npm install --no-audit --no-fund
    fi

    info "Compiling"
    if [ "$package_manager" = "pnpm" ]; then
        pnpm --filter @aether/shared build
        pnpm --filter @aether/host-agent build
    else
        (cd packages/shared && npm run build)
        (cd packages/host-agent && npm run build)
    fi

    [ -f "$AETHER_HOST_INSTALL_DIR/packages/host-agent/dist/index.js" ] \
        || fatal "The build did not produce packages/host-agent/dist/index.js"

    cd - >/dev/null
    info "Agent built successfully"
}

write_config() {
    local config_file="$AETHER_HOST_INSTALL_DIR/agent.env"

    # AETHER_AGENT_ID is validated as present before we get here; it is the id
    # the backend already knows, not one we invent.
    mkdir -p "$AETHER_WORKSPACE_ROOT"

    info "Writing $config_file (mode 600)"
    umask 077
    cat > "$config_file" <<EOF
# Aether host agent configuration — generated by setup-host.sh.
# This file contains a pairing token. Keep it mode 600 and do not commit it.
NODE_ENV=production
LOG_LEVEL=info

AETHER_BACKEND_URL=$AETHER_BACKEND_URL
AETHER_AGENT_ID=$AETHER_AGENT_ID
AETHER_PAIRING_TOKEN=$AETHER_PAIRING_TOKEN

AETHER_WORKSPACE_ROOT=$AETHER_WORKSPACE_ROOT

TERMINAL_ENABLED=true
# Sending signals is opt-in: it is the one capability that can take this host
# down, so enable it deliberately.
PROCESS_SIGNAL_ENABLED=false
EOF
    chmod 600 "$config_file"
}

write_service() {
    [ "$AETHER_INSTALL_SERVICE" = "true" ] || {
        info "--no-service given; skipping the systemd unit"
        return
    }

    stage_line "Installing the systemd unit"

    $SUDO tee "$SERVICE_FILE" >/dev/null <<EOF
[Unit]
Description=Aether Cloud OS Host Agent
Documentation=https://github.com/AFR-projection/Aether-OS
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# The agent reads files, runs terminals, and manages processes on this host at
# the operator's request, so it needs real privileges. It is constrained by the
# workspace root it is configured with, not by an unprivileged uid.
User=root
WorkingDirectory=$AETHER_HOST_INSTALL_DIR/packages/host-agent
EnvironmentFile=$AETHER_HOST_INSTALL_DIR/agent.env
ExecStart=$(command -v node) $AETHER_HOST_INSTALL_DIR/packages/host-agent/dist/index.js
Restart=always
RestartSec=5s
# The agent holds a WebSocket per connection plus PTYs; keep headroom.
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

    $SUDO systemctl daemon-reload
    $SUDO systemctl enable "$SERVICE_NAME"
    info "Unit installed and enabled: ${SERVICE_NAME}.service"
}

start_service() {
    [ "$AETHER_INSTALL_SERVICE" = "true" ] || return

    stage_line "Starting the agent"
    $SUDO systemctl restart "$SERVICE_NAME"
    sleep 2

    if $SUDO systemctl is-active --quiet "$SERVICE_NAME"; then
        info "Agent is running"
    else
        error "The agent failed to start. Recent log output:"
        $SUDO journalctl -u "$SERVICE_NAME" -n 30 --no-pager >&2 || true
        fatal "Fix the reported error, then re-run this script."
    fi
}

print_summary() {
    local connected_hint="Check that it reached the backend:"
    if [ "$AETHER_INSTALL_SERVICE" = "true" ]; then
        connected_hint="$(cat <<EOF
The agent retries with exponential backoff, so a transient failure self-heals.
Confirm the connection either way:

  # This host:
  sudo journalctl -u $SERVICE_NAME -f

  # The Aether UI: Settings -> Host agents should show it as online.
EOF
)"
    fi

    cat >&2 <<EOF

  ---------------------------------------------------------------
   Aether host agent installed
  ---------------------------------------------------------------
   Backend:      $AETHER_BACKEND_URL
   Agent id:     $AETHER_AGENT_ID
   Config:       $AETHER_HOST_INSTALL_DIR/agent.env
   Workspace:    $AETHER_WORKSPACE_ROOT
$( [ "$AETHER_INSTALL_SERVICE" = "true" ] && printf '   Service:      systemctl status %s\n' "$SERVICE_NAME" )

$connected_hint

   To remove: sudo $0 --uninstall
  ---------------------------------------------------------------

EOF
}

uninstall_agent() {
    stage_line "Uninstalling the Aether host agent"

    if $SUDO systemctl list-unit-files 2>/dev/null | grep -q "^${SERVICE_NAME}.service"; then
        $SUDO systemctl stop "$SERVICE_NAME" 2>/dev/null || true
        $SUDO systemctl disable "$SERVICE_NAME" 2>/dev/null || true
    fi

    if [ -f "$SERVICE_FILE" ]; then
        $SUDO rm -f "$SERVICE_FILE"
        $SUDO systemctl daemon-reload
        info "Removed $SERVICE_FILE"
    fi

    if [ -d "$AETHER_HOST_INSTALL_DIR" ]; then
        local answer="yes"
        if [ -t 0 ]; then
            printf 'Also delete %s (contains the agent config and token)? [y/N] ' "$AETHER_HOST_INSTALL_DIR"
            read -r answer || true
        fi
        case "$answer" in
            [Yy]|[Yy][Ee][Ss])
                # The token lives here; removing it is what actually revokes
                # this host locally. Revoke it in the UI as well.
                $SUDO rm -rf "$AETHER_HOST_INSTALL_DIR"
                info "Removed $AETHER_HOST_INSTALL_DIR"
                ;;
            *)
                info "Left $AETHER_HOST_INSTALL_DIR in place"
                ;;
        esac
    fi

    info "Done. Revoke the pairing in the Aether UI so the token stops being accepted."
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
main() {
    local original_args=("$@")
    parse_args "$@"
    run_as_root "${original_args[@]}"

    if [ "$AETHER_UNINSTALL" = "true" ]; then
        uninstall_agent
        return
    fi

    validate_backend_url
    validate_token
    validate_agent_id
    validate_node
    ensure_build_tools

    install_agent_source
    write_config
    write_service
    start_service
    print_summary
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    main "$@"
fi

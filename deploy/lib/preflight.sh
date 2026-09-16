#!/usr/bin/env bash
# Aether Cloud OS — preflight checks.
#
# Validates that the target machine meets every requirement before any
# modification is attempted. Per INSTALLER-CONTRACT.md, unsupported platforms,
# architectures, and missing systemd are BLOCKING, not advisory. Failing early
# avoids wasted time and partial installs that would need to be rolled back.

# Blocking thresholds — below these the installer refuses to run at all.
MIN_BLOCK_CPU_CORES=1
MIN_BLOCK_RAM_MB=2048
MIN_BLOCK_DISK_GB=20

# Recommended minimums — below these the installer warns and asks.
MIN_RECOMMENDED_CPU_CORES=2
MIN_RECOMMENDED_RAM_MB=4096
MIN_RECOMMENDED_DISK_GB=40

check_platform() {
    local distro arch
    distro=$(detect_distro)
    arch=$(detect_arch)

    local os_id os_version
    os_id=$(echo "$distro" | cut -d' ' -f1)
    os_version=$(echo "$distro" | cut -d' ' -f2)

    if [ "$os_id" != "ubuntu" ]; then
        fatal "Unsupported operating system: '$os_id ${os_version}'. Aether currently supports Ubuntu 22.04/24.04 LTS (x86_64) only."
    fi

    case "$os_version" in
        22.04|24.04) info "Detected Ubuntu $os_version (supported)" ;;
        20.04) warn "Ubuntu 20.04 is outside the tested range (22.04/24.04). Proceeding — please report any issues." ;;
        *) warn "Ubuntu $os_version is not officially supported. Proceeding anyway." ;;
    esac

    case "$arch" in
        x86_64|amd64) info "Detected architecture: $arch (supported)" ;;
        *) fatal "Unsupported CPU architecture: $arch. Aether currently supports x86_64 (amd64) only." ;;
    esac
}

check_init_system() {
    # Contract §1.3: systemd is REQUIRED — block rather than warn.
    if [ -d /run/systemd/system ]; then
        info "systemd detected"
    else
        fatal "systemd is not the init system on this machine. Aether's service management requires systemd (SysVinit, Upstart, and OpenRC are not supported)."
    fi
}

check_resources() {
    local cpu_cores ram_mb disk_gb

    cpu_cores=$(nproc 2>/dev/null || echo 0)
    ram_mb=$(free -m | awk '/^Mem:/{print $2}')
    disk_gb=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')

    info "CPU: ${cpu_cores} cores | RAM: ${ram_mb} MB | Disk: ${disk_gb} GB free"

    # Hard blocks first.
    if [ "$cpu_cores" -lt "$MIN_BLOCK_CPU_CORES" ]; then
        fatal "CPU has ${cpu_cores} cores; Aether requires at least ${MIN_BLOCK_CPU_CORES}."
    fi
    if [ "$ram_mb" -lt "$MIN_BLOCK_RAM_MB" ]; then
        fatal "RAM is ${ram_mb} MB; Aether requires at least ${MIN_BLOCK_RAM_MB} MB."
    fi
    if [ "$disk_gb" -lt "$MIN_BLOCK_DISK_GB" ]; then
        fatal "Free disk is ${disk_gb} GB; Aether requires at least ${MIN_BLOCK_DISK_GB} GB."
    fi

    # Advisory minimums.
    [ "$cpu_cores" -ge "$MIN_RECOMMENDED_CPU_CORES" ] || warn "CPU has fewer than ${MIN_RECOMMENDED_CPU_CORES} cores (recommended minimum)."
    [ "$ram_mb" -ge "$MIN_RECOMMENDED_RAM_MB" ] || warn "RAM is less than 4 GB (recommended minimum)."
    if [ "$disk_gb" -lt "$MIN_RECOMMENDED_DISK_GB" ]; then
        warn "Free disk is less than ${MIN_RECOMMENDED_DISK_GB} GB (recommended). Proceeding with ${disk_gb} GB."
        confirm "Continue with less than the recommended free disk space?" || fatal "Aborted by operator."
    fi
}

check_permissions() {
    if [ "$(id -u)" -eq 0 ]; then
        warn "Running as root. A less-privileged user with sudo is recommended; proceeding."
        SUDO=""
        return
    fi
    if command_exists sudo; then
        info "sudo is available"
        SUDO="sudo"
        return
    fi
    fatal "This installer requires root or sudo access. Run as root or install sudo first."
}

# Validates the installation directory per contract §5.1: absolute, under
# /opt or /home, no traversal, not a symlink into a restricted area.
check_install_dir() {
    local dir="$AETHER_INSTALL_DIR"

    case "$dir" in
        /*) ;;
        *) fatal "Installation directory must be an absolute path: $dir" ;;
    esac

    if [[ "$dir" == *..* ]]; then
        fatal "Installation directory must not contain path traversal (..): $dir"
    fi

    case "$dir" in
        /opt/*|/opt|/home/*) ;;
        /etc*|/var*|/usr*|/bin*|/sbin*|/boot*|/root*)
            fatal "Installation directory $dir is inside a restricted system path." ;;
        *)
            fatal "Installation directory must be under /opt or /home, got: $dir" ;;
    esac

    if [ -L "$dir" ]; then
        local target
        target=$(realpath "$dir")
        case "$target" in
            /opt*|/home*) ;;
            *) fatal "Installation directory is a symlink to a restricted location: $dir -> $target" ;;
        esac
    fi

    info "Installation directory accepted: $dir"
}

check_ports() {
    # Contract §4.4: ports 80/443 must be free, or the conflict explained.
    local conflicts=()
    local port

    for port in 80 443; do
        if command_exists ss && ss -ltn "( sport = :$port )" 2>/dev/null | grep -q LISTEN; then
            conflicts+=("$port")
        elif command_exists netstat && netstat -ltn 2>/dev/null | grep -q ":$port "; then
            conflicts+=("$port")
        fi
    done

    if [ ${#conflicts[@]} -eq 0 ]; then
        info "Ports 80 and 443 are available"
        return
    fi

    warn "Port(s) already in use: ${conflicts[*]}"
    if command_exists ss; then
        for port in "${conflicts[@]}"; do
            ss -ltnp "( sport = :$port )" 2>/dev/null | tail -n +2 | sed 's/^/    /'
        done
    fi
    fatal "Stop the service using these port(s) (a web server is usually the cause), or choose to run Aether behind it instead. See docs, section 'Existing web servers'."
}

check_network() {
    if curl -sf --max-time 10 https://github.com >/dev/null 2>&1; then
        info "Internet connectivity confirmed (https://github.com reachable)"
    else
        fatal "No outbound HTTPS connectivity. The installer must reach GitHub and Docker Hub. Check DNS and firewall rules."
    fi
}

check_dns_resolution() {
    # Verify the configured domain resolves to this server's public IP.
    # Failing here means Caddy's ACME challenge will also fail, so abort early.
    local domain="${AETHER_DOMAIN:-}"
    [ -n "$domain" ] || return 0  # domain not yet set; configure stage handles it
    [ "${AETHER_NO_HTTPS:-false}" = "true" ] && return 0 # HTTP-only mode

    local public_ip
    public_ip=$(curl -sf --max-time 5 https://api.ipify.org 2>/dev/null || true)
    if [ -z "$public_ip" ]; then
        warn "Could not determine public IP (https://api.ipify.org unreachable). Skipping DNS check."
        return 0
    fi

    # Resolve domain IP; try dig (dnsutils), then nslookup, then host.
    local server_ip=""
    if command_exists dig; then
        server_ip=$(dig +short "$domain" A 2>/dev/null | head -1 || true)
    elif command_exists nslookup; then
        server_ip=$(nslookup "$domain" 2>/dev/null | awk '/^Address: / {print $2; exit}' || true)
    elif command_exists host; then
        server_ip=$(host "$domain" 2>/dev/null | awk '/has address/ {print $NF; exit}' || true)
    else
        warn "No DNS resolver found (dig/nslookup/host). Install dnsutils. Skipping DNS check."
        return 0
    fi

    if [ -z "$server_ip" ]; then
        fatal "Domain $domain does not resolve to any IP address. Create an A record pointing to $public_ip before retrying."
    fi

    if [ "$server_ip" = "$public_ip" ]; then
        info "DNS check passed: $domain → $server_ip (matches this server)"
    else
        fatal "Domain $domain resolves to $server_ip, but this server's public IP is $public_ip. Update your DNS A record to $public_ip."
    fi
}

check_existing_installation() {
    # Contract §9.1: detect what is already there so install.sh can offer
    # resume / upgrade / repair instead of trampling a live system.
    if [ -f "${AETHER_INSTALL_DIR}/install.state" ]; then
        EXISTING_STATE="${AETHER_INSTALL_DIR}/install.state"
        local status
        status=$(grep '^status=' "$EXISTING_STATE" | tail -1 | cut -d= -f2 || true)
        info "Existing installation detected (status: ${status:-unknown})"
        return 0
    fi
    EXISTING_STATE=""
    return 1
}

run_preflight() {
    info "Running preflight checks…"
    require_command curl
    require_command openssl
    check_platform
    check_init_system
    check_resources
    check_permissions
    check_install_dir
    check_ports
    check_network
    check_existing_installation || true
}

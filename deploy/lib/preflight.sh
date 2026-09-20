#!/usr/bin/env bash
# Aether Cloud OS — preflight checks.
#
# Validates that the target machine meets every requirement before any
# modification is attempted. Unsupported platforms, architectures, and missing
# systemd are BLOCKING, not advisory. Failing early avoids wasted time and
# partial installs that would need to be rolled back.

# Blocking thresholds — below these the installer refuses to run at all.
# RAM is deliberately NOT here: a machine 81 MB short of 2 GB installs and runs
# fine (Docker's memory pressure is soft, and swap covers a build-time spike),
# so a hard RAM floor turned working VPSes away for nothing. It is advisory
# instead — see MIN_RECOMMENDED_RAM_MB below.
MIN_BLOCK_CPU_CORES=1
MIN_BLOCK_DISK_GB=20

# Recommended minimums — below these the installer warns and suggests, but
# never blocks.
MIN_RECOMMENDED_CPU_CORES=2
MIN_RECOMMENDED_RAM_MB=2048
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

    # Real measurements, published for the panel's facts line. os_id is
    # guaranteed "ubuntu" here — a non-Ubuntu id already hit fatal above.
    ui_fact_set platform "Ubuntu ${os_version}"
    ui_fact_set arch "$arch"
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

    # The measured host, published before the hard blocks so the numbers on the
    # panel are exactly the ones tested against the floor below. A host that then
    # fails a floor has its dashboard torn down by fatal(), so a fact is only ever
    # rendered for a host that passed — truthful either way.
    ui_fact_set cpu "${cpu_cores} vCPU"
    ui_fact_set ram "${ram_mb} MB"
    ui_fact_set disk "${disk_gb} GB free"

    # Hard blocks first. RAM is not among them — see below.
    if [ "$cpu_cores" -lt "$MIN_BLOCK_CPU_CORES" ]; then
        fatal "CPU has ${cpu_cores} cores; Aether requires at least ${MIN_BLOCK_CPU_CORES}."
    fi
    if [ "$disk_gb" -lt "$MIN_BLOCK_DISK_GB" ]; then
        fatal "Free disk is ${disk_gb} GB; Aether requires at least ${MIN_BLOCK_DISK_GB} GB."
    fi

    # Advisory minimums.
    [ "$cpu_cores" -ge "$MIN_RECOMMENDED_CPU_CORES" ] || warn "CPU has fewer than ${MIN_RECOMMENDED_CPU_CORES} cores (recommended minimum). Builds and concurrent sessions will be slower."

    # RAM is advisory: warn and recommend, never block. Below ~2 GB the
    # backend still runs, but the frontend build and Docker image builds can be
    # tight — so instead of telling the operator to go add swap, add it. See
    # ensure_swap in utils.sh.
    if [ "$ram_mb" -lt "$MIN_RECOMMENDED_RAM_MB" ]; then
        warn "RAM is ${ram_mb} MB, below the recommended ${MIN_RECOMMENDED_RAM_MB} MB. Proceeding."
        ensure_swap "$ram_mb"
    fi
    if [ "$disk_gb" -lt "$MIN_RECOMMENDED_DISK_GB" ]; then
        # Warn, do not ask. A 20-40 GB disk is the common VPS size and is above
        # the hard floor, so it installs fine; prompting here turned a healthy
        # machine into an aborted install whenever the operator pressed Enter or
        # ran without a terminal to answer on.
        warn "Free disk is ${disk_gb} GB, below the recommended ${MIN_RECOMMENDED_DISK_GB} GB. Proceeding."
        warn "Keep an eye on usage: aether backup archives accumulate under ${AETHER_INSTALL_DIR}/backups."
    fi

    # The deployment profile's resource verdict, from the numbers measured above
    # and the same three thresholds the warnings used, so the panel cannot call a
    # host resource-constrained that this function judged healthy, or the reverse.
    #
    # Nothing is published when the host meets the recommended minimums. The
    # measured numbers are on the facts line already, and a bullet that appears
    # only when something is tight reads as exactly what it is; a standing "meets
    # recommended resources" would spend the line's width saying nothing. It is
    # published first among the profile items because the line truncates on a
    # narrow terminal and this is the one item that changes what to expect.
    if [ "$cpu_cores" -lt "$MIN_RECOMMENDED_CPU_CORES" ] ||
        [ "$ram_mb" -lt "$MIN_RECOMMENDED_RAM_MB" ] ||
        [ "$disk_gb" -lt "$MIN_RECOMMENDED_DISK_GB" ]; then
        ui_profile_set resources "Constrained VPS"
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

    local listening
    for port in 80 443; do
        # Each listing is read into a variable and tested without a pipeline.
        # The match is near the start of output that can run to thousands of
        # lines, which is exactly where `| grep -q` reports failure: see
        # `matches` in core.sh.
        if command_exists ss; then
            listening=$(ss -ltn "( sport = :$port )" 2>/dev/null || true)
            if matches "$listening" "LISTEN"; then
                conflicts+=("$port")
                continue
            fi
        fi

        if command_exists netstat; then
            listening=$(netstat -ltn 2>/dev/null || true)
            if matches "$listening" ":$port "; then
                conflicts+=("$port")
            fi
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
    fatal "Stop the service using these port(s) (a web server is usually the cause), or choose to run Aether behind it instead. See docs/operations/DEPLOYMENT.md."
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
    #
    # This warns rather than aborts. A mismatch is not proof the install cannot
    # work: a domain behind Cloudflare (or any proxy/CDN) correctly resolves to
    # the proxy's address, and split-horizon DNS resolves differently inside the
    # network. Aborting here would strand exactly those operators mid-install,
    # after the interactive prompt already gave them the choice to skip this
    # check. Caddy reports a genuine ACME failure clearly at deploy time, which
    # is the honest place to surface it.
    local domain="${AETHER_DOMAIN:-}"
    [ -n "$domain" ] || return 0  # domain not yet set; configure stage handles it
    [ "${AETHER_NO_HTTPS:-false}" = "true" ] && return 0 # HTTP-only mode
    [ "${AETHER_SKIP_DNS_CHECK:-false}" = "true" ] && {
        info "DNS check skipped at the operator's request."
        return 0
    }

    local public_ip
    public_ip=$(curl -sf --max-time 5 https://api.ipify.org 2>/dev/null || true)
    if [ -z "$public_ip" ]; then
        warn "Could not determine public IP (https://api.ipify.org unreachable). Skipping DNS check."
        return 0
    fi

    # Resolve the domain with the first tool that yields an answer. The chain
    # falls through on an empty result, not just on a missing binary: `dig` is
    # installed yet returns nothing for a name that only the system resolver
    # (e.g. an /etc/hosts entry) can resolve, and getent covers that case.
    local server_ip=""
    if command_exists dig; then
        server_ip=$(dig +short "$domain" A 2>/dev/null | head -1 || true)
    fi
    if [ -z "$server_ip" ] && command_exists nslookup; then
        server_ip=$(nslookup "$domain" 2>/dev/null | awk '/^Address: / {print $2; exit}' || true)
    fi
    if [ -z "$server_ip" ] && command_exists host; then
        server_ip=$(host "$domain" 2>/dev/null | awk '/has address/ {print $NF; exit}' || true)
    fi
    if [ -z "$server_ip" ] && command_exists getent; then
        server_ip=$(getent ahostsv4 "$domain" 2>/dev/null | awk '{print $1; exit}' || true)
    fi

    if [ -z "$server_ip" ]; then
        warn "Domain $domain does not resolve to any IP address."
        warn "Create an A record pointing to $public_ip, or HTTPS will fail."
        return 0
    fi

    if [ "$server_ip" = "$public_ip" ]; then
        info "DNS check passed: $domain → $server_ip (matches this server)"
    else
        warn "Domain $domain resolves to $server_ip, but this server's public IP is $public_ip."
        warn "This is expected behind a proxy/CDN (e.g. Cloudflare), and HTTPS still works there."
        warn "If it is not intentional, point the A record at $public_ip."
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
    # PRECHECK is a sequence of heterogeneous, sub-second gates, not a uniform
    # set being iterated — there is no honest denominator here, so there is no
    # progress bar. Each note names the check about to run; the indeterminate bar
    # and the live elapsed clock carry the rest. A blocking check calls fatal(),
    # which exits, so the EXIT trap marks this stage FAILED with the real reason.
    ui_stage_begin_notify PRECHECK "Preflight checks"
    info "Running preflight checks…"

    ui_note PRECHECK "Verifying required tools (curl, openssl)"
    require_command curl
    require_command openssl

    ui_note PRECHECK "Checking OS and architecture"
    check_platform

    ui_note PRECHECK "Checking init system"
    check_init_system

    ui_note PRECHECK "Measuring CPU, memory and disk"
    check_resources

    # Not a measurement: this installer brings the entire stack — backend,
    # frontend, PostgreSQL, Redis, Caddy and the host agent — up as containers on
    # the machine it runs on, so every install it produces is single-node. It is
    # published rather than assumed because the panel is describing the
    # deployment, and it is published after check_resources so the resource
    # verdict, when there is one, comes first on a truncating line.
    ui_profile_set topology "Single-node"

    ui_note PRECHECK "Checking privileges"
    check_permissions

    ui_note PRECHECK "Validating install directory"
    check_install_dir

    ui_note PRECHECK "Checking ports 80 and 443"
    check_ports

    ui_note PRECHECK "Testing outbound HTTPS connectivity"
    check_network

    ui_note PRECHECK "Checking for an existing installation"
    check_existing_installation || true

    ui_stage_done_notify PRECHECK "host meets requirements"
}

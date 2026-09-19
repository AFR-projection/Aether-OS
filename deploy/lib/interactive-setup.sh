#!/usr/bin/env bash
# Aether Cloud OS — Interactive installation setup.
#
# Prompts user for domain, validates DNS, creates master account credentials,
# then proceeds with full installation.
#
# Note: validate_domain and validate_email are defined in configure.sh
# which is sourced by install.sh before this file.

# DNS validation: check if domain resolves to this VPS's IP
validate_dns_points_to_vps() {
    local domain="$1"
    local vps_ip

    # Get VPS public IP
    vps_ip=$(curl -sf --max-time 5 https://api.ipify.org 2>/dev/null || \
             curl -sf --max-time 5 https://icanhazip.com 2>/dev/null || \
             curl -sf --max-time 5 https://ifconfig.me 2>/dev/null || true)

    if [ -z "$vps_ip" ]; then
        warn "Could not detect VPS public IP. Skipping DNS validation."
        return 0
    fi

    info "Detected VPS IP: $vps_ip"
    info "Checking if $domain resolves to $vps_ip..."

    # Resolve the domain with whichever tool this host has. The prompts run
    # before the dependency stage installs dnsutils, so `dig` and `host` are
    # typically absent on a fresh VPS; `getent ahostsv4` ships with glibc and is
    # therefore the one that actually works here. Without this fallback every
    # domain entry would be reported as a DNS failure on a clean machine.
    local resolved_ip="" resolver=""
    if command -v dig >/dev/null 2>&1; then
        resolver="dig"
        resolved_ip=$(dig +short "$domain" A 2>/dev/null | head -n1 || true)
    fi
    if [ -z "$resolved_ip" ] && command -v host >/dev/null 2>&1; then
        resolver="host"
        resolved_ip=$(host "$domain" 2>/dev/null | grep "has address" | awk '{print $NF}' | head -n1 || true)
    fi
    if [ -z "$resolved_ip" ] && command -v getent >/dev/null 2>&1; then
        resolver="getent"
        resolved_ip=$(getent ahostsv4 "$domain" 2>/dev/null | awk '{print $1}' | head -n1 || true)
    fi

    if [ -z "$resolver" ]; then
        warn "No DNS lookup tool is available yet (dig/host/getent). Skipping DNS validation."
        warn "If TLS fails later, confirm the A record for $domain points to $vps_ip."
        return 0
    fi

    # A resolver that ran but returned nothing is a genuine "not found": the
    # domain has no A record. Distinguish it from "no tool", which is not the
    # user's fault and must not block the install.
    if [ -z "$resolved_ip" ]; then
        error "DNS lookup failed for $domain (checked with $resolver)"
        error ""
        error "Please ensure:"
        error "  1. DNS A record for $domain points to $vps_ip"
        error "  2. DNS propagation is complete (may take up to 48 hours)"
        error "  3. You can verify with: dig $domain +short"
        error ""
        return 1
    fi

    # A domain behind Cloudflare (or any proxy) resolves to the proxy's address,
    # not this VPS. That is a working setup for TLS — the proxy terminates and
    # forwards — so treat "resolves to something else" as a warning the operator
    # can accept, not a hard failure.
    if [ "$resolved_ip" = "$vps_ip" ]; then
        info "✓ DNS validation passed: $domain → $vps_ip"
        return 0
    fi

    warn "DNS check: $domain resolves to $resolved_ip, but this VPS is $vps_ip"
    return 1
}

# Validate username: alphanumeric, underscore, dash, 3-32 chars
validate_username() {
    local username="$1"

    if [ -z "$username" ]; then
        echo "Username cannot be empty"
        return 1
    fi

    if [ "${#username}" -lt 3 ]; then
        echo "Username must be at least 3 characters"
        return 1
    fi

    if [ "${#username}" -gt 32 ]; then
        echo "Username must be at most 32 characters"
        return 1
    fi

    if [[ ! "$username" =~ ^[a-zA-Z0-9_-]+$ ]]; then
        echo "Username can only contain letters, numbers, underscore, and dash"
        return 1
    fi

    # Must start and end with a letter or number. The database stores usernames
    # lowercase and enforces this same shape (users_username_format); rejecting
    # it here gives a clear message instead of a database error mid-install.
    if [[ ! "$username" =~ ^[a-zA-Z0-9].*[a-zA-Z0-9]$ ]] && [[ ! "$username" =~ ^[a-zA-Z0-9]$ ]]; then
        echo "Username must start and end with a letter or number"
        return 1
    fi

    return 0
}

# Validate password: minimum 8 chars, at least one letter and one number
validate_password() {
    local password="$1"

    if [ -z "$password" ]; then
        echo "Password cannot be empty"
        return 1
    fi

    if [ "${#password}" -lt 8 ]; then
        echo "Password must be at least 8 characters"
        return 1
    fi

    if [[ ! "$password" =~ [a-zA-Z] ]]; then
        echo "Password must contain at least one letter"
        return 1
    fi

    if [[ ! "$password" =~ [0-9] ]]; then
        echo "Password must contain at least one number"
        return 1
    fi

    return 0
}

# Interactive prompt for domain with DNS validation
prompt_domain() {
    printf '\n'
    printf '═══════════════════════════════════════════════════════════════\n'
    printf '  DOMAIN CONFIGURATION\n'
    printf '═══════════════════════════════════════════════════════════════\n'
    printf '\n'
    printf 'If you have a domain, please configure DNS FIRST:\n'
    printf '  1. Create an A record pointing to your VPS IP\n'
    printf '  2. Wait for DNS propagation (5-30 minutes)\n'
    printf '  3. Verify with: dig yourdomain.com +short\n'
    printf '\n'
    printf 'If you do not have a domain, press Enter to use IP-only mode.\n'
    printf '\n'

    while true; do
        printf 'Enter your domain (or press Enter for IP-only): '
        read -r domain || true

        # Empty = IP-only mode
        if [ -z "$domain" ]; then
            info "IP-only mode selected. Installation will use HTTP."
            AETHER_DOMAIN=""
            AETHER_ADMIN_EMAIL=""
            AETHER_NO_HTTPS="true"
            export AETHER_DOMAIN AETHER_ADMIN_EMAIL AETHER_NO_HTTPS
            return 0
        fi

        # Validate domain format
        local validation_error
        if ! validation_error=$(validate_domain "$domain" 2>&1); then
            error "$validation_error"
            continue
        fi

        # Validate DNS
        if ! validate_dns_points_to_vps "$domain"; then
            printf '\n'
            printf 'DNS validation failed. Options:\n'
            printf '  r - Retry validation\n'
            printf '  s - Skip validation (not recommended)\n'
            printf '  c - Change domain\n'
            printf '  i - Use IP-only mode instead\n'
            printf '\n'
            printf 'Choose [r/s/c/i]: '
            read -r choice || true

            case "$choice" in
                r|R) continue ;;
                s|S)
                    warn "Skipping DNS validation. HTTPS may fail if DNS is not configured correctly."
                    # Remembered so the configure stage's own DNS check honours
                    # this choice instead of aborting the install the operator
                    # just told us to continue past.
                    #
                    # Deliberately no `break`: break leaves the `while`, not the
                    # `case`, which would skip the email prompt and the
                    # AETHER_DOMAIN assignment below and return with nothing set
                    # — turning an accepted domain into an IP-only install.
                    AETHER_SKIP_DNS_CHECK="true"
                    export AETHER_SKIP_DNS_CHECK
                    ;;
                c|C) continue ;;
                i|I)
                    info "Switching to IP-only mode."
                    AETHER_DOMAIN=""
                    AETHER_ADMIN_EMAIL=""
                    AETHER_NO_HTTPS="true"
                    export AETHER_DOMAIN AETHER_ADMIN_EMAIL AETHER_NO_HTTPS
                    return 0
                    ;;
                *)
                    error "Invalid choice. Retrying DNS validation..."
                    continue
                    ;;
            esac
        fi

        # DNS valid or skipped
        printf '\n'
        printf 'Enter admin email for Let'\''s Encrypt certificate notices: '
        read -r email || true

        if [ -z "$email" ]; then
            email="admin@$domain"
            info "Using default email: $email"
        fi

        if ! validate_email "$email"; then
            error "Invalid email format"
            continue
        fi

        AETHER_DOMAIN="$domain"
        AETHER_ADMIN_EMAIL="$email"
        AETHER_NO_HTTPS="false"
        export AETHER_DOMAIN AETHER_ADMIN_EMAIL AETHER_NO_HTTPS
        info "✓ Domain configured: $domain (HTTPS mode)"
        return 0
    done
}

# Interactive prompt for master account credentials
prompt_master_account() {
    printf '\n'
    printf '═══════════════════════════════════════════════════════════════\n'
    printf '  MASTER ACCOUNT SETUP\n'
    printf '═══════════════════════════════════════════════════════════════\n'
    printf '\n'
    printf 'Create the master administrator account.\n'
    printf 'This account will have full access to Aether Cloud OS.\n'
    printf '\n'

    # Prompt username
    while true; do
        printf 'Master username (3-32 chars, alphanumeric): '
        read -r username || true

        local validation_error
        if validation_error=$(validate_username "$username" 2>&1); then
            break
        else
            error "$validation_error"
        fi
    done

    # Prompt password (with confirmation)
    while true; do
        printf 'Master password (min 8 chars, must have letter + number): '
        read -rs password || true
        printf '\n'

        local validation_error
        if ! validation_error=$(validate_password "$password" 2>&1); then
            error "$validation_error"
            continue
        fi

        printf 'Confirm password: '
        read -rs password_confirm || true
        printf '\n'

        if [ "$password" != "$password_confirm" ]; then
            error "Passwords do not match. Try again."
            continue
        fi

        break
    done

    AETHER_MASTER_USERNAME="$username"
    AETHER_MASTER_PASSWORD="$password"
    export AETHER_MASTER_USERNAME AETHER_MASTER_PASSWORD

    info "✓ Master account configured: $username"
    printf '\n'
}

# Interactive prompt for host agent scope (full filesystem vs confined).
prompt_host_access() {
    # An explicit --full-host-access / --no-full-host-access already decided
    # this; do not second-guess a flag the operator passed on purpose.
    if [ -n "${AETHER_FULL_HOST_ACCESS_EXPLICIT:-}" ]; then
        info "Host access already set by flag (full=${AETHER_FULL_HOST_ACCESS}); skipping the prompt."
        return 0
    fi

    printf '\n'
    printf '═══════════════════════════════════════════════════════════════\n'
    printf '  HOST FILESYSTEM ACCESS\n'
    printf '═══════════════════════════════════════════════════════════════\n'
    printf '\n'
    printf 'Aether can manage this whole machine so every file on the VPS shows\n'
    printf 'up in the Files app and Terminal — the real-computer experience.\n'
    printf '\n'
    printf '  Full access (recommended for a personal VPS):\n'
    printf '    The host agent runs as root over the entire filesystem. Anyone\n'
    printf '    who logs in as owner can read and write ALL files through the\n'
    printf '    GUI, including /etc, SSH keys, and other sensitive data.\n'
    printf '\n'
    printf '  Confined:\n'
    printf '    The agent runs unprivileged and only sees its workspace folder.\n'
    printf '\n'

    printf 'Enable full host access? [Y/n]: '
    local answer=""
    read -r answer || true
    case "$answer" in
        [Nn]*)
            AETHER_FULL_HOST_ACCESS="false"
            info "Host access: CONFINED (workspace only)"
            ;;
        *)
            AETHER_FULL_HOST_ACCESS="true"
            info "Host access: FULL (root, whole filesystem)"
            ;;
    esac
    export AETHER_FULL_HOST_ACCESS
    printf '\n'
}

# Run interactive setup
run_interactive_setup() {
    # Skip if --yes flag or non-interactive
    if [ "${AETHER_YES:-false}" = "true" ] || [ ! -t 0 ]; then
        info "Non-interactive mode: skipping prompts"
        return 0
    fi

    # A domain supplied through --domain, or through the environment, is a
    # decision already made. Re-prompting would let a bare Enter silently
    # replace a requested HTTPS install with IP-only HTTP — which is exactly
    # what configure.sh promises not to do.
    if [ -n "${AETHER_DOMAIN:-}" ]; then
        info "Domain already configured (${AETHER_DOMAIN}); skipping the domain prompt."
    else
        prompt_domain
    fi

    prompt_master_account
    prompt_host_access
}

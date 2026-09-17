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

    # Resolve domain to IP
    local resolved_ip
    resolved_ip=$(dig +short "$domain" A 2>/dev/null | head -n1 || \
                  host "$domain" 2>/dev/null | grep "has address" | awk '{print $NF}' | head -n1 || true)

    if [ -z "$resolved_ip" ]; then
        error "DNS lookup failed for $domain"
        error ""
        error "Please ensure:"
        error "  1. DNS A record for $domain points to $vps_ip"
        error "  2. DNS propagation is complete (may take up to 48 hours)"
        error "  3. You can verify with: dig $domain +short"
        error ""
        return 1
    fi

    if [ "$resolved_ip" = "$vps_ip" ]; then
        info "✓ DNS validation passed: $domain → $vps_ip"
        return 0
    else
        error "DNS mismatch!"
        error "  Domain $domain resolves to: $resolved_ip"
        error "  But VPS IP is: $vps_ip"
        error ""
        error "Please update your DNS A record to point to $vps_ip"
        error "Then wait for DNS propagation (5-30 minutes typically)"
        return 1
    fi
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

    if [[ "$username" =~ ^[0-9] ]]; then
        echo "Username cannot start with a number"
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
                    break
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

# Run interactive setup
run_interactive_setup() {
    # Skip if --yes flag or non-interactive
    if [ "${AETHER_YES:-false}" = "true" ] || [ ! -t 0 ]; then
        info "Non-interactive mode: skipping prompts"
        return 0
    fi

    prompt_domain
    prompt_master_account
}

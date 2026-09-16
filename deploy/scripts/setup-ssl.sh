#!/usr/bin/env bash
# Aether Cloud OS — SSL setup.
#
# Configures SSL certificates for the Aether Cloud OS installation.

set -euo pipefail

# Source utility functions
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/../lib/core.sh"
source "$SCRIPT_DIR/../lib/utils.sh"

# Default configuration
AETHER_DOMAIN="${AETHER_DOMAIN:-}"
AETHER_EMAIL="${AETHER_EMAIL:-}"
AETHER_SSL_DIR="${AETHER_SSL_DIR:-/opt/aether/ssl}"

# ---------------------------------------------------------------------------
# SSL setup
# ---------------------------------------------------------------------------
setup_ssl() {
    stage "Setting up SSL certificates"
    info "SSL directory: $AETHER_SSL_DIR"

    # Create SSL directory
    create_directory "$AETHER_SSL_DIR"

    # Check if certificates already exist
    if [ -f "$AETHER_SSL_DIR/cert.pem" ] && [ -f "$AETHER_SSL_DIR/key.pem" ]; then
        info "SSL certificates already exist"
        return
    fi

    # Install certbot
    install_certbot

    # Obtain certificates
    obtain_certificates

    # Configure auto-renewal
    configure_auto_renewal

    info "SSL setup completed successfully"
}

install_certbot() {
    info "Installing certbot"

    sudo apt-get update
    sudo apt-get install -y certbot python3-certbot-nginx

    info "Certbot installed successfully"
}

obtain_certificates() {
    if [ -z "$AETHER_DOMAIN" ]; then
        fatal "AETHER_DOMAIN environment variable is not set"
    fi

    if [ -z "$AETHER_EMAIL" ]; then
        fatal "AETHER_EMAIL environment variable is not set"
    fi

    info "Obtaining SSL certificates for $AETHER_DOMAIN"

    sudo certbot certonly --standalone \
        -d "$AETHER_DOMAIN" \
        --email "$AETHER_EMAIL" \
        --agree-tos \
        --non-interactive

    # Copy certificates to Aether SSL directory
    sudo cp "/etc/letsencrypt/live/$AETHER_DOMAIN/fullchain.pem" "$AETHER_SSL_DIR/cert.pem"
    sudo cp "/etc/letsencrypt/live/$AETHER_DOMAIN/privkey.pem" "$AETHER_SSL_DIR/key.pem"
    sudo chown "$USER:$USER" "$AETHER_SSL_DIR/cert.pem" "$AETHER_SSL_DIR/key.pem"

    info "SSL certificates obtained successfully"
}

configure_auto_renewal() {
    local cron_job="/etc/cron.d/aether-ssl-renew"

    if [ -f "$cron_job" ]; then
        info "Auto-renewal cron job already exists"
        return
    fi

    info "Configuring SSL auto-renewal"
    sudo bash -c "cat > $cron_job <<EOL
# Aether SSL certificate auto-renewal
0 0 1 * * root certbot renew --quiet && systemctl reload nginx
EOL"

    info "SSL auto-renewal configured successfully"
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if [ "$0" = "$BASH_SOURCE" ]; then
    setup_ssl
fi

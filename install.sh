#!/usr/bin/env bash
# Aether Cloud OS — one-command installer.
#
# Target usage:
#   curl -fsSL https://<install-domain>/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/AFR-projection/Aether-OS/main/install.sh | bash
#
# When run from a repo checkout (the common dev path) it sources the installer
# libraries straight from ./deploy/lib. When piped from a remote host with no
# checkout it must have the libraries in the same directory — the release
# packaging step copies deploy/lib next to install.sh, so this works for both
# curl|bash and local runs without special-casing.
#
# All flags forward to the orchestrator; see deploy/lib/install.sh header.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -f "$SCRIPT_DIR/deploy/lib/install.sh" ]; then
    # Piped (curl|bash) with no checkout: libraries sit next to this script.
    if [ -f "$SCRIPT_DIR/install.sh" ]; then
        exec "$SCRIPT_DIR/install.sh" "$@"
    fi
    echo "Aether installer: could not find deploy/lib/install.sh in $SCRIPT_DIR." >&2
    echo "Run from a checkout of the repo, or use a properly packaged release." >&2
    exit 1
fi

exec "$SCRIPT_DIR/deploy/lib/install.sh" "$@"

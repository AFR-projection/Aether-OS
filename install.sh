#!/usr/bin/env bash
# Aether Cloud OS — one-command installer.
#
# Target usage:
#   curl -fsSL https://<install-domain>/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/AFR-projection/Aether-OS/main/install.sh | bash
#
# When run from a repo checkout the libraries live in ./deploy/lib. When
# packaged for remote install they are copied next to this file. We detect
# which layout we are in by looking for deploy/lib/install.sh relative to
# this script.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "$SCRIPT_DIR/deploy/lib/install.sh" ]; then
    # Repo checkout: source from deploy/lib
    exec "$SCRIPT_DIR/deploy/lib/install.sh" "$@"
fi

echo "Aether installer: could not find deploy/lib/install.sh." >&2
echo "Run this from a clone of the repo, or use the official packaged installer." >&2
exit 1

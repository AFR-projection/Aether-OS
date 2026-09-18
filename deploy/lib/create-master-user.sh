#!/usr/bin/env bash
# Aether Cloud OS — Create master user in database.
#
# Creates the first administrator account directly in the database during
# installation, eliminating the need for bootstrap token flow in the UI.
#
# Prerequisites: compose_cmd, info, error, warn functions from utils.sh/core.sh

create_master_user() {
    local username="$1"
    local password="$2"

    if [ -z "$username" ] || [ -z "$password" ]; then
        error "Master username and password required"
        return 1
    fi

    info "Creating master user in database: $username"

    # Verify docker compose is available
    if ! command -v docker >/dev/null 2>&1; then
        error "Docker not found. Cannot create master user."
        return 1
    fi

    # Wait for backend container to be ready
    info "Waiting for backend container to be ready..."
    local attempts=60
    local wait_interval=3
    while [ "$attempts" -gt 0 ]; do
        if compose_cmd -f "$AETHER_INSTALL_DIR/docker-compose.yml" \
            exec -T backend node -e "process.exit(0)" >/dev/null 2>&1; then
            break
        fi
        attempts=$((attempts - 1))
        sleep "$wait_interval"
    done

    if [ "$attempts" -eq 0 ]; then
        error "Backend container not ready after 3 minutes"
        error "Check logs: docker compose -f $AETHER_INSTALL_DIR/docker-compose.yml logs backend"
        return 1
    fi

    info "Backend container ready. Creating user..."

    # Generate user ID
    local user_id=""
    if [ -f /proc/sys/kernel/random/uuid ]; then
        user_id=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || true)
    fi
    if [ -z "$user_id" ] && command -v uuidgen >/dev/null 2>&1; then
        user_id=$(uuidgen 2>/dev/null || true)
    fi
    if [ -z "$user_id" ] && command -v node >/dev/null 2>&1; then
        user_id=$(node -e "console.log(require('crypto').randomUUID())" 2>/dev/null || true)
    fi

    if [ -z "$user_id" ]; then
        error "Could not generate UUID for master user"
        error "Tried: /proc/sys/kernel/random/uuid, uuidgen, node crypto"
        return 1
    fi

    # Create user via inline Node.js script in backend container
    # Password is passed as env var (safer than command line args)
    local create_output
    if create_output=$(compose_cmd -f "$AETHER_INSTALL_DIR/docker-compose.yml" \
        exec -T \
        -e MASTER_USERNAME="$username" \
        -e MASTER_PASSWORD="$password" \
        -e MASTER_USER_ID="$user_id" \
        backend node -e "
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const username = process.env.MASTER_USERNAME;
const password = process.env.MASTER_PASSWORD;
const userId = process.env.MASTER_USER_ID;

if (!username || !password || !userId) {
  console.error('ERROR: Missing required environment variables');
  process.exit(1);
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    // Hash password with bcrypt (cost 10)
    const passwordHash = await bcrypt.hash(password, 10);

    // Insert user into database
    const result = await pool.query(
      \`INSERT INTO aether.users (id, username, password_hash, role, created_at, updated_at)
       VALUES (\\\$1, \\\$2, \\\$3, \\\$4, NOW(), NOW())
       ON CONFLICT (username) DO UPDATE
       SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, updated_at = NOW()
       RETURNING id, username, role\`,
      [userId, username, passwordHash, 'admin']
    );

    console.log('SUCCESS: Master user created -', result.rows[0].username, '- role:', result.rows[0].role);
    process.exit(0);
  } catch (error) {
    console.error('ERROR: Failed to create user -', error.message);
    if (error.code) console.error('ERROR: Database error code:', error.code);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
" 2>&1); then
        # Success
        if echo "$create_output" | grep -q "SUCCESS:"; then
            info "✓ Master user created successfully: $username"
        else
            info "✓ Master user created: $username"
        fi

        # Store credentials metadata securely (NOT the password)
        local creds_file="$AETHER_INSTALL_DIR/state/master-credentials.json"
        mkdir -p "$(dirname "$creds_file")"
        umask 077
        cat > "$creds_file" <<EOF
{
  "username": "$username",
  "userId": "$user_id",
  "role": "admin",
  "createdAt": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "method": "installer"
}
EOF
        chmod 600 "$creds_file"

        return 0
    else
        # Failure
        error "Failed to create master user in database"
        error "Output:"
        echo "$create_output" | sed 's/^/  /' >&2
        error ""
        error "Possible causes:"
        error "  - Database not ready (check: docker compose logs postgres)"
        error "  - Migration not applied (check: docker compose logs backend)"
        error "  - Username already exists with different password"
        error ""
        warn "You can create the owner account via UI using bootstrap token"
        return 1
    fi
}

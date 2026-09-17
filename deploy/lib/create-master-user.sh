#!/usr/bin/env bash
# Aether Cloud OS — Create master user in database.
#
# Creates the first administrator account directly in the database during
# installation, eliminating the need for bootstrap token flow in the UI.

create_master_user() {
    local username="$1"
    local password="$2"

    if [ -z "$username" ] || [ -z "$password" ]; then
        error "Master username and password required"
        return 1
    fi

    info "Creating master user in database: $username"

    # Wait for backend to be ready (migrations applied)
    local attempts=60
    while [ "$attempts" -gt 0 ]; do
        if compose_cmd -f "$AETHER_INSTALL_DIR/docker-compose.yml" \
            exec -T backend node -e "process.exit(0)" >/dev/null 2>&1; then
            break
        fi
        attempts=$((attempts - 1))
        sleep 2
    done

    if [ "$attempts" -eq 0 ]; then
        error "Backend container not ready after 2 minutes"
        return 1
    fi

    # Generate user ID
    local user_id
    user_id=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || \
              node -e "console.log(require('crypto').randomUUID())" 2>/dev/null || \
              uuidgen 2>/dev/null || echo "")

    if [ -z "$user_id" ]; then
        error "Could not generate UUID for master user"
        return 1
    fi

    # Create user via inline Node.js script in backend container
    # Password is passed as env var, never in command line
    if compose_cmd -f "$AETHER_INSTALL_DIR/docker-compose.yml" \
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
  console.error('Missing required environment variables');
  process.exit(1);
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const passwordHash = await bcrypt.hash(password, 10);
    await pool.query(
      \`INSERT INTO aether.users (id, username, password_hash, role, created_at, updated_at)
       VALUES (\\\$1, \\\$2, \\\$3, \\\$4, NOW(), NOW())
       ON CONFLICT (username) DO UPDATE
       SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role\`,
      [userId, username, passwordHash, 'admin']
    );
    console.log('Master user created:', username);
    process.exit(0);
  } catch (error) {
    console.error('Failed to create user:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
" 2>&1; then
        info "✓ Master user created: $username"

        # Store credentials metadata securely (NOT the password)
        local creds_file="$AETHER_INSTALL_DIR/state/master-credentials.json"
        mkdir -p "$(dirname "$creds_file")"
        umask 077
        cat > "$creds_file" <<EOF
{
  "username": "$username",
  "userId": "$user_id",
  "createdAt": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
}
EOF
        chmod 600 "$creds_file"

        return 0
    else
        error "Failed to create master user"
        return 1
    fi
}

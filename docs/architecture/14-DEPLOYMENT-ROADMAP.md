# AETHER CLOUD OS - DEPLOYMENT, OPERATIONS & ROADMAP

**Part of:** Comprehensive Architecture Document  
**Version:** 1.0.0  
**Date:** 2026-09-15

---

## 14. DEPLOYMENT & OPERATIONS

### 14.1 Deployment Architecture

Target deployment on Ubuntu LTS VPS.

```
┌─────────────────────────────────────────────────────────────┐
│                         INTERNET                             │
└────────────────────────┬─────────────────────────────────────┘
                         │
                         │ HTTPS (443)
                         │
┌────────────────────────┴─────────────────────────────────────┐
│                    NGINX (Reverse Proxy)                     │
│  ├─ SSL/TLS Termination (Let's Encrypt)                     │
│  ├─ Load Balancing (if multiple instances)                  │
│  ├─ Static Asset Serving                                    │
│  ├─ WebSocket Proxy                                         │
│  └─ Rate Limiting                                           │
└────────────────────────┬─────────────────────────────────────┘
                         │
         ┌───────────────┼───────────────┐
         │               │               │
    /:app/*         /api/*          /ws/*
         │               │               │
┌────────┴────────┐ ┌────┴──────┐ ┌─────┴──────┐
│  Frontend SPA   │ │  Backend  │ │ WebSocket  │
│  (Static Files) │ │  Server   │ │   Server   │
└─────────────────┘ └────┬──────┘ └─────┬──────┘
                         │               │
         ┌───────────────┼───────────────┤
         │               │               │
    PostgreSQL        Redis         S3/MinIO
         │               │               │
         └───────────────┴───────────────┘

┌─────────────────────────────────────────────────────────────┐
│                   AETHER HOST AGENT                          │
│  (Same or different machine)                                 │
│  ├─ Secure WebSocket to Backend                             │
│  └─ PTY, Filesystem, Process management                     │
└─────────────────────────────────────────────────────────────┘
```

### 14.2 System Requirements

#### Minimum VPS Requirements (MVP)

**For Backend Server:**

- OS: Ubuntu 22.04 LTS or 24.04 LTS
- CPU: 2 vCPU cores
- RAM: 4 GB
- Storage: 20 GB SSD
- Network: 100 Mbps

**For Host Agent:**

- OS: Ubuntu 22.04+ / Debian 11+ / CentOS 8+ / Windows 10+ / macOS 12+
- CPU: 1 vCPU core
- RAM: 512 MB (dedicated to agent)
- Storage: 200 MB
- Network: Any

#### Recommended Production Requirements

**For Backend Server (10-50 users):**

- OS: Ubuntu 24.04 LTS
- CPU: 4 vCPU cores
- RAM: 8 GB
- Storage: 100 GB SSD
- Network: 1 Gbps
- Backup storage: Additional volume for PostgreSQL backups

**For Host Agent:**

- Same as minimum

#### Software Dependencies

**Backend Server:**

- Node.js 20 LTS
- PostgreSQL 16+
- Redis 7+
- nginx 1.24+
- certbot (Let's Encrypt)
- PM2 or systemd for process management

**Host Agent:**

- Node.js 20 LTS (or bundled runtime)

### 14.3 Installation Script

Automated installer for Ubuntu VPS.

```bash
#!/bin/bash
# install-aether.sh

set -e  # Exit on error

echo "=========================================="
echo "  Aether Cloud OS Installer"
echo "  Version: 1.0.0"
echo "=========================================="
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "Error: Please run as root (use sudo)"
  exit 1
fi

# Check OS
if [ ! -f /etc/os-release ]; then
  echo "Error: Cannot detect OS"
  exit 1
fi

source /etc/os-release
echo "Detected OS: $NAME $VERSION"

if [[ "$ID" != "ubuntu" ]] && [[ "$ID" != "debian" ]]; then
  echo "Warning: This installer is tested on Ubuntu/Debian only"
  read -p "Continue anyway? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

# Check system resources
echo ""
echo "Checking system resources..."

CPU_CORES=$(nproc)
TOTAL_RAM=$(free -m | awk '/^Mem:/{print $2}')
DISK_SPACE=$(df -m / | awk 'NR==2 {print $4}')

echo "  CPU cores: $CPU_CORES"
echo "  RAM: ${TOTAL_RAM}MB"
echo "  Available disk: ${DISK_SPACE}MB"

if [ "$CPU_CORES" -lt 2 ]; then
  echo "Warning: Less than 2 CPU cores detected"
fi

if [ "$TOTAL_RAM" -lt 3500 ]; then
  echo "Warning: Less than 4GB RAM detected"
fi

if [ "$DISK_SPACE" -lt 15000 ]; then
  echo "Error: Less than 15GB free disk space"
  exit 1
fi

echo ""
read -p "Continue with installation? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  exit 0
fi

# Update system
echo ""
echo "Updating system packages..."
apt-get update -qq
apt-get upgrade -y -qq

# Install dependencies
echo ""
echo "Installing dependencies..."
apt-get install -y -qq \
  curl \
  wget \
  git \
  build-essential \
  nginx \
  certbot \
  python3-certbot-nginx

# Install Node.js 20
echo ""
echo "Installing Node.js 20..."
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

NODE_VERSION=$(node -v)
echo "  Node.js version: $NODE_VERSION"

# Install PostgreSQL
echo ""
echo "Installing PostgreSQL..."
if ! command -v psql &> /dev/null; then
  apt-get install -y postgresql postgresql-contrib
  systemctl enable postgresql
  systemctl start postgresql
fi

# Install Redis
echo ""
echo "Installing Redis..."
if ! command -v redis-cli &> /dev/null; then
  apt-get install -y redis-server
  systemctl enable redis-server
  systemctl start redis-server
fi

# Create aether user
echo ""
echo "Creating aether system user..."
if ! id "aether" &>/dev/null; then
  useradd -r -m -d /opt/aether -s /bin/bash aether
fi

# Download and extract Aether
echo ""
echo "Downloading Aether Cloud OS..."
AETHER_VERSION="1.0.0"
DOWNLOAD_URL="https://releases.aether-os.io/v${AETHER_VERSION}/aether-cloud-os.tar.gz"

cd /opt/aether
sudo -u aether wget -q "$DOWNLOAD_URL" -O aether.tar.gz
sudo -u aether tar -xzf aether.tar.gz
rm aether.tar.gz

# Install npm dependencies
echo ""
echo "Installing application dependencies..."
cd /opt/aether
sudo -u aether npm install --production

# Setup database
echo ""
echo "Setting up database..."

# Generate random database password
DB_PASSWORD=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-25)

# Create PostgreSQL user and database
sudo -u postgres psql <<EOF
CREATE USER aether WITH PASSWORD '$DB_PASSWORD';
CREATE DATABASE aether_db OWNER aether;
GRANT ALL PRIVILEGES ON DATABASE aether_db TO aether;
\q
EOF

# Run database migrations
echo ""
echo "Running database migrations..."
DATABASE_URL="postgresql://aether:$DB_PASSWORD@localhost:5432/aether_db"
sudo -u aether bash -c "DATABASE_URL='$DATABASE_URL' npx prisma migrate deploy"

# Generate environment file
echo ""
echo "Generating configuration..."

# Generate secrets
JWT_SECRET=$(openssl rand -base64 64 | tr -d "=+/" | cut -c1-64)
ENCRYPTION_KEY=$(openssl rand -hex 32)

cat > /opt/aether/.env <<EOF
# Aether Cloud OS Configuration
# Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")

NODE_ENV=production
PORT=3000

# Database
DATABASE_URL=postgresql://aether:$DB_PASSWORD@localhost:5432/aether_db

# Redis
REDIS_URL=redis://localhost:6379

# Security
JWT_SECRET=$JWT_SECRET
ENCRYPTION_KEY=$ENCRYPTION_KEY

# Storage (configure later)
# S3_ENDPOINT=
# S3_REGION=
# S3_ACCESS_KEY_ID=
# S3_SECRET_ACCESS_KEY=
# S3_BUCKET=

# Email (configure later)
# SMTP_HOST=
# SMTP_PORT=
# SMTP_USER=
# SMTP_PASS=
# SMTP_FROM=

# Application
BASE_URL=http://localhost:3000
ALLOWED_ORIGINS=http://localhost:3000
EOF

chown aether:aether /opt/aether/.env
chmod 600 /opt/aether/.env

# Create systemd service
echo ""
echo "Creating systemd service..."

cat > /etc/systemd/system/aether.service <<EOF
[Unit]
Description=Aether Cloud OS Backend
After=network.target postgresql.service redis-server.service

[Service]
Type=simple
User=aether
WorkingDirectory=/opt/aether
EnvironmentFile=/opt/aether/.env
ExecStart=/usr/bin/node /opt/aether/dist/server.js
Restart=always
RestartSec=10

# Security hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/aether/logs /opt/aether/uploads

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=aether

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable aether
systemctl start aether

# Check if service started
sleep 3
if systemctl is-active --quiet aether; then
  echo "  ✓ Aether service started successfully"
else
  echo "  ✗ Aether service failed to start"
  echo "  Check logs: journalctl -u aether -n 50"
  exit 1
fi

# Configure nginx
echo ""
echo "Configuring nginx..."

# Detect domain or use IP
read -p "Enter your domain name (or press Enter to use IP): " DOMAIN
if [ -z "$DOMAIN" ]; then
  DOMAIN=$(curl -s ifconfig.me)
  echo "  Using IP: $DOMAIN"
fi

cat > /etc/nginx/sites-available/aether <<EOF
# Aether Cloud OS nginx configuration

upstream aether_backend {
  server localhost:3000;
  keepalive 64;
}

server {
  listen 80;
  server_name $DOMAIN;

  # Redirect to HTTPS (will be configured with certbot)
  # return 301 https://\$server_name\$request_uri;

  # Temporarily allow HTTP for initial setup
  location / {
    root /opt/aether/dist/public;
    try_files \$uri \$uri/ /index.html;
  }

  location /api {
    proxy_pass http://aether_backend;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_cache_bypass \$http_upgrade;

    # Timeouts
    proxy_connect_timeout 60s;
    proxy_send_timeout 60s;
    proxy_read_timeout 60s;
  }

  location /ws {
    proxy_pass http://aether_backend;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "Upgrade";
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;

    # WebSocket timeouts
    proxy_connect_timeout 7d;
    proxy_send_timeout 7d;
    proxy_read_timeout 7d;
  }

  # Security headers
  add_header X-Frame-Options "SAMEORIGIN" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header X-XSS-Protection "1; mode=block" always;

  # Gzip compression
  gzip on;
  gzip_vary on;
  gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript;
}
EOF

ln -sf /etc/nginx/sites-available/aether /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

# Test nginx config
nginx -t
if [ $? -eq 0 ]; then
  systemctl reload nginx
  echo "  ✓ nginx configured successfully"
else
  echo "  ✗ nginx configuration failed"
  exit 1
fi

# Setup SSL with Let's Encrypt
echo ""
read -p "Setup SSL certificate with Let's Encrypt? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  if [ "$DOMAIN" != "$(curl -s ifconfig.me)" ]; then
    read -p "Enter email for Let's Encrypt: " EMAIL
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL"
  else
    echo "  Skipping: Cannot use Let's Encrypt with IP address"
    echo "  Configure DNS and run: sudo certbot --nginx -d yourdomain.com"
  fi
fi

# Setup firewall
echo ""
read -p "Configure firewall (ufw)? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  ufw allow OpenSSH
  ufw allow 'Nginx Full'
  ufw --force enable
  echo "  ✓ Firewall configured"
fi

# Create admin user
echo ""
echo "Creating admin user..."
read -p "Enter admin email: " ADMIN_EMAIL
read -s -p "Enter admin password: " ADMIN_PASSWORD
echo ""

sudo -u aether node /opt/aether/dist/cli.js create-user \
  --email "$ADMIN_EMAIL" \
  --password "$ADMIN_PASSWORD" \
  --role OWNER

# Installation complete
echo ""
echo "=========================================="
echo "  Installation Complete!"
echo "=========================================="
echo ""
echo "Aether Cloud OS is now running at:"
echo "  http://$DOMAIN"
echo ""
echo "Next steps:"
echo "1. Access the web interface and login"
echo "2. Install Host Agent on target machines"
echo "3. Configure cloud storage (S3)"
echo "4. Configure email (SMTP)"
echo ""
echo "Management commands:"
echo "  sudo systemctl status aether    - Check status"
echo "  sudo systemctl restart aether   - Restart service"
echo "  sudo journalctl -u aether -f    - View logs"
echo ""
echo "Documentation: https://docs.aether-os.io"
echo "=========================================="
```

### 14.4 Host Agent Installation

```bash
#!/bin/bash
# install-agent.sh

set -e

echo "=========================================="
echo "  Aether Host Agent Installer"
echo "  Version: 1.0.0"
echo "=========================================="
echo ""

# Detect OS
if [ -f /etc/os-release ]; then
  source /etc/os-release
  OS_TYPE="$ID"
  echo "Detected OS: $NAME $VERSION"
elif [ "$(uname)" == "Darwin" ]; then
  OS_TYPE="macos"
  echo "Detected OS: macOS"
elif [ "$(expr substr $(uname -s) 1 5)" == "MINGW" ]; then
  OS_TYPE="windows"
  echo "Detected OS: Windows"
else
  echo "Error: Unsupported OS"
  exit 1
fi

# Download agent
echo ""
echo "Downloading Aether Host Agent..."
AGENT_VERSION="1.0.0"

if [ "$OS_TYPE" == "macos" ]; then
  DOWNLOAD_URL="https://releases.aether-os.io/agent/v${AGENT_VERSION}/aether-agent-darwin-x64.tar.gz"
elif [ "$OS_TYPE" == "windows" ]; then
  DOWNLOAD_URL="https://releases.aether-os.io/agent/v${AGENT_VERSION}/aether-agent-win-x64.zip"
else
  DOWNLOAD_URL="https://releases.aether-os.io/agent/v${AGENT_VERSION}/aether-agent-linux-x64.tar.gz"
fi

INSTALL_DIR="/opt/aether-agent"

if [ "$OS_TYPE" == "linux" ] || [ "$OS_TYPE" == "ubuntu" ] || [ "$OS_TYPE" == "debian" ]; then
  # Linux installation
  sudo mkdir -p "$INSTALL_DIR"
  cd "$INSTALL_DIR"
  sudo wget -q "$DOWNLOAD_URL" -O agent.tar.gz
  sudo tar -xzf agent.tar.gz
  sudo rm agent.tar.gz

  # Create systemd service
  sudo cat > /etc/systemd/system/aether-agent.service <<EOF
[Unit]
Description=Aether Host Agent
After=network.target

[Service]
Type=simple
User=aether-agent
WorkingDirectory=$INSTALL_DIR
ExecStart=$INSTALL_DIR/bin/agent start
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

  sudo useradd -r -s /bin/false aether-agent || true
  sudo chown -R aether-agent:aether-agent "$INSTALL_DIR"

  sudo systemctl daemon-reload
  sudo systemctl enable aether-agent
  sudo systemctl start aether-agent

  echo "  ✓ Agent installed and started"

elif [ "$OS_TYPE" == "macos" ]; then
  # macOS installation
  INSTALL_DIR="$HOME/Library/Application Support/AetherAgent"
  mkdir -p "$INSTALL_DIR"
  cd "$INSTALL_DIR"
  curl -sL "$DOWNLOAD_URL" -o agent.tar.gz
  tar -xzf agent.tar.gz
  rm agent.tar.gz

  # Create launchd plist
  cat > "$HOME/Library/LaunchAgents/io.aether.agent.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.aether.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>$INSTALL_DIR/bin/agent</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
EOF

  launchctl load "$HOME/Library/LaunchAgents/io.aether.agent.plist"
  echo "  ✓ Agent installed and started"
fi

# Display pairing instructions
echo ""
echo "=========================================="
echo "  Agent Installation Complete"
echo "=========================================="
echo ""
echo "To pair this host with Aether:"
echo "1. Run: aether-agent pair"
echo "2. Copy the pairing code"
echo "3. Open Aether in browser and add new host"
echo "4. Enter the pairing code"
echo ""
echo "Agent commands:"
if [ "$OS_TYPE" == "macos" ]; then
  echo "  $INSTALL_DIR/bin/agent status"
  echo "  $INSTALL_DIR/bin/agent pair"
  echo "  $INSTALL_DIR/bin/agent logs"
else
  echo "  sudo systemctl status aether-agent"
  echo "  sudo aether-agent pair"
  echo "  sudo journalctl -u aether-agent -f"
fi
echo ""
```

### 14.5 Update & Maintenance

```bash
#!/bin/bash
# update-aether.sh

set -e

echo "Aether Cloud OS Update Script"
echo ""

# Check current version
CURRENT_VERSION=$(cat /opt/aether/VERSION)
echo "Current version: $CURRENT_VERSION"

# Check for updates
LATEST_VERSION=$(curl -s https://releases.aether-os.io/latest-version.txt)
echo "Latest version: $LATEST_VERSION"

if [ "$CURRENT_VERSION" == "$LATEST_VERSION" ]; then
  echo "Already up to date"
  exit 0
fi

read -p "Update to $LATEST_VERSION? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  exit 0
fi

# Backup database
echo ""
echo "Backing up database..."
sudo -u postgres pg_dump aether_db > "/opt/aether/backups/db-$(date +%Y%m%d-%H%M%S).sql"

# Backup current installation
echo "Backing up application..."
cp -r /opt/aether "/opt/aether-backup-$(date +%Y%m%d-%H%M%S)"

# Download new version
echo "Downloading update..."
cd /tmp
wget "https://releases.aether-os.io/v${LATEST_VERSION}/aether-cloud-os.tar.gz"

# Stop service
echo "Stopping service..."
systemctl stop aether

# Extract update
echo "Installing update..."
cd /opt/aether
sudo -u aether tar -xzf /tmp/aether-cloud-os.tar.gz --strip-components=1
sudo -u aether npm install --production

# Run migrations
echo "Running database migrations..."
sudo -u aether npx prisma migrate deploy

# Start service
echo "Starting service..."
systemctl start aether

# Health check
sleep 5
if systemctl is-active --quiet aether; then
  echo ""
  echo "✓ Update complete: $CURRENT_VERSION → $LATEST_VERSION"
else
  echo ""
  echo "✗ Service failed to start"
  echo "Rolling back..."
  systemctl stop aether
  rm -rf /opt/aether/*
  cp -r "/opt/aether-backup-$(date +%Y%m%d-%H%M%S)"/* /opt/aether/
  systemctl start aether
  exit 1
fi
```

### 14.6 Backup & Recovery

```bash
#!/bin/bash
# backup-aether.sh

BACKUP_DIR="/opt/aether/backups"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

mkdir -p "$BACKUP_DIR"

echo "Creating backup..."

# Backup database
sudo -u postgres pg_dump aether_db | gzip > "$BACKUP_DIR/db-$TIMESTAMP.sql.gz"

# Backup uploads and data
tar -czf "$BACKUP_DIR/data-$TIMESTAMP.tar.gz" /opt/aether/uploads /opt/aether/data

# Backup configuration
cp /opt/aether/.env "$BACKUP_DIR/env-$TIMESTAMP"

# Delete old backups (keep last 7 days)
find "$BACKUP_DIR" -name "*.gz" -mtime +7 -delete
find "$BACKUP_DIR" -name "*.sql.gz" -mtime +7 -delete

echo "Backup complete: $BACKUP_DIR"
```

### 14.7 Monitoring & Health Checks

```typescript
// Health check endpoint
app.get('/health', async (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    checks: {
      database: await checkDatabase(),
      redis: await checkRedis(),
      storage: await checkStorage(),
      agent: await checkAgentConnections(),
    },
  };

  const allHealthy = Object.values(health.checks).every((c) => c.status === 'ok');

  res.status(allHealthy ? 200 : 503).json(health);
});

async function checkDatabase(): Promise<HealthCheck> {
  try {
    await db.$queryRaw`SELECT 1`;
    return { status: 'ok' };
  } catch (error) {
    return { status: 'error', message: error.message };
  }
}

async function checkRedis(): Promise<HealthCheck> {
  try {
    await redis.ping();
    return { status: 'ok' };
  } catch (error) {
    return { status: 'error', message: error.message };
  }
}

// Readiness check (can accept traffic)
app.get('/ready', async (req, res) => {
  const ready = await isSystemReady();
  res.status(ready ? 200 : 503).json({ ready });
});
```

---

## 15. ROADMAP & MILESTONES

### 15.1 Phase Overview

| Phase    | Duration  | Deliverables                       | Status      |
| -------- | --------- | ---------------------------------- | ----------- |
| Phase 0  | 2-3 weeks | Architecture & Design              | **Current** |
| Phase 1  | 2-3 weeks | Foundation & Infrastructure        | Pending     |
| Phase 2  | 3-4 weeks | Linux Host Agent                   | Pending     |
| Phase 3  | 2-3 weeks | Desktop Shell & Window Manager     | Pending     |
| Phase 4  | 3-4 weeks | Terminal & Filesystem              | Pending     |
| Phase 5  | 3-4 weeks | Core Applications                  | Pending     |
| Phase 6  | 2-3 weeks | Application Runtime                | Pending     |
| Phase 7  | 3-4 weeks | Cloud Storage & Multi-device       | Pending     |
| Phase 8  | 2-3 weeks | AI Agent                           | Pending     |
| Phase 9  | 3-4 weeks | Platform Expansion (Windows/macOS) | Pending     |
| Phase 10 | 4-6 weeks | Production Hardening               | Pending     |

**Total Estimated Timeline: 6-9 months for full production release**

### 15.2 Phase 0 — Architecture & Design ✓

**Goal:** Complete technical architecture and design documents.

**Deliverables:**

- [x] Comprehensive architecture document
- [x] Technology stack selection with justification
- [x] Database schema design
- [x] API specifications
- [x] Host Agent specifications
- [x] Security threat model
- [x] Permission model
- [x] Deployment architecture
- [ ] UI/UX mockups (design system)
- [ ] System architecture diagrams
- [ ] Sequence diagrams for critical flows
- [ ] Risk assessment
- [ ] Definition of Done

**Timeline:** 2-3 weeks  
**Status:** In Progress (80%)

---

### 15.3 Phase 1 — Foundation & Infrastructure

**Goal:** Set up development environment, CI/CD, and basic infrastructure.

**Tasks:**

1. Repository setup (monorepo with frontend, backend, agent)
2. Development environment with Docker Compose
3. CI/CD pipeline (GitHub Actions or GitLab CI)
4. Linting, formatting, type checking
5. Testing framework setup
6. Basic backend scaffolding
7. Database setup and migrations
8. Authentication system (JWT)
9. User registration and login
10. Basic API with health checks
11. Logging infrastructure
12. Error handling framework

**Deliverables:**

- Monorepo structure
- Docker development environment
- CI/CD pipeline running
- Database with migrations
- Auth system working
- API scaffolding complete
- 80%+ test coverage for auth

**Acceptance Criteria:**

- User can register and login
- JWT authentication works
- Database migrations apply successfully
- CI pipeline passes
- Code quality checks pass

**Timeline:** 2-3 weeks

---

### 15.4 Phase 2 — Linux Host Agent

**Goal:** Build and deploy functional Host Agent for Linux.

**Tasks:**

1. Agent core architecture
2. Secure WebSocket client
3. Pairing flow implementation
4. Host discovery implementation
5. Capability detection for Linux
6. Linux OS adapter
7. PTY service (node-pty integration)
8. Filesystem service
9. Process monitoring service
10. Resource monitoring service
11. Package manager integration (apt/yum)
12. Agent installation script
13. systemd service setup
14. Agent CLI commands
15. Update mechanism

**Deliverables:**

- Functional Linux Host Agent
- Installation script
- Pairing working end-to-end
- Host discovery accurate
- PTY sessions working
- Filesystem operations secure
- systemd service stable

**Acceptance Criteria:**

- Agent installs on Ubuntu 22.04/24.04
- Agent pairs with backend successfully
- Capability report accurate
- PTY terminal works
- Filesystem readable/writable
- Agent survives restart
- Agent can self-update

**Timeline:** 3-4 weeks

---

### 15.5 Phase 3 — Desktop Shell & Window Manager

**Goal:** Build functional desktop UI with window management.

**Tasks:**

1. React project setup with TypeScript
2. Design system implementation
3. Theme system (tokens, themes)
4. Desktop shell component
5. Taskbar/dock component
6. Window Manager implementation
7. Window lifecycle (create, focus, minimize, maximize, close)
8. Window positioning and resizing
9. Window snapping and tiling
10. Application launcher
11. Notification center
12. System tray
13. Context menus
14. Wallpaper system
15. State persistence
16. Keyboard shortcuts
17. Accessibility basics

**Deliverables:**

- Responsive desktop UI
- Functional window manager
- 3 theme variants (Aether, Windows-inspired, macOS-inspired)
- Taskbar with running apps
- App launcher working
- Notifications working

**Acceptance Criteria:**

- Desktop loads without errors
- Windows can be created, moved, resized
- Multiple windows don't overlap incorrectly
- Focus management works correctly
- State persists across reload
- No window lost off-screen
- Keyboard navigation works

**Timeline:** 2-3 weeks

---

### 15.6 Phase 4 — Terminal & Filesystem

**Goal:** Real PTY terminal and host filesystem access.

**Tasks:**

1. xterm.js integration
2. Terminal UI component
3. WebSocket terminal transport
4. PTY session management
5. Terminal tabs
6. Terminal reconnection
7. Terminal color schemes
8. File manager UI
9. File tree component
10. File operations (CRUD)
11. Upload/download
12. File preview
13. Context menus
14. Drag and drop
15. Search functionality
16. Path validation and security
17. Consistency between terminal and file manager

**Deliverables:**

- Working terminal with PTY
- File manager with all basic operations
- Upload/download working
- File preview working
- Files created in terminal visible in file manager

**Acceptance Criteria:**

- Terminal executes real commands on host
- Terminal handles Ctrl+C, Ctrl+D correctly
- Terminal reconnects after disconnect
- File manager shows real host files
- File operations are secure (no path traversal)
- Large file upload handles gracefully
- Terminal and file manager stay consistent

**Timeline:** 3-4 weeks

---

### 15.7 Phase 5 — Core Applications

**Goal:** Build essential built-in applications.

**Tasks:**

1. Application Runtime foundation
2. App manifest schema
3. App API design
4. App sandbox implementation
5. Aether Files app
6. Aether Terminal app
7. Aether Settings app
8. Aether Task Manager app
9. Aether System Monitor app
10. App storage system
11. App permission system
12. Inter-app communication (basic)

**Deliverables:**

- Aether Files (full-featured file manager)
- Aether Terminal (terminal emulator)
- Aether Settings (configuration UI)
- Aether Task Manager (process viewer)
- Aether System Monitor (resource graphs)

**Acceptance Criteria:**

- All 5 core apps functional
- Apps can open multiple windows
- Apps respect permissions
- Apps have isolated storage
- Settings persist correctly
- Task Manager shows real processes
- System Monitor shows real metrics

**Timeline:** 3-4 weeks

---

### 15.8 Phase 6 — Application Runtime

**Goal:** Full application lifecycle and extensibility.

**Tasks:**

1. App Store backend
2. App Store UI
3. App catalog database
4. App installation flow
5. App update mechanism
6. App uninstallation
7. App versioning
8. Dependency management
9. Permission review UI
10. App sandboxing enforcement
11. Resource limits per app
12. Extension system design

**Deliverables:**

- App Store with catalog
- App installation working
- App updates working
- Third-party app support (basic)
- App permission UI

**Acceptance Criteria:**

- User can browse app catalog
- User can install apps
- Installed apps appear in launcher
- Apps can be updated
- Apps can be uninstalled
- Permissions are enforced
- Resource limits prevent runaway apps

**Timeline:** 2-3 weeks

---

### 15.9 Phase 7 — Cloud Storage & Multi-device

**Goal:** Cloud file storage and multi-device access.

**Tasks:**

1. S3 integration
2. Cloud file metadata database
3. Workspace model
4. File sync engine
5. Conflict resolution
6. File versioning
7. Multi-device session management
8. Device management UI
9. Offline support (IndexedDB cache)
10. PWA manifest
11. Service worker
12. Backup system

**Deliverables:**

- Cloud storage working
- File sync functional
- Multi-device access
- Conflict resolution UI
- Offline mode (basic)
- PWA installable

**Acceptance Criteria:**

- Files sync between devices
- Conflicts detected and resolved
- Offline changes sync when online
- Multiple devices can access same host
- PWA installs on mobile
- Storage quota enforced

**Timeline:** 3-4 weeks

---

### 15.10 Phase 8 — AI Agent

**Goal:** AI assistant with controlled tool access.

**Tasks:**

1. AI service integration (Claude API)
2. Tool API definition
3. Permission-based tool access
4. Approval flow for sensitive operations
5. AI chat UI
6. Context management
7. Tool execution sandbox
8. Audit logging for AI actions
9. Rate limiting
10. Cost tracking

**Deliverables:**

- AI assistant chat interface
- Tool permission system
- Approval UI for destructive operations
- Audit log of AI actions

**Acceptance Criteria:**

- AI can answer questions about host
- AI can execute allowed tools
- AI cannot execute privileged tools without approval
- AI operations are audited
- AI respects permission boundaries

**Timeline:** 2-3 weeks

---

### 15.11 Phase 9 — Platform Expansion

**Goal:** Windows and macOS host support.

**Tasks:**

1. Windows OS adapter
2. Windows Host Agent
3. Windows installer
4. PowerShell integration
5. Windows service setup
6. macOS OS adapter
7. macOS Host Agent
8. macOS installer
9. zsh integration
10. launchd setup
11. Platform-specific capability detection
12. Cross-platform testing

**Deliverables:**

- Windows Host Agent functional
- macOS Host Agent functional
- Platform-specific installers
- Documentation for each platform

**Acceptance Criteria:**

- Agent works on Windows 10+
- Agent works on macOS 12+
- PTY works on both platforms
- Filesystem operations work correctly
- Platform limitations documented

**Timeline:** 3-4 weeks

---

### 15.12 Phase 10 — Production Hardening

**Goal:** Make system production-ready.

**Tasks:**

1. Security audit
2. Penetration testing
3. Load testing
4. Performance optimization
5. Database query optimization
6. WebSocket connection optimization
7. Frontend bundle optimization
8. Memory leak detection and fixes
9. Error recovery testing
10. Backup and restore testing
11. Disaster recovery procedures
12. Monitoring setup (Prometheus/Grafana)
13. Alert configuration
14. Documentation (user, admin, developer)
15. Troubleshooting guides
16. Migration guides
17. SLA definition
18. Support procedures

**Deliverables:**

- Security audit report
- Performance benchmark report
- Complete documentation
- Monitoring dashboards
- Disaster recovery plan
- Production deployment checklist

**Acceptance Criteria:**

- No critical security vulnerabilities
- Load test passes (50 concurrent users on 4GB VPS)
- Recovery from all failure scenarios tested
- Complete documentation available
- Monitoring detects issues proactively
- Backup/restore tested successfully

**Timeline:** 4-6 weeks

---

### 15.13 Definition of Done

**MVP (Phase 1-6) is considered complete when:**

1. ✓ User can deploy Aether on Ubuntu VPS with installer
2. ✓ User can register and login securely
3. ✓ User can install Host Agent on Linux VPS
4. ✓ Host Agent pairs securely with backend
5. ✓ Desktop loads with window manager
6. ✓ Terminal executes real commands via PTY
7. ✓ File manager accesses real host filesystem
8. ✓ Files created in terminal appear in file manager
9. ✓ All 5 core apps functional
10. ✓ Connection loss handled gracefully
11. ✓ Sessions persist across browser reload
12. ✓ No critical security vulnerabilities
13. ✓ Permissions enforced correctly
14. ✓ Installation and user documentation complete
15. ✓ End-to-end tests pass

**Production Ready (Phase 10) is complete when:**

1. ✓ All MVP criteria met
2. ✓ Security audit passed
3. ✓ Load testing passed
4. ✓ Multi-platform support (Linux, Windows, macOS)
5. ✓ Cloud storage working
6. ✓ Multi-device access working
7. ✓ App Store functional
8. ✓ AI assistant working
9. ✓ Monitoring in place
10. ✓ Backup/restore tested
11. ✓ Complete documentation
12. ✓ No high-severity bugs open
13. ✓ Performance targets met
14. ✓ Disaster recovery plan documented
15. ✓ Support procedures in place

---

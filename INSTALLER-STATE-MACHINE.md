# Aether Installer - State Machine

**Version:** 1.0.0  
**Date:** 2026-09-15  
**Status:** Draft - Design Phase

---

## Overview

The Aether installer operates as a **deterministic state machine** with well-defined stages, transitions, and error handling. This design enables:
- Resume from interruption
- Rollback on failure
- Clear progress tracking
- Reproducible installations

---

## State Machine Diagram

```
                    ┌──────────────┐
                    │   START      │
                    └──────┬───────┘
                           │
                           ▼
                    ┌──────────────┐
                    │  INITIALIZE  │◄─────────┐
                    └──────┬───────┘          │
                           │                  │
                           ▼                  │
                    ┌──────────────┐          │
                 ┌──│  PREFLIGHT   │          │
                 │  └──────┬───────┘          │
                 │         │                  │
                 │    ┌────▼────┐             │
                 │    │ PASSED? │             │
                 │    └────┬────┘             │
                 │         │ yes              │
                 │         ▼                  │
                 │  ┌──────────────┐          │
                 │  │ OS_DETECT    │          │
                 │  └──────┬───────┘          │
                 │         │                  │
                 │         ▼                  │
                 │  ┌──────────────┐          │
                 │  │ RESOURCE_CHK │          │
                 │  └──────┬───────┘          │
                 │         │                  │
                 │         ▼                  │
                 │  ┌──────────────┐          │
                 │  │ NETWORK_CHK  │          │
                 │  └──────┬───────┘          │
                 │         │                  │
                 │         ▼                  │
                 │  ┌──────────────┐          │
                 │  │ PERMISSION   │          │
                 │  └──────┬───────┘          │
                 │         │                  │
                 │         ▼                  │
                 │  ┌──────────────┐          │
                 │  │ CONFLICT_CHK │          │
                 │  └──────┬───────┘          │
                 │         │                  │
                 │         ▼                  │
                 │  ┌──────────────┐          │
                 │  │ DEP_DETECT   │          │
                 │  └──────┬───────┘          │
                 │         │                  │
                 │         ▼                  │
                 │  ┌──────────────┐          │
                 │  │ DEP_INSTALL  │          │
                 │  └──────┬───────┘          │
                 │         │                  │
                 │         ▼                  │
                 │  ┌──────────────┐          │
                 │  │ DOCKER_SETUP │          │
                 │  └──────┬───────┘          │
                 │         │                  │
                 │         ▼                  │
                 │  ┌──────────────┐          │
                 │  │  DOWNLOAD    │          │
                 │  └──────┬───────┘          │
                 │         │                  │
                 │         ▼                  │
                 │  ┌──────────────┐          │
                 │  │   VERIFY     │          │
                 │  └──────┬───────┘          │
                 │         │                  │
                 │    ┌────▼────┐             │
                 │    │ VALID?  │             │
                 │    └────┬────┘             │
                 │         │ yes              │
                 │         ▼                  │
                 │  ┌──────────────┐          │
                 │  │   EXTRACT    │          │
                 │  └──────┬───────┘          │
                 │         │                  │
                 │         ▼                  │
                 │  ┌──────────────┐          │
                 │  │  CONFIGURE   │          │
                 │  └──────┬───────┘          │
                 │         │                  │
                 │         ▼                  │
                 │  ┌──────────────┐          │
                 │  │  SECRETS     │          │
                 │  └──────┬───────┘          │
                 │         │                  │
                 │         ▼                  │
                 │  ┌──────────────┐          │
                 │  │  DOMAIN      │          │
                 │  └──────┬───────┘          │
                 │         │                  │
                 │         ▼                  │
                 │  ┌──────────────┐          │
                 │  │  FIREWALL    │          │
                 │  └──────┬───────┘          │
                 │         │                  │
                 │         ▼                  │
                 │  ┌──────────────┐          │
                 │  │   DEPLOY     │          │
                 │  └──────┬───────┘          │
                 │         │                  │
                 │         ▼                  │
                 │  ┌──────────────┐          │
                 │  │  DB_INIT     │          │
                 │  └──────┬───────┘          │
                 │         │                  │
                 │         ▼                  │
                 │  ┌──────────────┐          │
                 │  │ HEALTH_CHECK │          │
                 │  └──────┬───────┘          │
                 │         │                  │
                 │    ┌────▼────┐             │
                 │    │HEALTHY? │             │
                 │    └────┬────┘             │
                 │         │ yes              │
                 │         ▼                  │
                 │  ┌──────────────┐          │
                 │  │HTTPS_SETUP   │          │
                 │  └──────┬───────┘          │
                 │         │                  │
                 │         ▼                  │
                 │  ┌──────────────┐          │
                 │  │  PAIRING     │          │
                 │  └──────┬───────┘          │
                 │         │                  │
                 │         ▼                  │
                 │  ┌──────────────┐          │
                 │  │  COMPLETE    │          │
                 │  └──────┬───────┘          │
                 │         │                  │
                 │         ▼                  │
                 │  ┌──────────────┐          │
                 │  │   SUCCESS    │          │
                 │  └──────────────┘          │
                 │                            │
                 │ no (at any stage)          │
                 ├────────────────────────────┘
                 │
                 ▼
          ┌──────────────┐
          │   ERROR      │
          └──────┬───────┘
                 │
            ┌────▼────┐
            │ RETRY?  │
            └────┬────┘
                 │
          ┌──────┴──────┐
          │             │
         yes           no
          │             │
          │             ▼
          │      ┌──────────────┐
          │      │   ROLLBACK   │
          │      └──────┬───────┘
          │             │
          │             ▼
          │      ┌──────────────┐
          │      │   CLEANUP    │
          │      └──────┬───────┘
          │             │
          │             ▼
          │      ┌──────────────┐
          │      │   FAILED     │
          │      └──────────────┘
          │
          └──► (retry logic)
```

---

## State Definitions

### 1. START
**Entry:** User executes installer  
**Actions:**
- Parse command-line arguments
- Display welcome banner
- Check for existing installation

**Transitions:**
- → `INITIALIZE` (always)

**Exit Criteria:** Command parsed

---

### 2. INITIALIZE
**Entry:** From START or RESUME  
**Actions:**
- Create installation ID
- Create lock file
- Initialize log file
- Check for resume state
- Set up signal handlers
- Create temp directory

**Transitions:**
- → `PREFLIGHT` (if new install)
- → `<LAST_STAGE>` (if resuming)
- → `ERROR` (if lock exists)

**Exit Criteria:** System initialized

**Persistence:**
```json
{
  "stage": "INITIALIZE",
  "install_id": "uuid",
  "timestamp": "ISO8601",
  "args": {...}
}
```

---

### 3. PREFLIGHT
**Entry:** From INITIALIZE  
**Actions:**
- Aggregate all preflight checks
- Display summary
- Ask for confirmation (if interactive)

**Sub-stages:**
- OS_DETECT
- RESOURCE_CHK
- NETWORK_CHK
- PERMISSION
- CONFLICT_CHK

**Transitions:**
- → `OS_DETECT` (if confirmed)
- → `FAILED` (if user declines)
- → `ERROR` (if critical failure)

**Exit Criteria:** All checks passed and confirmed

---

### 4. OS_DETECT
**Entry:** From PREFLIGHT  
**Actions:**
- Read `/etc/os-release`
- Execute `uname -s -m -r`
- Detect distribution
- Detect package manager
- Detect init system
- Determine architecture

**Checks:**
```bash
OS=$(uname -s)
if [[ "$OS" != "Linux" ]]; then
  error "Only Linux is supported"
fi

ARCH=$(uname -m)
if [[ "$ARCH" != "x86_64" && "$ARCH" != "aarch64" ]]; then
  error "Unsupported architecture: $ARCH"
fi

if [[ -f /etc/os-release ]]; then
  source /etc/os-release
  if [[ "$ID" == "ubuntu" ]]; then
    VERSION_MAJOR=$(echo $VERSION_ID | cut -d. -f1)
    if [[ $VERSION_MAJOR -ge 20 ]]; then
      echo "✓ Ubuntu $VERSION_ID (Supported)"
    else
      error "Ubuntu $VERSION_ID is not supported (minimum: 20.04)"
    fi
  else
    warning "$NAME is not officially supported"
  fi
fi
```

**Transitions:**
- → `RESOURCE_CHK` (if supported)
- → `ERROR` (if unsupported)

**Exit Criteria:** OS and arch validated

**Persistence:**
```json
{
  "stage": "OS_DETECT",
  "os": "Linux",
  "distro": "Ubuntu",
  "version": "22.04",
  "arch": "x86_64",
  "kernel": "5.15.0-91-generic",
  "package_manager": "apt",
  "init_system": "systemd"
}
```

---

### 5. RESOURCE_CHK
**Entry:** From OS_DETECT  
**Actions:**
- Count CPU cores
- Check RAM size
- Check disk space
- Check I/O performance (optional)

**Checks:**
```bash
# CPU
CPU_CORES=$(nproc)
CPU_MIN=2
CPU_REC=4

if [[ $CPU_CORES -lt $CPU_MIN ]]; then
  error "Insufficient CPU cores: $CPU_CORES (minimum: $CPU_MIN)"
elif [[ $CPU_CORES -lt $CPU_REC ]]; then
  warning "CPU cores below recommended: $CPU_CORES (recommended: $CPU_REC)"
else
  success "CPU cores: $CPU_CORES"
fi

# RAM
RAM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
RAM_GB=$((RAM_KB / 1024 / 1024))
RAM_MIN=4
RAM_REC=8

if [[ $RAM_GB -lt $RAM_MIN ]]; then
  error "Insufficient RAM: ${RAM_GB}GB (minimum: ${RAM_MIN}GB)"
elif [[ $RAM_GB -lt $RAM_REC ]]; then
  warning "RAM below recommended: ${RAM_GB}GB (recommended: ${RAM_REC}GB)"
else
  success "RAM: ${RAM_GB}GB"
fi

# Disk
DISK_FREE_GB=$(df -BG /opt | tail -1 | awk '{print $4}' | sed 's/G//')
DISK_MIN=40
DISK_REC=80

if [[ $DISK_FREE_GB -lt $DISK_MIN ]]; then
  error "Insufficient disk space: ${DISK_FREE_GB}GB free (minimum: ${DISK_MIN}GB)"
elif [[ $DISK_FREE_GB -lt $DISK_REC ]]; then
  warning "Disk space below recommended: ${DISK_FREE_GB}GB (recommended: ${DISK_REC}GB)"
else
  success "Disk space: ${DISK_FREE_GB}GB free"
fi
```

**Transitions:**
- → `NETWORK_CHK` (if meets minimum)
- → `ERROR` (if below minimum)

**Exit Criteria:** Resources validated

**Persistence:**
```json
{
  "stage": "RESOURCE_CHK",
  "cpu_cores": 4,
  "ram_gb": 8,
  "disk_free_gb": 120,
  "meets_minimum": true,
  "meets_recommended": true
}
```

---

### 6. NETWORK_CHK
**Entry:** From RESOURCE_CHK  
**Actions:**
- Test internet connectivity
- Test DNS resolution
- Detect public IP
- Check port availability
- Test download speed (optional)

**Checks:**
```bash
# Internet connectivity
if curl -fsSL --connect-timeout 5 https://www.google.com > /dev/null 2>&1; then
  success "Internet connectivity: OK"
else
  error "No internet connectivity"
fi

# DNS resolution
if nslookup aether-os.io > /dev/null 2>&1; then
  success "DNS resolution: OK"
else
  error "DNS resolution failed"
fi

# Public IP
PUBLIC_IP=$(curl -s https://api.ipify.org)
if [[ -n "$PUBLIC_IP" ]]; then
  success "Public IP: $PUBLIC_IP"
else
  warning "Could not detect public IP"
fi

# Port availability
for port in 80 443; do
  if nc -z localhost $port 2>/dev/null; then
    warning "Port $port is already in use"
  else
    success "Port $port is available"
  fi
done
```

**Transitions:**
- → `PERMISSION` (if network OK)
- → `ERROR` (if critical failure)

**Exit Criteria:** Network validated

**Persistence:**
```json
{
  "stage": "NETWORK_CHK",
  "internet": true,
  "dns": true,
  "public_ip": "203.0.113.1",
  "port_80_available": true,
  "port_443_available": true
}
```

---

### 7. PERMISSION
**Entry:** From NETWORK_CHK  
**Actions:**
- Check current user
- Check sudo availability
- Check file system permissions
- Check Docker socket (if exists)

**Checks:**
```bash
# Current user
CURRENT_USER=$(whoami)
if [[ "$CURRENT_USER" == "root" ]]; then
  warning "Running as root (not recommended for production)"
  SUDO=""
else
  success "Current user: $CURRENT_USER"
  
  # Check sudo
  if sudo -n true 2>/dev/null; then
    success "Sudo: available (passwordless)"
    SUDO="sudo"
  elif sudo -v 2>/dev/null; then
    success "Sudo: available (with password)"
    SUDO="sudo"
  else
    error "Sudo is not available"
  fi
fi

# Check write permissions
TEST_DIR="${INSTALL_DIR:-/opt/aether}"
if $SUDO mkdir -p "$TEST_DIR" 2>/dev/null; then
  success "Write permissions: OK"
  $SUDO rmdir "$TEST_DIR" 2>/dev/null
else
  error "Cannot write to $TEST_DIR"
fi
```

**Transitions:**
- → `CONFLICT_CHK` (if permissions OK)
- → `ERROR` (if insufficient permissions)

**Exit Criteria:** Permissions validated

**Persistence:**
```json
{
  "stage": "PERMISSION",
  "user": "ubuntu",
  "is_root": false,
  "sudo_available": true,
  "write_permissions": true
}
```

---

### 8. CONFLICT_CHK
**Entry:** From PERMISSION  
**Actions:**
- Check for existing Aether installation
- Check for Docker conflicts
- Check for web server conflicts
- Check for reverse proxy conflicts

**Checks:**
```bash
# Existing installation
if [[ -f /opt/aether/install.state ]]; then
  STATE=$(cat /opt/aether/install.state)
  STATUS=$(echo "$STATE" | jq -r '.status')
  
  if [[ "$STATUS" == "SUCCESS" ]]; then
    warning "Aether is already installed"
    echo "Use 'aether update' to upgrade or 'aether uninstall' to remove"
    exit 1
  elif [[ "$STATUS" == "FAILED" ]]; then
    info "Previous installation failed. Will attempt repair."
  elif [[ "$STATUS" == "INCOMPLETE" ]]; then
    info "Previous installation incomplete. Will resume."
  fi
fi

# Docker conflicts
if docker ps --format '{{.Names}}' | grep -E '^aether-'; then
  warning "Found existing Aether containers"
fi

# Web server conflicts
for service in nginx apache2 httpd; do
  if systemctl is-active --quiet $service; then
    warning "$service is running on this server"
    echo "This may conflict with Caddy on port 80/443"
  fi
done

# Reverse proxy conflicts
for service in caddy traefik haproxy; do
  if systemctl is-active --quiet $service; then
    warning "$service is running on this server"
    echo "This may conflict with Aether's Caddy instance"
  fi
done
```

**Transitions:**
- → `DEP_DETECT` (if no blocking conflicts)
- → `ERROR` (if blocking conflicts found)

**Exit Criteria:** No blocking conflicts

**Persistence:**
```json
{
  "stage": "CONFLICT_CHK",
  "existing_installation": false,
  "docker_conflicts": [],
  "web_server_conflicts": [],
  "proxy_conflicts": []
}
```

---

### 9. DEP_DETECT
**Entry:** From CONFLICT_CHK  
**Actions:**
- Check for curl, wget, git
- Check for Docker
- Check for Docker Compose
- Check for openssl
- Determine what needs installation

**Checks:**
```bash
declare -A DEPS
DEPS=(
  [curl]=$(command -v curl)
  [wget]=$(command -v wget)
  [git]=$(command -v git)
  [openssl]=$(command -v openssl)
  [docker]=$(command -v docker)
  [docker-compose]=$(command -v docker || echo "") # compose v2
)

MISSING=()
for dep in "${!DEPS[@]}"; do
  if [[ -n "${DEPS[$dep]}" ]]; then
    VERSION=$("${DEPS[$dep]}" --version 2>&1 | head -1)
    success "$dep: $VERSION"
  else
    warning "$dep: not found"
    MISSING+=($dep)
  fi
done

if [[ ${#MISSING[@]} -gt 0 ]]; then
  info "Will install: ${MISSING[*]}"
fi
```

**Transitions:**
- → `DEP_INSTALL` (if missing deps)
- → `DOCKER_SETUP` (if all present)

**Exit Criteria:** Dependencies cataloged

**Persistence:**
```json
{
  "stage": "DEP_DETECT",
  "dependencies": {
    "curl": { "found": true, "version": "7.81.0" },
    "docker": { "found": false, "version": null }
  },
  "to_install": ["docker"]
}
```

---

### 10. DEP_INSTALL
**Entry:** From DEP_DETECT  
**Actions:**
- Update package index
- Install missing system packages
- Install Docker (if needed)
- Verify installations

**Installation:**
```bash
# System packages
if [[ ${#MISSING[@]} -gt 0 ]]; then
  info "Installing system packages..."
  
  $SUDO apt-get update -qq
  
  for dep in "${MISSING[@]}"; do
    if [[ "$dep" == "docker" ]]; then
      continue # Handle separately
    fi
    
    $SUDO apt-get install -y $dep
    
    if command -v $dep > /dev/null; then
      success "$dep installed"
    else
      error "Failed to install $dep"
    fi
  done
fi

# Docker
if [[ -z "$(command -v docker)" ]]; then
  info "Installing Docker..."
  
  # Use official Docker installation script
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  
  # Verify script (basic check)
  if [[ ! -f /tmp/get-docker.sh ]]; then
    error "Failed to download Docker installer"
  fi
  
  $SUDO sh /tmp/get-docker.sh
  
  # Add user to docker group
  $SUDO usermod -aG docker $USER
  
  # Verify
  if docker --version > /dev/null 2>&1; then
    success "Docker installed"
  else
    error "Docker installation failed"
  fi
  
  rm /tmp/get-docker.sh
fi

# Docker Compose (v2 is built into docker)
if ! docker compose version > /dev/null 2>&1; then
  error "Docker Compose v2 is not available"
fi
```

**Transitions:**
- → `DOCKER_SETUP` (if all installed)
- → `ERROR` (if installation failed)

**Exit Criteria:** All dependencies installed

**Persistence:**
```json
{
  "stage": "DEP_INSTALL",
  "installed": ["docker", "docker-compose"],
  "failed": []
}
```

---

### 11. DOCKER_SETUP
**Entry:** From DEP_INSTALL  
**Actions:**
- Start Docker daemon
- Enable Docker service
- Configure Docker daemon (if needed)
- Test Docker with hello-world
- Verify Docker Compose

**Setup:**
```bash
# Enable Docker service
if ! systemctl is-enabled docker > /dev/null 2>&1; then
  $SUDO systemctl enable docker
  success "Docker service enabled"
fi

# Start Docker service
if ! systemctl is-active docker > /dev/null 2>&1; then
  $SUDO systemctl start docker
  sleep 3
  success "Docker service started"
fi

# Test Docker
if docker run --rm hello-world > /dev/null 2>&1; then
  success "Docker is working"
else
  error "Docker test failed"
fi

# Verify Compose
if docker compose version > /dev/null 2>&1; then
  COMPOSE_VERSION=$(docker compose version --short)
  success "Docker Compose: $COMPOSE_VERSION"
else
  error "Docker Compose is not working"
fi

# Check Docker socket permissions
if [[ ! -w /var/run/docker.sock ]]; then
  warning "Current user cannot access Docker socket"
  info "You may need to log out and back in for group changes to take effect"
  info "Or run: newgrp docker"
fi
```

**Transitions:**
- → `DOWNLOAD` (if Docker ready)
- → `ERROR` (if Docker not working)

**Exit Criteria:** Docker operational

**Persistence:**
```json
{
  "stage": "DOCKER_SETUP",
  "docker_version": "24.0.7",
  "compose_version": "2.23.0",
  "daemon_running": true,
  "test_passed": true
}
```

---

### 12. DOWNLOAD
**Entry:** From DOCKER_SETUP  
**Actions:**
- Determine target version/channel
- Download release artifact
- Download checksums
- Store in temp directory

**Download:**
```bash
# Determine version
VERSION=${AETHER_VERSION:-stable}
CHANNEL=${AETHER_CHANNEL:-stable}

if [[ "$CHANNEL" == "stable" ]]; then
  RELEASE_URL="https://releases.aether-os.io/stable/latest"
elif [[ "$CHANNEL" == "development" ]]; then
  warning "Using development channel - not for production!"
  RELEASE_URL="https://releases.aether-os.io/development/latest"
else
  RELEASE_URL="https://releases.aether-os.io/versions/$VERSION"
fi

# Download manifest
info "Downloading release manifest..."
curl -fsSL "$RELEASE_URL/manifest.json" -o /tmp/aether-manifest.json

ARTIFACT_URL=$(jq -r '.artifacts.linux_amd64.url' /tmp/aether-manifest.json)
CHECKSUM_URL=$(jq -r '.artifacts.linux_amd64.checksum_url' /tmp/aether-manifest.json)

# Download release
info "Downloading Aether Cloud OS..."
curl -fsSL "$ARTIFACT_URL" -o /tmp/aether-release.tar.gz

# Download checksums
info "Downloading checksums..."
curl -fsSL "$CHECKSUM_URL" -o /tmp/aether-checksums.txt

success "Download complete"
```

**Transitions:**
- → `VERIFY` (if downloaded)
- → `ERROR` (if download failed)

**Exit Criteria:** Files downloaded

**Persistence:**
```json
{
  "stage": "DOWNLOAD",
  "version": "0.1.0",
  "channel": "stable",
  "artifact_url": "https://...",
  "downloaded_at": "2026-09-15T20:00:00Z"
}
```

---

### 13. VERIFY
**Entry:** From DOWNLOAD  
**Actions:**
- Verify SHA256 checksum
- Verify GPG signature (future)
- Validate manifest

**Verification:**
```bash
info "Verifying download integrity..."

cd /tmp

# Verify checksum
if sha256sum -c aether-checksums.txt --ignore-missing 2>&1 | grep -q "OK"; then
  success "Checksum verification passed"
else
  error "Checksum verification FAILED"
  error "This could indicate:"
  error "  - Corrupted download"
  error "  - Man-in-the-middle attack"
  error "  - Compromised release server"
  error ""
  error "DO NOT PROCEED. Contact support."
  exit 1
fi

# Future: GPG signature verification
# if [[ -f aether-release.tar.gz.sig ]]; then
#   gpg --verify aether-release.tar.gz.sig aether-release.tar.gz
# fi
```

**Transitions:**
- → `EXTRACT` (if verified)
- → `ERROR` (if verification failed - CRITICAL)

**Exit Criteria:** Integrity confirmed

**Persistence:**
```json
{
  "stage": "VERIFY",
  "checksum_verified": true,
  "signature_verified": false,
  "verified_at": "2026-09-15T20:00:00Z"
}
```

---

### 14. EXTRACT
**Entry:** From VERIFY  
**Actions:**
- Create installation directory
- Extract release archive
- Set permissions
- Validate extracted contents

**Extraction:**
```bash
INSTALL_DIR="${AETHER_INSTALL_DIR:-/opt/aether}"

info "Extracting to $INSTALL_DIR..."

# Create directory
$SUDO mkdir -p "$INSTALL_DIR"
$SUDO chown $USER:$USER "$INSTALL_DIR"

# Extract
tar -xzf /tmp/aether-release.tar.gz -C "$INSTALL_DIR"

# Verify extraction
if [[ -f "$INSTALL_DIR/docker-compose.yml" ]]; then
  success "Extraction complete"
else
  error "Extraction failed - missing expected files"
fi

# Set permissions
chmod 755 "$INSTALL_DIR"
chmod 644 "$INSTALL_DIR"/*.yml

success "Files extracted to $INSTALL_DIR"
```

**Transitions:**
- → `CONFIGURE` (if extracted)
- → `ERROR` (if extraction failed)

**Exit Criteria:** Files extracted and validated

**Persistence:**
```json
{
  "stage": "EXTRACT",
  "install_dir": "/opt/aether",
  "extracted_files": 42,
  "extracted_at": "2026-09-15T20:00:00Z"
}
```

---

### 15. CONFIGURE
**Entry:** From EXTRACT  
**Actions:**
- Generate instance ID
- Create directory structure
- Generate .env file
- Set up logging

**Configuration:**
```bash
cd "$INSTALL_DIR"

# Generate instance ID
INSTANCE_ID=$(uuidgen)

# Create directories
mkdir -p data/{postgres,redis,minio}
mkdir -p logs/{backend,frontend,caddy}
mkdir -p backups
mkdir -p secrets

# Create instance metadata
cat > instance.json << EOF
{
  "instance_id": "$INSTANCE_ID",
  "version": "0.1.0",
  "installed_at": "$(date -Iseconds)",
  "installed_by": "$USER",
  "hostname": "$(hostname)",
  "public_ip": "$PUBLIC_IP"
}
EOF

success "Instance configured"
```

**Transitions:**
- → `SECRETS` (always)

**Exit Criteria:** Basic config created

**Persistence:**
```json
{
  "stage": "CONFIGURE",
  "instance_id": "uuid",
  "install_dir": "/opt/aether",
  "configured_at": "2026-09-15T20:00:00Z"
}
```

---

### 16. SECRETS
**Entry:** From CONFIGURE  
**Actions:**
- Generate database password
- Generate Redis password
- Generate JWT secret
- Generate encryption key
- Generate session secret
- Create .env file

**Secret Generation:**
```bash
info "Generating secure secrets..."

# Helper functions
generate_password() {
  openssl rand -base64 32 | tr -d '\n' | head -c 32
}

generate_secret() {
  openssl rand -base64 64 | tr -d '\n'
}

generate_hex_key() {
  openssl rand -hex 32
}

# Generate secrets
DB_PASSWORD=$(generate_password)
REDIS_PASSWORD=$(generate_password)
JWT_SECRET=$(generate_secret)
ENCRYPTION_KEY=$(generate_hex_key)
SESSION_SECRET=$(generate_secret)

# Store secrets securely
echo "$DB_PASSWORD" > secrets/db_password
echo "$REDIS_PASSWORD" > secrets/redis_password
echo "$JWT_SECRET" > secrets/jwt_secret
echo "$ENCRYPTION_KEY" > secrets/encryption_key
echo "$SESSION_SECRET" > secrets/session_secret

chmod 600 secrets/*

# Create .env
cat > .env << EOF
# Aether Cloud OS Configuration
# Generated: $(date -Iseconds)
# Instance: $INSTANCE_ID

NODE_ENV=production
PORT=3000
HOST=0.0.0.0
BASE_URL=${BASE_URL:-http://localhost:3000}

# Database
DATABASE_URL=postgresql://aether:${DB_PASSWORD}@postgres:5432/aether_prod

# Redis
REDIS_URL=redis://:${REDIS_PASSWORD}@redis:6379

# Security
JWT_SECRET=${JWT_SECRET}
JWT_ACCESS_TOKEN_EXPIRY=15m
JWT_REFRESH_TOKEN_EXPIRY=30d
ENCRYPTION_KEY=${ENCRYPTION_KEY}
SESSION_SECRET=${SESSION_SECRET}

# Logging
LOG_LEVEL=info
LOG_FORMAT=json
EOF

chmod 600 .env

success "Secrets generated and stored securely"
```

**Transitions:**
- → `DOMAIN` (always)

**Exit Criteria:** Secrets created and secured

**Persistence:**
```json
{
  "stage": "SECRETS",
  "secrets_generated": true,
  "generated_at": "2026-09-15T20:00:00Z"
}
```

---

### 17. DOMAIN
**Entry:** From SECRETS  
**Actions:**
- Prompt for domain (if interactive)
- Verify DNS (if domain provided)
- Configure Caddy
- Update .env with domain

**Domain Configuration:**
```bash
if [[ -n "$AETHER_DOMAIN" ]]; then
  DOMAIN="$AETHER_DOMAIN"
  info "Using domain: $DOMAIN"
  
  # Verify DNS
  info "Verifying DNS..."
  DOMAIN_IP=$(dig +short "$DOMAIN" | tail -n1)
  
  if [[ "$DOMAIN_IP" == "$PUBLIC_IP" ]]; then
    success "DNS verified: $DOMAIN → $PUBLIC_IP"
    HTTPS_ENABLED=true
  else
    warning "DNS mismatch:"
    warning "  Domain resolves to: $DOMAIN_IP"
    warning "  Server IP: $PUBLIC_IP"
    warning ""
    warning "HTTPS certificate will fail until DNS is correct"
    warning "You can update DNS and run: aether reconfigure-https"
    HTTPS_ENABLED=false
  fi
  
  # Update .env
  sed -i "s|BASE_URL=.*|BASE_URL=https://${DOMAIN}|" .env
  
  # Configure Caddy
  cat > caddy/Caddyfile << EOF
$DOMAIN {
  reverse_proxy frontend:5173
  
  handle /api/* {
    reverse_proxy backend:3000
  }
  
  log {
    output file /var/log/caddy/access.log
  }
}
EOF
  
else
  info "No domain specified - using IP-based access"
  warning "HTTPS will not be available without a domain"
  HTTPS_ENABLED=false
  
  # Configure Caddy for HTTP only
  cat > caddy/Caddyfile << EOF
:80 {
  reverse_proxy frontend:5173
  
  handle /api/* {
    reverse_proxy backend:3000
  }
}
EOF
fi
```

**Transitions:**
- → `FIREWALL` (always)

**Exit Criteria:** Domain configured or skipped

**Persistence:**
```json
{
  "stage": "DOMAIN",
  "domain": "cloud.example.com",
  "dns_verified": true,
  "https_enabled": true,
  "configured_at": "2026-09-15T20:00:00Z"
}
```

---

### 18. FIREWALL
**Entry:** From DOMAIN  
**Actions:**
- Detect firewall (UFW, firewalld, etc.)
- Backup current rules
- Configure firewall
- Ask confirmation before applying

**Firewall Configuration:**
```bash
if command -v ufw > /dev/null; then
  info "Configuring UFW firewall..."
  
  # Backup
  $SUDO ufw status numbered > backups/ufw-backup-$(date +%Y%m%d-%H%M%S).txt
  
  # Display proposed changes
  echo ""
  echo "Firewall changes to be applied:"
  echo "  ✓ Allow SSH (22/tcp)"
  echo "  ✓ Allow HTTP (80/tcp)"
  echo "  ✓ Allow HTTPS (443/tcp)"
  echo ""
  
  if [[ "$INTERACTIVE" == "true" ]]; then
    read -p "Apply firewall rules? [Y/n] " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
      warning "Skipping firewall configuration"
      return
    fi
  fi
  
  # Apply rules
  $SUDO ufw --force allow ssh
  $SUDO ufw --force allow 80/tcp
  $SUDO ufw --force allow 443/tcp
  
  # Enable firewall
  $SUDO ufw --force enable
  
  success "Firewall configured"
  
elif command -v firewall-cmd > /dev/null; then
  info "Detected firewalld - manual configuration required"
  warning "Please ensure ports 22, 80, and 443 are open"
else
  warning "No firewall detected"
  info "Recommended: Install and configure UFW"
fi
```

**Transitions:**
- → `DEPLOY` (always)

**Exit Criteria:** Firewall configured or skipped

**Persistence:**
```json
{
  "stage": "FIREWALL",
  "firewall": "ufw",
  "rules_applied": true,
  "backup_created": true,
  "configured_at": "2026-09-15T20:00:00Z"
}
```

---

### 19. DEPLOY
**Entry:** From FIREWALL  
**Actions:**
- Update docker-compose.yml with config
- Pull Docker images
- Start containers
- Wait for startup

**Deployment:**
```bash
cd "$INSTALL_DIR"

info "Pulling Docker images..."
docker compose pull

info "Starting services..."
docker compose up -d

# Wait for containers to start
info "Waiting for services to start..."
sleep 10

# Check container status
if docker compose ps | grep -q "Up"; then
  success "Services started"
else
  error "Some services failed to start"
  docker compose logs
  exit 1
fi
```

**Transitions:**
- → `DB_INIT` (if services started)
- → `ERROR` (if startup failed)

**Exit Criteria:** All containers running

**Persistence:**
```json
{
  "stage": "DEPLOY",
  "containers_started": 5,
  "started_at": "2026-09-15T20:00:00Z"
}
```

---

### 20. DB_INIT
**Entry:** From DEPLOY  
**Actions:**
- Wait for PostgreSQL
- Run database migrations
- Seed initial data (if any)

**Initialization:**
```bash
info "Initializing database..."

# Wait for PostgreSQL
MAX_RETRIES=30
RETRY=0
until docker compose exec -T postgres pg_isready -U aether > /dev/null 2>&1; do
  RETRY=$((RETRY + 1))
  if [[ $RETRY -ge $MAX_RETRIES ]]; then
    error "PostgreSQL did not start in time"
    exit 1
  fi
  echo "Waiting for PostgreSQL... ($RETRY/$MAX_RETRIES)"
  sleep 2
done

success "PostgreSQL is ready"

# Run migrations
info "Running database migrations..."
docker compose exec -T backend npm run migrate

if [[ $? -eq 0 ]]; then
  success "Database initialized"
else
  error "Database initialization failed"
  exit 1
fi
```

**Transitions:**
- → `HEALTH_CHECK` (if DB initialized)
- → `ERROR` (if initialization failed)

**Exit Criteria:** Database ready

**Persistence:**
```json
{
  "stage": "DB_INIT",
  "migrations_run": true,
  "initialized_at": "2026-09-15T20:00:00Z"
}
```

---

### 21. HEALTH_CHECK
**Entry:** From DB_INIT  
**Actions:**
- Check all container health
- Test API endpoints
- Test database connectivity
- Test Redis connectivity

**Health Checks:**
```bash
info "Running health checks..."

# Container health
CONTAINERS=$(docker compose ps --format json | jq -r '.Name')
for container in $CONTAINERS; do
  STATUS=$(docker inspect --format='{{.State.Status}}' $container)
  if [[ "$STATUS" == "running" ]]; then
    success "$container: running"
  else
    error "$container: $STATUS"
  fi
done

# API health endpoint
MAX_RETRIES=30
RETRY=0
until curl -f http://localhost:3000/health > /dev/null 2>&1; do
  RETRY=$((RETRY + 1))
  if [[ $RETRY -ge $MAX_RETRIES ]]; then
    error "Backend API did not respond in time"
    exit 1
  fi
  echo "Waiting for API... ($RETRY/$MAX_RETRIES)"
  sleep 2
done

success "API health check passed"

# Database connectivity
if docker compose exec -T postgres psql -U aether -c "SELECT 1" > /dev/null 2>&1; then
  success "Database connectivity: OK"
else
  error "Database connectivity failed"
fi

# Redis connectivity
if docker compose exec -T redis redis-cli ping | grep -q "PONG"; then
  success "Redis connectivity: OK"
else
  error "Redis connectivity failed"
fi

success "All health checks passed"
```

**Transitions:**
- → `HTTPS_SETUP` (if healthy)
- → `ERROR` (if health checks failed)

**Exit Criteria:** All services healthy

**Persistence:**
```json
{
  "stage": "HEALTH_CHECK",
  "all_healthy": true,
  "checked_at": "2026-09-15T20:00:00Z"
}
```

---

### 22. HTTPS_SETUP
**Entry:** From HEALTH_CHECK  
**Actions:**
- Wait for Caddy to obtain certificate
- Verify HTTPS endpoint
- Update final URL

**HTTPS Setup:**
```bash
if [[ "$HTTPS_ENABLED" == "true" ]]; then
  info "Waiting for HTTPS certificate..."
  info "This may take up to 2 minutes..."
  
  # Caddy obtains certificate automatically
  sleep 30
  
  # Test HTTPS
  MAX_RETRIES=6
  RETRY=0
  until curl -fsSL https://$DOMAIN/health > /dev/null 2>&1; do
    RETRY=$((RETRY + 1))
    if [[ $RETRY -ge $MAX_RETRIES ]]; then
      warning "HTTPS not yet available"
      warning "Certificate may still be provisioning"
      warning "Check: https://$DOMAIN in a few minutes"
      break
    fi
    echo "Waiting for HTTPS... ($RETRY/$MAX_RETRIES)"
    sleep 20
  done
  
  if curl -fsSL https://$DOMAIN/health > /dev/null 2>&1; then
    success "HTTPS is working: https://$DOMAIN"
    FINAL_URL="https://$DOMAIN"
  else
    warning "HTTPS not ready yet"
    warning "Access via HTTP for now: http://$DOMAIN"
    FINAL_URL="http://$DOMAIN"
  fi
else
  info "HTTPS not configured"
  FINAL_URL="http://$PUBLIC_IP"
fi
```

**Transitions:**
- → `PAIRING` (always)

**Exit Criteria:** HTTPS configured or skipped

**Persistence:**
```json
{
  "stage": "HTTPS_SETUP",
  "https_working": true,
  "final_url": "https://cloud.example.com",
  "setup_at": "2026-09-15T20:00:00Z"
}
```

---

### 23. PAIRING
**Entry:** From HTTPS_SETUP  
**Actions:**
- Generate pairing token
- Store in database
- Display to user

**Pairing Setup:**
```bash
info "Generating pairing code..."

# Generate one-time pairing token
PAIRING_TOKEN=$(openssl rand -hex 16)
PAIRING_EXPIRY=$(date -d '+1 hour' -Iseconds)

# Store in database
docker compose exec -T postgres psql -U aether << EOF
INSERT INTO aether.pairing_tokens (token, expires_at, created_at)
VALUES ('$PAIRING_TOKEN', '$PAIRING_EXPIRY', NOW());
EOF

# Save to file (for reference)
cat > .pairing << EOF
Token: $PAIRING_TOKEN
Expires: $PAIRING_EXPIRY
URL: $FINAL_URL
EOF

chmod 600 .pairing

success "Pairing code generated"
```

**Transitions:**
- → `COMPLETE` (always)

**Exit Criteria:** Pairing ready

**Persistence:**
```json
{
  "stage": "PAIRING",
  "token_generated": true,
  "expires_at": "2026-09-15T21:00:00Z"
}
```

---

### 24. COMPLETE
**Entry:** From PAIRING  
**Actions:**
- Save final state
- Display installation summary
- Provide next steps

**Completion:**
```bash
# Update state to SUCCESS
cat > install.state << EOF
{
  "status": "SUCCESS",
  "install_id": "$INSTANCE_ID",
  "version": "0.1.0",
  "installed_at": "$(date -Iseconds)",
  "final_url": "$FINAL_URL",
  "https_enabled": $HTTPS_ENABLED
}
EOF

# Display summary
display_summary
```

**Transitions:**
- → `SUCCESS` (always)

**Exit Criteria:** Installation complete

---

### 25. SUCCESS
**Final State**  
Installation completed successfully.

**Actions:**
- Remove lock file
- Close log file
- Exit with code 0

---

### 26. ERROR
**Entry:** From any stage on error  
**Actions:**
- Log error details
- Display error message
- Ask for retry or rollback

**Error Handling:**
```bash
handle_error() {
  local stage=$1
  local error_message=$2
  
  error "Installation failed at stage: $stage"
  error "Error: $error_message"
  
  # Save error state
  cat > install.state << EOF
{
  "status": "FAILED",
  "install_id": "$INSTANCE_ID",
  "failed_at_stage": "$stage",
  "error": "$error_message",
  "timestamp": "$(date -Iseconds)"
}
EOF
  
  if [[ "$INTERACTIVE" == "true" ]]; then
    echo ""
    echo "What would you like to do?"
    echo "  1) Retry this stage"
    echo "  2) Rollback changes"
    echo "  3) Exit (save state for later)"
    read -p "Choice [1-3]: " choice
    
    case $choice in
      1) return 0 ;;  # Retry
      2) rollback ;;
      *) exit 1 ;;
    esac
  else
    exit 1
  fi
}
```

**Transitions:**
- → Previous stage (if retry)
- → `ROLLBACK` (if rollback chosen)
- → `FAILED` (if exit)

---

### 27. ROLLBACK
**Entry:** From ERROR  
**Actions:**
- Stop containers
- Remove installation directory (optional)
- Restore firewall rules
- Clean up

**Rollback:**
```bash
rollback() {
  warning "Rolling back installation..."
  
  cd "$INSTALL_DIR" 2>/dev/null || true
  
  # Stop containers
  if [[ -f docker-compose.yml ]]; then
    info "Stopping containers..."
    docker compose down
  fi
  
  # Ask about data
  if [[ "$INTERACTIVE" == "true" ]]; then
    read -p "Remove installation directory? [y/N] " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
      info "Removing installation..."
      cd /
      $SUDO rm -rf "$INSTALL_DIR"
      success "Installation removed"
    else
      info "Installation directory preserved"
    fi
  fi
  
  # Restore firewall
  if [[ -f backups/ufw-backup-*.txt ]]; then
    warning "Firewall rules were modified"
    info "To restore: sudo ufw reset"
  fi
  
  success "Rollback complete"
}
```

**Transitions:**
- → `CLEANUP` (always)

---

### 28. CLEANUP
**Entry:** From ROLLBACK or EXIT  
**Actions:**
- Remove lock file
- Remove temp files
- Close log

**Cleanup:**
```bash
cleanup() {
  # Remove lock
  rm -f /tmp/aether-install.lock
  
  # Remove temp files
  rm -f /tmp/aether-*
  
  # Preserve log
  if [[ -f /tmp/aether-install.log ]]; then
    mv /tmp/aether-install.log "$INSTALL_DIR/logs/install.log" 2>/dev/null || true
  fi
}

trap cleanup EXIT
```

**Transitions:**
- → `FAILED` (exit code 1)

---

### 29. FAILED
**Final State**  
Installation failed and rolled back.

**Exit Code:** 1

---

## State Persistence

**State File Location:** `/opt/aether/install.state`

**State File Format:**
```json
{
  "status": "IN_PROGRESS",
  "install_id": "uuid",
  "version": "0.1.0",
  "started_at": "2026-09-15T19:00:00Z",
  "current_stage": "DEPLOY",
  "stages_completed": [
    "INITIALIZE",
    "PREFLIGHT",
    "OS_DETECT",
    "RESOURCE_CHK",
    "NETWORK_CHK",
    "PERMISSION",
    "CONFLICT_CHK",
    "DEP_DETECT",
    "DEP_INSTALL",
    "DOCKER_SETUP",
    "DOWNLOAD",
    "VERIFY",
    "EXTRACT",
    "CONFIGURE",
    "SECRETS",
    "DOMAIN",
    "FIREWALL"
  ],
  "stage_data": {
    "OS_DETECT": { ... },
    "RESOURCE_CHK": { ... },
    ...
  },
  "errors": [],
  "warnings": [],
  "config": {
    "install_dir": "/opt/aether",
    "domain": "cloud.example.com",
    "https_enabled": true
  }
}
```

---

## Resume Logic

```bash
resume_installation() {
  if [[ -f "$INSTALL_DIR/install.state" ]]; then
    STATE=$(cat "$INSTALL_DIR/install.state")
    STATUS=$(echo "$STATE" | jq -r '.status')
    CURRENT_STAGE=$(echo "$STATE" | jq -r '.current_stage')
    
    if [[ "$STATUS" == "IN_PROGRESS" || "$STATUS" == "FAILED" ]]; then
      info "Found incomplete installation"
      info "Last stage: $CURRENT_STAGE"
      
      if [[ "$INTERACTIVE" == "true" ]]; then
        read -p "Resume from last stage? [Y/n] " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
          # Resume from CURRENT_STAGE
          run_stage "$CURRENT_STAGE"
          return
        fi
      fi
    fi
  fi
  
  # Start fresh installation
  run_stage "INITIALIZE"
}
```

---

## Transition Rules

### Automatic Transitions
- Success → Next stage
- Critical error → ERROR
- User cancellation → CLEANUP

### Conditional Transitions
- Dependencies missing → DEP_INSTALL
- Dependencies present → DOCKER_SETUP
- Domain provided → DNS verification
- No domain → Skip HTTPS

### Error Transitions
- Retryable error → Retry same stage
- Non-retryable error → ROLLBACK
- User abort → CLEANUP

---

## Stage Timeouts

```bash
STAGE_TIMEOUTS=(
  [PREFLIGHT]=60
  [OS_DETECT]=10
  [RESOURCE_CHK]=10
  [NETWORK_CHK]=30
  [PERMISSION]=10
  [CONFLICT_CHK]=10
  [DEP_DETECT]=10
  [DEP_INSTALL]=300
  [DOCKER_SETUP]=120
  [DOWNLOAD]=300
  [VERIFY]=10
  [EXTRACT]=60
  [CONFIGURE]=10
  [SECRETS]=10
  [DOMAIN]=30
  [FIREWALL]=30
  [DEPLOY]=180
  [DB_INIT]=120
  [HEALTH_CHECK]=180
  [HTTPS_SETUP]=180
  [PAIRING]=10
)
```

---

## Lock File Management

**Lock File:** `/tmp/aether-install.lock`

```bash
acquire_lock() {
  if [[ -f /tmp/aether-install.lock ]]; then
    LOCK_PID=$(cat /tmp/aether-install.lock)
    if ps -p $LOCK_PID > /dev/null; then
      error "Another installation is already running (PID: $LOCK_PID)"
      exit 1
    else
      warning "Stale lock file found, removing"
      rm -f /tmp/aether-install.lock
    fi
  fi
  
  echo $$ > /tmp/aether-install.lock
}

release_lock() {
  rm -f /tmp/aether-install.lock
}

trap release_lock EXIT
```

---

## Progress Display

```bash
display_progress() {
  local current_stage=$1
  local total_stages=24
  local completed_stages=${#STAGES_COMPLETED[@]}
  
  local percentage=$((completed_stages * 100 / total_stages))
  
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  Aether Cloud OS Installation"
  echo "  Progress: $percentage% ($completed_stages/$total_stages stages)"
  echo "  Current: $current_stage"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
}
```

---

**Document Status:** Draft for Review  
**Last Updated:** 2026-09-15 20:00 UTC  
**Next:** Security model and test matrix

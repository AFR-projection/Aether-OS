# Aether Installer - Architecture Design

**Version:** 1.0.0  
**Date:** 2026-09-15  
**Status:** Draft - Design Phase

---

## Executive Summary

Aether Cloud OS membutuhkan **one-command installer** yang dapat:

- Menginstall dari zero ke production dalam satu command
- Mendeteksi dan validasi VPS environment
- Menginstall dependencies secara otomatis
- Setup Docker, database, dan semua services
- Konfigurasi HTTPS otomatis dengan Caddy
- Aman, dapat diaudit, dan dapat di-rollback

**Target user experience:**

```bash
curl -fsSL https://aether-os.io/install.sh | bash
```

---

## Design Principles

### 1. Safety First

- **Idempotent** - dapat dijalankan berulang kali
- **Reversible** - dapat di-rollback
- **Non-destructive** - tidak menghapus data user
- **Auditable** - semua operasi tercatat
- **Fail-safe** - error handling di setiap tahap

### 2. User Experience

- **Clear progress** - tahapan yang jelas
- **Informative** - explain what's happening
- **Confirmable** - ask before destructive operations
- **Recoverable** - resume from failures
- **Transparent** - log everything

### 3. Security

- **Verified downloads** - checksum validation
- **Secure secrets** - generated randomly
- **Minimal privileges** - least privilege principle
- **Network safety** - firewall configuration
- **No default credentials** - force generation

### 4. Compatibility

- **Detect before act** - check environment first
- **Clear requirements** - explicit minimum specs
- **Graceful degradation** - work with what's available
- **Version awareness** - track installed versions
- **Migration support** - upgrade paths

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Installer Entry Point                     │
│                      (install.sh)                            │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                  Pre-flight Checks                           │
│  ┌──────────────┬──────────────┬──────────────┬──────────┐ │
│  │ OS Detection │  Resources   │   Network    │  Perms   │ │
│  └──────────────┴──────────────┴──────────────┴──────────┘ │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│              Dependency Management                           │
│  ┌──────────────┬──────────────┬──────────────────────────┐ │
│  │   Docker     │ Docker Comp  │   System Packages        │ │
│  └──────────────┴──────────────┴──────────────────────────┘ │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│               Release Management                             │
│  ┌──────────────┬──────────────┬──────────────────────────┐ │
│  │  Download    │   Verify     │      Extract             │ │
│  └──────────────┴──────────────┴──────────────────────────┘ │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│            Configuration Generation                          │
│  ┌──────────────┬──────────────┬──────────────────────────┐ │
│  │   Secrets    │    Domain    │      Ports               │ │
│  └──────────────┴──────────────┴──────────────────────────┘ │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│              Service Deployment                              │
│  ┌──────────────┬──────────────┬──────────────────────────┐ │
│  │   Compose    │  Database    │       Caddy              │ │
│  └──────────────┴──────────────┴──────────────────────────┘ │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                Health Checks                                 │
│  ┌──────────────┬──────────────┬──────────────────────────┐ │
│  │   Services   │   Database   │        HTTPS             │ │
│  └──────────────┴──────────────┴──────────────────────────┘ │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                Installation Summary                          │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  URL, Credentials, Status, Next Steps                │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## Component Architecture

### 1. Installer Core (`install.sh`)

**Responsibilities:**

- Entry point execution
- Command-line argument parsing
- Main orchestration logic
- Error handling and recovery
- Logging and progress display
- State management
- Lock file management

**Key Functions:**

```bash
main()                    # Entry point
parse_args()              # Parse CLI arguments
check_lock()              # Prevent concurrent runs
create_state()            # Initialize state file
load_state()              # Resume from state
save_state()              # Persist current state
cleanup()                 # Cleanup on exit
handle_error()            # Error handler
```

### 2. Preflight Module

**Responsibilities:**

- OS and architecture detection
- Resource checking (CPU, RAM, disk)
- Network connectivity validation
- Permission verification
- Existing installation detection
- Conflict detection

**Detection Matrix:**

```
Operating System:
  - Ubuntu 20.04/22.04/24.04 LTS (✅ Supported)
  - Debian 11/12 (🔄 Future)
  - CentOS/Rocky/Alma (🔄 Future)
  - Other Linux (⚠️ Unsupported)
  - Non-Linux (❌ Blocked)

Architecture:
  - x86_64/amd64 (✅ Supported)
  - arm64/aarch64 (🔄 Future)
  - Other (❌ Blocked)

Resources:
  Minimum:
    - 2 vCPU
    - 4 GB RAM
    - 40 GB free disk

  Recommended:
    - 4 vCPU
    - 8 GB RAM
    - 80 GB free disk
```

### 3. Dependency Manager

**Responsibilities:**

- Detect existing dependencies
- Install missing dependencies
- Verify versions
- Configure services
- Test installations

**Managed Dependencies:**

```
System Packages:
  - curl
  - wget
  - git
  - openssl
  - ca-certificates

Docker:
  - Docker Engine (latest stable)
  - Docker Compose v2
  - Docker daemon configuration
  - User permissions

Optional:
  - ufw/firewalld (if needed)
```

### 4. Release Manager

**Responsibilities:**

- Determine target release version
- Download release artifacts
- Verify checksums
- Verify signatures (future)
- Extract and prepare files
- Track installed version

**Release Structure:**

```
Release Artifact:
  aether-<version>-<arch>.tar.gz
    ├── manifest.json           # Version, checksums, metadata
    ├── docker-compose.yml      # Production compose file
    ├── .env.template           # Environment template
    ├── caddy/
    │   └── Caddyfile          # Reverse proxy config
    ├── scripts/
    │   ├── init-db.sql        # Database initialization
    │   └── healthcheck.sh     # Health check script
    └── checksums.txt          # File integrity
```

**Release Channels:**

- `stable` - Production releases (default)
- `beta` - Pre-release testing
- `development` - Bleeding edge (explicit opt-in)

### 5. Configuration Generator

**Responsibilities:**

- Generate installation config
- Create secure secrets
- Domain configuration
- Port allocation
- Network configuration
- Environment file generation

**Generated Artifacts:**

```
/opt/aether/
  ├── .env                      # Main configuration
  ├── instance.json             # Instance metadata
  ├── secrets/
  │   ├── db_password
  │   ├── redis_password
  │   ├── jwt_secret
  │   ├── encryption_key
  │   └── session_secret
  └── backups/                  # Config backups
```

**Secret Generation:**

- JWT_SECRET: 64 bytes random base64
- ENCRYPTION_KEY: 32 bytes random hex
- SESSION_SECRET: 64 bytes random base64
- DB_PASSWORD: 32 char alphanumeric
- REDIS_PASSWORD: 32 char alphanumeric
- MINIO keys if needed

### 6. Service Deployer

**Responsibilities:**

- Generate docker-compose.yml
- Configure services
- Start containers
- Run database migrations
- Configure Caddy
- Setup systemd services (optional)

**Service Stack:**

```yaml
services:
  caddy: # Reverse proxy + HTTPS
  frontend: # React application
  backend: # API server
  postgres: # Database
  redis: # Cache
  minio: # Object storage (optional)
```

**Network Architecture:**

```
Internet
    │
    ├─► Port 80/443 ─► Caddy ─┬─► Frontend (internal)
    │                          └─► Backend API (internal)
    │
    └─► Port 22 ─► SSH (preserved)

Internal Network:
  - PostgreSQL: internal only
  - Redis: internal only
  - MinIO: internal only
  - Backend: via Caddy only
  - Frontend: via Caddy only
```

### 7. Health Checker

**Responsibilities:**

- Wait for services to start
- Verify database connectivity
- Check API endpoints
- Verify HTTPS certificate
- Run smoke tests
- Report status

**Health Checks:**

```bash
1. Docker containers running
2. PostgreSQL accepting connections
3. Redis responding to ping
4. Backend /health endpoint
5. Frontend served
6. Caddy certificate valid
7. Domain accessible
```

### 8. State Manager

**Responsibilities:**

- Track installation progress
- Enable resume on failure
- Support rollback
- Version tracking
- Audit trail

**State File (`/opt/aether/install.state`):**

```json
{
  "version": "1.0.0",
  "install_id": "uuid",
  "started_at": "2026-09-15T19:57:00Z",
  "stage": "health_check",
  "stages_completed": ["preflight", "dependencies", "download", "configure", "deploy"],
  "release": {
    "version": "0.1.0",
    "channel": "stable",
    "checksum": "sha256..."
  },
  "config": {
    "domain": "cloud.example.com",
    "install_dir": "/opt/aether",
    "https_enabled": true
  }
}
```

---

## Installation Stages

### Stage 1: Preflight Check (MANDATORY)

```
[1/19] Preflight Check
  ├─ [✓] Detecting operating system... Ubuntu 22.04 LTS
  ├─ [✓] Checking architecture... x86_64
  ├─ [✓] Verifying CPU... 4 cores (min: 2, recommended: 4)
  ├─ [✓] Checking RAM... 8 GB (min: 4 GB, recommended: 8 GB)
  ├─ [✓] Checking disk space... 120 GB free (min: 40 GB)
  ├─ [✓] Testing network connectivity... OK
  ├─ [✓] Resolving DNS... OK
  ├─ [✓] Checking permissions... sudo available
  └─ [✓] Checking for conflicts... None detected
```

**Exit Criteria:**

- OS supported
- Resources meet minimum
- Network accessible
- User has privileges
- No blocking conflicts

### Stage 2: OS and Architecture Detection

**Detect:**

- `/etc/os-release`
- `uname -m`
- `uname -r`
- Package manager (apt, yum, dnf)
- Init system (systemd, upstart)

### Stage 3: Resource Check

**Check:**

- `nproc` for CPU count
- `/proc/meminfo` for RAM
- `df -h` for disk space
- I/O performance (optional)

**Thresholds:**

- Block if < minimum
- Warn if < recommended
- Continue if ≥ recommended

### Stage 4: Permission Check

**Verify:**

- Current user
- sudo availability: `sudo -n true`
- Docker group membership (if exists)
- File system write permissions

### Stage 5: Network and DNS Check

**Test:**

- Internet connectivity: `curl -fsSL https://google.com`
- DNS resolution: `nslookup aether-os.io`
- Port availability: 80, 443
- Firewall status

### Stage 6: Dependency Detection

**Scan for:**

- Docker: `docker --version`
- Docker Compose: `docker compose version`
- curl, wget, git, openssl
- Existing web servers (nginx, apache)
- Existing reverse proxies

### Stage 7: Dependency Installation

**Install if missing:**

```bash
# Update package index
sudo apt-get update

# Install system packages
sudo apt-get install -y \
  curl \
  wget \
  git \
  openssl \
  ca-certificates

# Install Docker (if needed)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Verify installations
docker --version
docker compose version
```

### Stage 8: Docker Configuration

**Configure:**

- Enable Docker daemon
- Start Docker service
- Verify Docker socket
- Test with hello-world
- Configure daemon.json if needed

### Stage 9: Release Download

**Download:**

```bash
# Determine version
VERSION=${AETHER_VERSION:-stable}
CHANNEL=${AETHER_CHANNEL:-stable}

# Download release
curl -fsSL "https://releases.aether-os.io/${VERSION}/aether-${VERSION}-amd64.tar.gz" \
  -o /tmp/aether-release.tar.gz

# Download checksums
curl -fsSL "https://releases.aether-os.io/${VERSION}/checksums.txt" \
  -o /tmp/aether-checksums.txt
```

### Stage 10: Integrity Verification

**Verify:**

```bash
# Verify checksum
cd /tmp
sha256sum -c aether-checksums.txt --ignore-missing

# Verify signature (future)
# gpg --verify aether-release.tar.gz.sig aether-release.tar.gz
```

**If verification fails:**

- Abort installation
- Report error
- Do not extract
- Do not run any code from download

### Stage 11: Configuration Generation

**Generate:**

```bash
# Create installation directory
sudo mkdir -p /opt/aether
sudo chown $USER:$USER /opt/aether

# Extract release
tar -xzf /tmp/aether-release.tar.gz -C /opt/aether

# Generate secrets
generate_secret() {
  openssl rand -base64 64 | tr -d '\n'
}

# Create .env
cat > /opt/aether/.env << EOF
# Generated by Aether Installer
# Install ID: $(uuidgen)
# Date: $(date -Iseconds)

NODE_ENV=production
PORT=3000
DATABASE_URL=postgresql://aether:$(generate_password)@postgres:5432/aether_prod
REDIS_URL=redis://:$(generate_password)@redis:6379
JWT_SECRET=$(generate_secret)
ENCRYPTION_KEY=$(openssl rand -hex 32)
SESSION_SECRET=$(generate_secret)
EOF

chmod 600 /opt/aether/.env
```

### Stage 12: Port Allocation

**Check ports:**

```bash
check_port() {
  nc -z localhost $1 2>/dev/null
  return $?
}

# Check required ports
for port in 80 443; do
  if check_port $port; then
    echo "❌ Port $port is already in use"
    # Offer alternatives or abort
  fi
done
```

### Stage 13: Firewall Configuration

**Configure UFW (if present):**

```bash
if command -v ufw &> /dev/null; then
  echo "Configuring firewall..."

  # Backup current rules
  sudo ufw status numbered > /opt/aether/backups/ufw-backup.txt

  # Allow SSH (prevent lockout)
  sudo ufw allow ssh

  # Allow HTTP/HTTPS
  sudo ufw allow 80/tcp
  sudo ufw allow 443/tcp

  # Enable firewall
  sudo ufw --force enable
fi
```

### Stage 14: Docker Compose Startup

**Start services:**

```bash
cd /opt/aether

# Pull images
docker compose pull

# Start services
docker compose up -d

# Wait for startup
sleep 10
```

### Stage 15: Database Initialization

**Run migrations:**

```bash
# Wait for PostgreSQL
until docker compose exec postgres pg_isready; do
  echo "Waiting for PostgreSQL..."
  sleep 2
done

# Run initialization
docker compose exec backend npm run migrate
```

### Stage 16: Health Check

**Verify all services:**

```bash
echo "Running health checks..."

# Check containers
docker compose ps

# Check backend health
curl -f http://localhost:3000/health || exit 1

# Check database
docker compose exec postgres psql -U aether -c "SELECT 1" || exit 1

# Check Redis
docker compose exec redis redis-cli ping || exit 1
```

### Stage 17: HTTPS/Caddy Setup

**If domain provided:**

```bash
# Verify domain points to this server
SERVER_IP=$(curl -s https://api.ipify.org)
DOMAIN_IP=$(dig +short $DOMAIN | tail -n1)

if [ "$SERVER_IP" != "$DOMAIN_IP" ]; then
  echo "⚠️  Warning: Domain does not point to this server"
  echo "   Server IP: $SERVER_IP"
  echo "   Domain IP: $DOMAIN_IP"
  echo "   HTTPS certificate will fail until DNS is correct"
fi

# Caddy will auto-obtain certificate
echo "Waiting for HTTPS certificate..."
sleep 30

# Verify HTTPS
curl -f https://$DOMAIN/health || echo "⚠️  HTTPS not ready yet"
```

### Stage 18: Initial Admin/Pairing Setup

**Generate pairing code:**

```bash
# Generate one-time pairing token
PAIRING_TOKEN=$(openssl rand -hex 16)

# Store in database
docker compose exec backend node -e "
  const token = '$PAIRING_TOKEN';
  // Store in database with expiry
"

echo ""
echo "╔════════════════════════════════════════════════════════╗"
echo "║         Aether Cloud OS - Initial Setup                ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""
echo "  Pairing Code: $PAIRING_TOKEN"
echo "  Valid for: 1 hour"
echo ""
echo "  Use this code to pair your first device."
echo ""
```

### Stage 19: Final Summary

**Display installation summary:**

```bash
echo "╔════════════════════════════════════════════════════════╗"
echo "║      🎉 Aether Cloud OS Installation Complete!        ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""
echo "  Installation Directory: /opt/aether"
echo "  Version: 0.1.0"
echo "  Channel: stable"
echo ""
echo "  Access URLs:"
echo "    • Web Interface: https://cloud.example.com"
echo "    • API Endpoint: https://cloud.example.com/api"
echo ""
echo "  Services Running:"
echo "    • Frontend: ✓"
echo "    • Backend: ✓"
echo "    • Database: ✓"
echo "    • Cache: ✓"
echo "    • Reverse Proxy: ✓"
echo ""
echo "  Next Steps:"
echo "    1. Visit https://cloud.example.com"
echo "    2. Enter pairing code: $PAIRING_TOKEN"
echo "    3. Complete initial setup wizard"
echo ""
echo "  Useful Commands:"
echo "    • Status: aether status"
echo "    • Logs: aether logs"
echo "    • Restart: aether restart"
echo "    • Update: aether update"
echo "    • Uninstall: aether uninstall"
echo ""
echo "  Documentation: https://docs.aether-os.io"
echo "  Support: https://support.aether-os.io"
echo ""
```

---

## File Structure

```
/opt/aether/                           # Installation directory
├── .env                               # Main configuration (600)
├── .env.backup                        # Configuration backup
├── install.state                      # Installation state
├── instance.json                      # Instance metadata
├── docker-compose.yml                 # Service definitions
├── compose/                           # Compose overrides
│   ├── production.yml
│   └── development.yml
├── data/                              # Persistent data
│   ├── postgres/                      # Database data
│   ├── redis/                         # Cache data
│   └── minio/                         # Object storage
├── logs/                              # Application logs
│   ├── installer.log
│   ├── backend/
│   ├── frontend/
│   └── caddy/
├── backups/                           # Configuration backups
│   ├── env-backup-*.txt
│   └── ufw-backup.txt
├── scripts/                           # Helper scripts
│   ├── aether                         # CLI command
│   ├── healthcheck.sh
│   ├── backup.sh
│   └── restore.sh
├── caddy/                             # Caddy configuration
│   ├── Caddyfile
│   └── data/                          # Certificates
└── releases/                          # Release tracking
    ├── current -> v0.1.0
    ├── v0.1.0/
    └── v0.2.0/
```

---

## CLI Interface

### Installation Commands

```bash
# Basic installation
curl -fsSL https://aether-os.io/install.sh | bash

# With domain
curl -fsSL https://aether-os.io/install.sh | bash -s -- --domain cloud.example.com

# Dry run (check only)
curl -fsSL https://aether-os.io/install.sh | bash -s -- --dry-run

# Non-interactive with defaults
curl -fsSL https://aether-os.io/install.sh | bash -s -- --yes

# Development channel
curl -fsSL https://aether-os.io/install.sh | bash -s -- --channel development

# Custom directory
curl -fsSL https://aether-os.io/install.sh | bash -s -- --install-dir /home/user/aether

# No HTTPS (development only)
curl -fsSL https://aether-os.io/install.sh | bash -s -- --no-https
```

### Management Commands

```bash
# Check status
aether status

# View logs
aether logs [service]

# Restart services
aether restart [service]

# Update to latest
aether update

# Update to specific version
aether update --version 0.2.0

# Rollback to previous version
aether rollback

# Backup configuration
aether backup

# Restore from backup
aether restore [backup-file]

# Repair installation
aether repair

# Uninstall (keep data)
aether uninstall

# Uninstall (remove data)
aether uninstall --purge
```

---

## Error Handling

### Error Categories

1. **Preflight Failures** - environment not compatible
2. **Network Failures** - cannot download
3. **Permission Failures** - insufficient privileges
4. **Dependency Failures** - cannot install requirements
5. **Verification Failures** - checksum mismatch
6. **Configuration Failures** - cannot generate config
7. **Deployment Failures** - services won't start
8. **Health Check Failures** - services unhealthy

### Recovery Strategies

**For each error:**

1. Log detailed error information
2. Save current state
3. Cleanup partial changes if safe
4. Display helpful error message
5. Suggest remediation steps
6. Provide support contact

**Resume capability:**

```bash
# Installer can resume from last successful stage
./install.sh --resume
```

---

## Security Model

### Threat Model

**Threats:**

1. Man-in-the-middle during download
2. Compromised release artifact
3. Credential leakage
4. Privilege escalation
5. Docker socket exposure
6. Network misconfiguration
7. DNS hijacking
8. Supply chain attack

**Mitigations:**

1. HTTPS for all downloads
2. Checksum verification (mandatory)
3. Signature verification (future)
4. Secure secret generation
5. Minimal container privileges
6. Network isolation
7. Firewall configuration
8. Reproducible builds (future)

### Security Checklist

- [ ] Downloads over HTTPS only
- [ ] Checksum verification before extraction
- [ ] No default passwords
- [ ] Secrets stored with 600 permissions
- [ ] Database not exposed to internet
- [ ] Redis not exposed to internet
- [ ] Docker socket not mounted in containers
- [ ] Containers run as non-root (where possible)
- [ ] Firewall configured to block internal services
- [ ] HTTPS enforced for web access
- [ ] Audit logs enabled
- [ ] Regular security updates

---

## Testing Strategy

### Test Environments

1. **Fresh Ubuntu 22.04** - pristine VPS
2. **Ubuntu with Docker** - Docker pre-installed
3. **Low resource VPS** - minimum specs
4. **High resource VPS** - above recommended
5. **Multiple installations** - re-run installer
6. **Interrupted installation** - kill midway
7. **Conflicting ports** - port 80/443 occupied
8. **No domain** - IP-only access
9. **Invalid domain** - DNS not pointing
10. **Firewall active** - UFW enabled

### Automated Tests

```bash
# Test matrix
tests/
├── test-fresh-install.sh
├── test-existing-docker.sh
├── test-low-resources.sh
├── test-resume.sh
├── test-rollback.sh
├── test-uninstall.sh
└── test-upgrade.sh
```

---

## Rollout Plan

### Phase 1: MVP Installer (Week 1-2)

- [ ] Basic install.sh with preflight checks
- [ ] Docker installation
- [ ] Release download with checksum
- [ ] Configuration generation
- [ ] Docker Compose deployment
- [ ] Basic health checks
- [ ] Ubuntu 22.04 support only

### Phase 2: Production Features (Week 3-4)

- [ ] Domain configuration
- [ ] Caddy + HTTPS automation
- [ ] Firewall configuration
- [ ] State management and resume
- [ ] Rollback capability
- [ ] CLI management tools

### Phase 3: Advanced Features (Week 5-6)

- [ ] Signature verification
- [ ] Update mechanism
- [ ] Backup/restore
- [ ] Multi-architecture support
- [ ] More OS support (Debian, etc.)
- [ ] Comprehensive testing

---

## Success Criteria

**Installation is considered successful when:**

1. ✅ All preflight checks pass
2. ✅ All dependencies installed
3. ✅ Docker Compose services running
4. ✅ Database initialized and accessible
5. ✅ Health checks passing
6. ✅ Web interface accessible
7. ✅ HTTPS certificate valid (if domain provided)
8. ✅ Pairing code generated
9. ✅ No security warnings
10. ✅ State file saved with success status

**User can:**

- Access Aether via web browser
- Complete initial setup wizard
- Pair devices
- Use all core features
- Run management commands

---

## Open Questions

1. **Release hosting** - where to host release artifacts?
2. **Signature verification** - GPG keys? Signing process?
3. **Update frequency** - automatic updates? manual only?
4. **Telemetry** - collect installation metrics? opt-in/out?
5. **Support tiers** - community vs commercial installations?
6. **Licensing** - verification during install?
7. **Backup strategy** - automatic backups? where to store?
8. **Monitoring** - integrate with monitoring services?

---

## Next Steps

1. Create detailed state machine diagram
2. Write security threat model document
3. Design test matrix
4. Implement install.sh MVP
5. Create release artifact structure
6. Build CI for release packaging
7. Test on fresh Ubuntu VPS
8. Document troubleshooting guide
9. Create operations runbook
10. Plan rollback procedures

---

**Document Status:** Draft for Review  
**Last Updated:** 2026-09-15  
**Next Review:** After implementation begins

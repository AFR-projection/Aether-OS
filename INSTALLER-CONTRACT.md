# Aether Installer - Contract Specification

**Version:** 1.0.0  
**Date:** 2026-09-15  
**Status:** Draft - Contract Definition

---

## Purpose

This document defines the **explicit contract** between the Aether installer and the target system. It specifies what the installer is allowed to do, what it requires, and what guarantees it provides.

**This is a binding specification:** The installer MUST NOT exceed these boundaries.

---

## 1. Supported Platforms

### 1.1 Operating Systems (MVP)

**SUPPORTED (Tested and Validated):**
- Ubuntu 22.04 LTS (x86_64) ✅ PRIMARY TARGET

**PROVISIONAL (Should work, not yet fully tested):**
- Ubuntu 20.04 LTS (x86_64) ⚠️ PROVISIONAL
- Ubuntu 24.04 LTS (x86_64) ⚠️ PROVISIONAL

**NOT SUPPORTED (Will be blocked):**
- Debian (any version) ❌
- CentOS / Rocky Linux / AlmaLinux ❌
- Fedora ❌
- Arch Linux ❌
- Non-Linux systems ❌

**Contract:**
> The installer MUST detect the operating system and MUST block installation on unsupported platforms with a clear error message and recommendations.

---

### 1.2 Architecture

**SUPPORTED:**
- x86_64 (amd64) ✅

**NOT SUPPORTED:**
- ARM64 (aarch64) ❌
- ARMv7 ❌
- i386 / i686 ❌
- RISC-V ❌

**Contract:**
> The installer MUST detect the CPU architecture and MUST block installation on unsupported architectures.

---

### 1.3 Init System

**REQUIRED:**
- systemd ✅

**NOT SUPPORTED:**
- SysVinit ❌
- Upstart ❌
- OpenRC ❌

**Contract:**
> The installer MUST verify systemd is available and MUST block installation if systemd is not the init system.

---

## 2. Resource Requirements

### 2.1 Hardware Resources

**MINIMUM (Installation will proceed with warning):**
- CPU: 2 cores
- RAM: 4 GB
- Disk: 40 GB free space

**RECOMMENDED (Optimal performance):**
- CPU: 4 cores
- RAM: 8 GB
- Disk: 80 GB free space

**BLOCKING THRESHOLDS (Installation will be blocked):**
- CPU: < 1 core
- RAM: < 2 GB
- Disk: < 20 GB free

**⚠️ IMPORTANT DISCLAIMER:**
> These resource requirements are **PROVISIONAL** and based on estimates. Actual requirements will be validated through testing. The installer may consume additional resources during installation.

**Contract:**
> The installer MUST check resources during preflight and MUST:
> - Block if below blocking thresholds
> - Warn if below minimum requirements
> - Display actual vs required resources
> - Ask for confirmation if below recommended

---

### 2.2 Network Resources

**REQUIRED:**
- Internet connectivity (HTTPS outbound on port 443) ✅
- DNS resolution ✅

**OPTIONAL:**
- Public IP address (for external access)
- Domain name (for HTTPS)

**Contract:**
> The installer MUST verify internet connectivity and DNS resolution. The installer MAY proceed without a public IP or domain, but will warn about limited accessibility.

---

## 3. User Permissions

### 3.1 Required Permissions

**MANDATORY:**
- User MUST have `sudo` access ✅
- User MUST be able to execute `sudo apt-get` ✅
- User MUST be able to write to installation directory ✅

**OPTIONAL:**
- User MAY be in `docker` group (will be added if not)
- User MAY be root (not recommended, will warn)

**Contract:**
> The installer MUST verify sudo availability and MUST block if sudo is not available or not configured correctly.

---

### 3.2 Privilege Escalation

**The installer will use `sudo` for:**
- Installing system packages (`apt-get install`)
- Enabling/starting systemd services (`systemctl`)
- Configuring firewall (`ufw`)
- Adding user to docker group (`usermod`)
- Creating directories in `/opt` if needed

**The installer will NOT use `sudo` for:**
- Creating files in installation directory
- Downloading files
- Generating configuration
- Running Docker commands (after user is in docker group OR using sudo)

**Contract:**
> The installer MUST use least privilege and MUST only escalate to root when necessary. All sudo commands MUST be logged.

---

## 4. System Modifications

### 4.1 Packages Installed

**The installer MAY install the following system packages:**

**Always installed (if missing):**
- `curl`
- `wget`
- `git`
- `openssl`
- `ca-certificates`

**Installed if Docker is missing:**
- Docker Engine (via official Docker installation script)
- Docker Compose v2 (included with Docker Engine)

**Contract:**
> The installer MUST NOT install packages beyond this list without explicit user consent. The installer MUST detect existing packages and skip installation.

---

### 4.2 Services Modified

**The installer MAY enable and start:**
- `docker` service (systemd)

**The installer MAY create:**
- Docker containers for Aether services

**The installer MUST NOT:**
- Stop or disable existing services
- Modify existing Docker containers
- Interfere with other applications

**Contract:**
> The installer MUST only manage services it creates. Existing services MUST NOT be modified.

---

### 4.3 Firewall Configuration

**The installer MAY modify firewall rules if UFW is installed:**

**Will allow:**
- SSH (on detected port, default 22)
- HTTP (port 80)
- HTTPS (port 443)

**Will explicitly deny:**
- PostgreSQL (port 5432)
- Redis (port 6379)
- Backend API direct access (port 3000)

**Contract:**
> The installer MUST:
> - Backup existing firewall rules before changes
> - Show proposed changes before applying
> - Ask for confirmation
> - Always allow SSH FIRST (to prevent lockout)
> - Verify SSH connectivity after changes
> - Provide rollback instructions

**The installer MUST NOT:**
> - Disable the firewall
> - Remove existing rules without backing up
> - Block SSH

---

### 4.4 Ports Used

**The installer will bind to the following ports:**

**External (accessible from internet):**
- Port 80 (HTTP) - Caddy reverse proxy
- Port 443 (HTTPS) - Caddy reverse proxy

**Internal only (Docker network):**
- Port 5432 - PostgreSQL
- Port 6379 - Redis
- Port 3000 - Backend API
- Port 5173 - Frontend dev server (if in dev mode)

**Contract:**
> The installer MUST verify ports 80 and 443 are available. If occupied, the installer MUST:
> - Detect what is using the port
> - Warn the user
> - Offer alternatives or abort

---

## 5. File System Layout

### 5.1 Installation Directory

**Default:**
```
/opt/aether/
```

**Allowed alternatives:**
- `/home/<user>/aether/` (if `/opt` is not writable)
- User-specified via `--install-dir` (with restrictions)

**Restrictions on custom directory:**
- MUST be under `/opt` or `/home`
- MUST NOT be under `/etc`, `/var`, `/usr`, `/bin`, `/sbin`, `/boot`, `/root`
- MUST NOT contain path traversal (`..`)
- MUST NOT be a symlink to restricted location

**Contract:**
> The installer MUST validate installation directory and MUST reject unsafe locations.

---

### 5.2 Directory Structure

**The installer will create:**
```
/opt/aether/
├── .env                          # Main configuration (600 permissions)
├── .env.backup                   # Backup of configuration
├── install.state                 # Installation state (JSON)
├── instance.json                 # Instance metadata
├── docker-compose.yml            # Service definitions
├── data/                         # Persistent data
│   ├── postgres/                 # Database data
│   ├── redis/                    # Cache data
│   └── minio/                    # Object storage (optional)
├── logs/                         # Application logs
│   ├── installer.log             # Installer log
│   ├── backend/                  # Backend logs
│   ├── frontend/                 # Frontend logs
│   └── caddy/                    # Caddy logs
├── backups/                      # Configuration backups
│   ├── env-backup-*.txt
│   └── ufw-backup-*.txt
├── secrets/                      # Secret files (600 permissions)
│   ├── db_password
│   ├── redis_password
│   ├── jwt_secret
│   ├── encryption_key
│   └── session_secret
├── caddy/                        # Caddy configuration
│   ├── Caddyfile
│   └── data/                     # SSL certificates
└── scripts/                      # Helper scripts
    ├── aether                    # CLI command
    ├── healthcheck.sh
    └── backup.sh
```

**Contract:**
> The installer MUST create this directory structure. The installer MUST set appropriate permissions:
> - `.env`: 600 (owner read/write only)
> - `secrets/*`: 600 (owner read/write only)
> - Other files: 644 (owner read/write, group/world read)
> - Directories: 755 (owner all, group/world read/execute)

---

### 5.3 Data Directory

**The installer stores persistent data in:**
```
/opt/aether/data/
```

**Contains:**
- PostgreSQL database files
- Redis RDB snapshots
- MinIO object storage (if enabled)
- Uploaded files (if applicable)

**Contract:**
> The installer MUST preserve this directory during:
> - Updates
> - Repairs
> - Uninstall (unless `--purge` specified)

**The installer MUST NOT:**
> - Delete data without explicit confirmation
> - Modify data files directly
> - Share data directory with other applications

---

## 6. Network Architecture

### 6.1 Docker Networks

**The installer creates two Docker networks:**

**1. Public Network (external)**
- Accessible from internet
- Only Caddy container attached
- Bridges to host network

**2. Internal Network (isolated)**
- No external access
- All services attached
- Fully isolated from internet

**Contract:**
> The installer MUST configure network isolation. Internal services MUST NOT be directly accessible from the internet.

---

### 6.2 Service Exposure

**Externally accessible (via Caddy only):**
- Frontend web interface
- Backend API (via `/api` path)

**NOT externally accessible (internal only):**
- PostgreSQL database
- Redis cache
- Backend direct access
- MinIO (if enabled)

**Contract:**
> The installer MUST verify internal services are not exposed. The installer SHOULD include a post-install security check.

---

## 7. Secret Management

### 7.1 Secret Generation

**The installer generates the following secrets:**

1. **Database Password**
   - Length: 32 characters
   - Character set: Alphanumeric (a-zA-Z0-9)
   - Entropy: ~190 bits

2. **Redis Password**
   - Length: 32 characters
   - Character set: Alphanumeric
   - Entropy: ~190 bits

3. **JWT Secret**
   - Length: 64 bytes (512 bits)
   - Encoding: Base64
   - Entropy: 512 bits

4. **Encryption Key**
   - Length: 32 bytes (256 bits)
   - Encoding: Hexadecimal
   - Entropy: 256 bits
   - Use: AES-256 encryption

5. **Session Secret**
   - Length: 64 bytes (512 bits)
   - Encoding: Base64
   - Entropy: 512 bits

**Contract:**
> The installer MUST:
> - Generate all secrets using cryptographically secure random number generator (openssl rand or /dev/urandom)
> - Store secrets in individual files with 600 permissions
> - Never use default or predictable secrets
> - Never display secrets in terminal output
> - Never log secrets to files
> - Generate unique secrets for each installation

**The installer MUST NOT:**
> - Use hardcoded secrets
> - Use weak random number generators
> - Reuse secrets across installations
> - Store secrets in environment variables (Docker Compose env section)

---

### 7.2 Secret Storage

**Secrets are stored in:**
```
/opt/aether/secrets/
```

**File permissions:**
- Directory: 700 (owner access only)
- Files: 600 (owner read/write only)

**Contract:**
> The installer MUST verify secret file permissions after creation and MUST fail if permissions cannot be set correctly.

---

## 8. Configuration Management

### 8.1 Environment Variables

**The installer generates `.env` file with:**

**Required variables:**
- `NODE_ENV=production`
- `PORT=3000`
- `DATABASE_URL=postgresql://...`
- `REDIS_URL=redis://...`
- `JWT_SECRET=...`
- `ENCRYPTION_KEY=...`
- `SESSION_SECRET=...`

**Optional variables:**
- `BASE_URL=https://domain.com` (if domain provided)
- `S3_*` variables (if MinIO enabled)
- `SMTP_*` variables (if email configured)

**Contract:**
> The installer MUST generate a complete `.env` file. The installer MUST set `.env` permissions to 600.

---

### 8.2 Configuration Backup

**The installer creates backups before:**
- Modifying existing `.env`
- Changing firewall rules
- Updating installation

**Backup naming:**
```
/opt/aether/backups/env-backup-YYYYMMDD-HHMMSS.txt
/opt/aether/backups/ufw-backup-YYYYMMDD-HHMMSS.txt
```

**Contract:**
> The installer MUST backup configuration before destructive changes. Backups MUST be timestamped and preserved.

---

## 9. Installation Behavior

### 9.1 Idempotency

**The installer is idempotent:**
- Running installer multiple times on same system produces same result
- Existing configuration is detected and preserved
- Running installer on completed installation offers upgrade or repair

**Contract:**
> The installer MUST be safe to run multiple times. The installer MUST detect existing installation and offer appropriate options:
> - Fresh install: Proceed normally
> - Incomplete install: Resume from checkpoint
> - Complete install: Offer upgrade, repair, or exit
> - Failed install: Offer retry or rollback

---

### 9.2 Interruption Handling

**The installer supports interruption:**
- Ctrl+C during installation saves state
- Power failure or network loss saves state
- Re-running installer offers resume option

**Contract:**
> The installer MUST save state after each stage. The installer MUST detect incomplete installation and offer resume.

---

### 9.3 Lock File

**The installer creates lock file:**
```
/tmp/aether-install.lock
```

**Contains:**
- Process ID of running installer
- Timestamp of start
- Installation ID

**Contract:**
> The installer MUST check for lock file and MUST refuse to run if another installer is active. The installer MUST remove lock file on exit (normal or error).

---

## 10. Data Handling

### 10.1 User Data Categories

**Application Files:**
- Installation directory (`/opt/aether/*`)
- Executables, scripts, configuration templates
- **Disposition:** Removed on uninstall

**Database Data:**
- PostgreSQL database (`/opt/aether/data/postgres/`)
- All user data, settings, records
- **Disposition:** Preserved on uninstall, removed with `--purge`

**Configuration:**
- `.env` file
- Secrets
- Instance metadata
- **Disposition:** Backed up on uninstall, removed after backup

**Logs:**
- Installation logs
- Application logs
- **Disposition:** Preserved on uninstall

**Backups:**
- Configuration backups
- Firewall backups
- **Disposition:** Preserved on uninstall

**Contract:**
> The installer MUST distinguish between application files and user data. The installer MUST preserve user data on uninstall unless `--purge` is explicitly specified.

---

### 10.2 Uninstall Behavior

**Default uninstall (`aether uninstall`):**
1. Stop all containers
2. Backup configuration
3. Remove Docker containers and images
4. Remove application files
5. Preserve database data
6. Preserve logs
7. Preserve backups

**Purge uninstall (`aether uninstall --purge`):**
1. All default uninstall steps
2. Remove database data
3. Remove logs (optional)
4. Confirm before deletion

**Contract:**
> The installer MUST provide safe uninstall that preserves data by default. The installer MUST require explicit `--purge` flag to delete user data. The installer MUST ask for confirmation before deleting data.

---

## 11. Dependency Handling

### 11.1 Existing Docker Installation

**If Docker is already installed:**
- Detect version
- Verify Docker Compose v2 available
- Verify Docker daemon running
- Use existing installation
- Do NOT reinstall Docker

**Contract:**
> The installer MUST respect existing Docker installation and MUST NOT reinstall or downgrade Docker.

---

### 11.2 Existing Web Servers

**If Nginx, Apache, or Caddy is running:**
- Detect which service
- Check if ports 80/443 are in use
- Warn about conflict
- Ask user to:
  - Stop conflicting service, OR
  - Choose different ports for Aether, OR
  - Abort installation

**Contract:**
> The installer MUST NOT stop or interfere with existing web servers. The installer MUST detect conflicts and require user decision.

---

### 11.3 Existing Aether Installation

**If Aether is already installed:**

**If installation is complete:**
- Offer upgrade to newer version
- Offer repair broken installation
- Offer uninstall
- Do NOT proceed with fresh install

**If installation is incomplete:**
- Offer resume from last checkpoint
- Offer fresh install (after cleanup)

**If installation failed:**
- Offer retry
- Offer rollback
- Offer fresh install (after cleanup)

**Contract:**
> The installer MUST detect existing Aether installation and MUST offer appropriate actions. The installer MUST NOT corrupt existing installation.

---

## 12. Update and Rollback

### 12.1 Update Behavior

**Updates preserve:**
- Database data
- Configuration (with backup)
- Secrets
- Logs
- User-created files in data directory

**Updates modify:**
- Docker images
- Application code
- docker-compose.yml
- Default configuration (merged with existing)

**Contract:**
> Updates MUST be non-destructive. Updates MUST backup configuration before modifying. Updates MUST be reversible via rollback.

---

### 12.2 Rollback Behavior

**Rollback restores:**
- Previous Docker images
- Previous configuration
- Previous docker-compose.yml

**Rollback preserves:**
- Database data (may need manual migration)
- Logs
- Backups

**Contract:**
> Rollback MUST restore previous working state. Rollback MUST NOT delete data. If database migration is incompatible, rollback MUST warn and provide manual steps.

---

## 13. Logging and Auditing

### 13.1 Installation Log

**The installer creates:**
```
/opt/aether/logs/installer-YYYYMMDD-HHMMSS.log
```

**Contains:**
- Timestamp for each operation
- Stage transitions
- Commands executed (without secrets)
- Errors and warnings
- User confirmations
- System information

**Contract:**
> The installer MUST log all operations. Logs MUST NOT contain secrets. Logs MUST be preserved after installation for debugging.

---

### 13.2 Audit Trail

**The installer creates:**
```
/opt/aether/install.state
```

**Contains:**
- Installation ID
- Timestamps (start, end)
- Stages completed
- Configuration applied
- Errors encountered
- Installed version

**Contract:**
> The installer MUST maintain audit trail. Audit trail MUST be machine-readable JSON. Audit trail MUST persist across restarts.

---

## 14. Security Guarantees

### 14.1 Download Security

**The installer MUST:**
- Download only from official release server (https://releases.aether-os.io or GitHub)
- Use HTTPS (TLS 1.2+) for all downloads
- Verify SHA256 checksum before extraction
- Abort if checksum fails
- Delete unverified files

**The installer MUST NOT:**
- Download from untrusted sources
- Execute unverified code
- Bypass checksum verification

**Contract:**
> The installer MUST enforce download security. The installer MUST NOT proceed if verification fails.

---

### 14.2 Input Validation

**The installer MUST validate all inputs:**

**Domain:**
- Format: RFC 1035 compliant
- Length: ≤253 characters
- No path traversal
- No command injection characters

**Install directory:**
- Must be absolute path
- Must be under `/opt` or `/home`
- No path traversal
- No symlinks to restricted areas

**Version/Channel:**
- Must match: `stable`, `beta`, or `development`
- No arbitrary strings

**Contract:**
> The installer MUST reject invalid input. The installer MUST NOT trust user input without validation.

---

### 14.3 Privilege Separation

**The installer MUST:**
- Run main logic as regular user
- Use sudo only when necessary
- Drop privileges as soon as possible
- Avoid running containers as root

**The installer MUST NOT:**
- Run entire installer as root
- Keep elevated privileges longer than needed
- Grant unnecessary permissions

**Contract:**
> The installer MUST follow principle of least privilege.

---

## 15. Failure Handling

### 15.1 Failure Categories

**Recoverable (installer can retry):**
- Network timeouts
- Temporary resource exhaustion
- Service not ready yet

**Non-recoverable (installer must abort):**
- Checksum verification failure
- Unsupported platform
- Insufficient resources
- Missing sudo access

**Contract:**
> The installer MUST distinguish between recoverable and non-recoverable failures. The installer MUST retry recoverable failures up to 3 times. The installer MUST abort non-recoverable failures immediately.

---

### 15.2 Error Messages

**All error messages MUST include:**
- Clear description of what failed
- Why it failed (if known)
- What the user can do to fix it
- Installation ID for support
- Log file location

**Contract:**
> Error messages MUST be actionable. Error messages MUST NOT be cryptic or technical-only.

---

### 15.3 Cleanup on Failure

**On failure, the installer MUST:**
- Save state for resume
- Preserve logs
- Offer rollback option
- Clean up temporary files
- Release lock file

**The installer MUST NOT:**
- Leave partial installation without state
- Delete logs
- Leave system in inconsistent state

**Contract:**
> The installer MUST fail gracefully and leave system in recoverable state.

---

## 16. Support and Diagnostics

### 16.1 Installation ID

**Each installation has unique ID:**
- Generated at start
- Stored in instance.json
- Included in all logs
- Used for support

**Contract:**
> The installer MUST generate unique installation ID. The ID MUST be displayed to user for support purposes.

---

### 16.2 Diagnostic Information

**The installer collects:**
- OS version
- Architecture
- Resource availability
- Docker version
- Network connectivity
- Port availability

**Contract:**
> Diagnostic info MUST NOT include secrets. Diagnostic info MAY be shared for support.

---

## 17. Contract Violations

**If the installer violates this contract:**
- User should report as bug
- Installer should be fixed
- Documentation should be updated

**Contract:**
> This specification is authoritative. Implementation MUST conform to this contract.

---

## 18. Contract Version

**Version:** 1.0.0  
**Date:** 2026-09-15  
**Status:** Draft

**Changes require:**
- Version bump
- Documentation update
- User notification (for breaking changes)

---

**Document Status:** Draft Contract Specification  
**Binding:** Yes, implementation MUST conform  
**Last Updated:** 2026-09-15 20:25 UTC

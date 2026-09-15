# Aether Installer - Implementation Plan

**Version:** 1.0.0  
**Date:** 2026-09-15  
**Status:** Implementation Roadmap

---

## Overview

This document outlines the phased implementation plan for the Aether one-command installer, from initial skeleton to production-ready deployment tool.

**Goal:** Build a secure, reliable, auditable installer that can deploy Aether Cloud OS on Ubuntu VPS with a single command.

---

## Implementation Phases

### Phase 1: Foundation (Week 1)
**Goal:** Basic installer structure and preflight checks

### Phase 2: Core Installation (Week 2)
**Goal:** Complete installation pipeline

### Phase 3: Security & Robustness (Week 3)
**Goal:** Production-ready security

### Phase 4: Testing & Validation (Week 4)
**Goal:** Comprehensive testing

---

## Phase 1: Foundation (Days 1-7)

### Milestone 1.1: Project Structure (Day 1)

**Deliverables:**
- [ ] Create modular directory structure
- [ ] Create entry point `install.sh`
- [ ] Create library modules in `lib/`
- [ ] Set up basic logging
- [ ] Implement `--help` and `--version`

**Directory Structure:**
```
installer/
├── install.sh                    # Main entry point
├── lib/                          # Library modules
│   ├── core.sh                   # Core functions
│   ├── logging.sh                # Logging utilities
│   ├── platform.sh               # Platform detection
│   ├── resources.sh              # Resource checking
│   ├── network.sh                # Network utilities
│   ├── permissions.sh            # Permission checking
│   ├── validation.sh             # Input validation
│   ├── dependencies.sh           # Dependency management
│   ├── docker.sh                 # Docker utilities
│   ├── release.sh                # Release download/verify
│   ├── config.sh                 # Configuration generation
│   ├── secrets.sh                # Secret generation
│   ├── firewall.sh               # Firewall configuration
│   ├── deploy.sh                 # Service deployment
│   ├── health.sh                 # Health checks
│   ├── rollback.sh               # Rollback utilities
│   └── uninstall.sh              # Uninstall procedures
├── templates/                    # Configuration templates
│   ├── docker-compose.yml.template
│   ├── .env.template
│   └── Caddyfile.template
├── tests/                        # Test suite
│   ├── unit/                     # Unit tests
│   └── integration/              # Integration tests
└── docs/                         # Additional documentation
    └── DEVELOPMENT.md
```

**Acceptance Criteria:**
- Directory structure created
- `install.sh --help` shows usage
- `install.sh --version` shows version
- Basic logging to file works

---

### Milestone 1.2: Core Functions (Day 2)

**Deliverables:**
- [ ] Implement logging functions (info, success, warning, error)
- [ ] Implement state management (save/load state)
- [ ] Implement lock file management
- [ ] Implement argument parsing
- [ ] Implement dry-run mode

**Core Functions:**
```bash
# lib/core.sh

# Logging
log()           # Generic log with level
info()          # Info message
success()       # Success message
warning()       # Warning message
error()         # Error message

# State management
create_state()  # Initialize state file
save_state()    # Save current state
load_state()    # Load existing state
get_state()     # Get state value
set_state()     # Set state value

# Lock management
acquire_lock()  # Create lock file
release_lock()  # Remove lock file
check_lock()    # Check if locked

# Argument parsing
parse_args()    # Parse command-line arguments

# Utilities
display_banner() # Show welcome banner
display_progress() # Show progress
```

**Acceptance Criteria:**
- Logging to file works correctly
- State saved and loaded properly
- Lock prevents concurrent runs
- Arguments parsed correctly
- Dry-run mode shows actions without executing

---

### Milestone 1.3: Platform Detection (Day 3)

**Deliverables:**
- [ ] Implement OS detection
- [ ] Implement architecture detection
- [ ] Implement init system detection
- [ ] Implement package manager detection
- [ ] Block unsupported platforms

**Platform Detection:**
```bash
# lib/platform.sh

detect_os()              # Detect operating system
detect_architecture()    # Detect CPU architecture
detect_init_system()     # Detect init system (systemd)
detect_package_manager() # Detect package manager (apt)
is_platform_supported()  # Check if platform is supported
```

**Acceptance Criteria:**
- Correctly detects Ubuntu 20.04, 22.04, 24.04
- Correctly detects x86_64 architecture
- Blocks non-Ubuntu systems
- Blocks non-x86_64 architectures
- Blocks non-systemd systems

---

### Milestone 1.4: Resource Checking (Day 4)

**Deliverables:**
- [ ] Implement CPU detection
- [ ] Implement RAM detection
- [ ] Implement disk space detection
- [ ] Implement resource validation
- [ ] Display resource status

**Resource Functions:**
```bash
# lib/resources.sh

get_cpu_cores()      # Get number of CPU cores
get_ram_gb()         # Get RAM in GB
get_disk_free_gb()   # Get free disk space in GB
check_resources()    # Check all resources
validate_resources() # Validate against requirements
```

**Acceptance Criteria:**
- Correctly detects CPU cores
- Correctly detects RAM size
- Correctly detects disk space
- Warns if below recommended
- Blocks if below minimum

---

### Milestone 1.5: Network & Permissions (Day 5)

**Deliverables:**
- [ ] Implement network connectivity check
- [ ] Implement DNS resolution check
- [ ] Implement port availability check
- [ ] Implement sudo check
- [ ] Implement write permission check

**Network & Permission Functions:**
```bash
# lib/network.sh

check_internet()       # Check internet connectivity
check_dns()            # Check DNS resolution
get_public_ip()        # Get public IP address
check_port()           # Check if port is available

# lib/permissions.sh

check_sudo()           # Check sudo availability
check_write_access()   # Check write permissions
is_root()              # Check if running as root
```

**Acceptance Criteria:**
- Detects internet connectivity
- Detects DNS resolution
- Detects public IP
- Checks port availability
- Validates sudo access
- Blocks if sudo unavailable

---

### Milestone 1.6: Input Validation (Day 6)

**Deliverables:**
- [ ] Implement domain validation
- [ ] Implement path validation
- [ ] Implement version validation
- [ ] Prevent command injection
- [ ] Prevent path traversal

**Validation Functions:**
```bash
# lib/validation.sh

validate_domain()       # Validate domain format
validate_install_dir()  # Validate installation directory
validate_version()      # Validate version string
validate_channel()      # Validate release channel
sanitize_input()        # Sanitize user input
```

**Acceptance Criteria:**
- Rejects invalid domains
- Rejects unsafe paths
- Rejects invalid versions
- Blocks command injection attempts
- Blocks path traversal attempts

---

### Milestone 1.7: Preflight Complete (Day 7)

**Deliverables:**
- [ ] Integrate all preflight checks
- [ ] Display preflight summary
- [ ] Ask for confirmation
- [ ] Handle dry-run mode
- [ ] Test on Ubuntu 22.04

**Phase 1 Completion Criteria:**
- Installer can run preflight checks
- Detects supported/unsupported platforms
- Validates resources
- Validates permissions
- Validates network
- Validates input
- Dry-run mode works
- Logs all operations
- Passes shellcheck

---

## Phase 2: Core Installation (Days 8-14)

### Milestone 2.1: Dependency Management (Day 8)

**Deliverables:**
- [ ] Detect existing Docker
- [ ] Install Docker if missing
- [ ] Install Docker Compose v2
- [ ] Install system packages
- [ ] Verify installations

**Dependency Functions:**
```bash
# lib/dependencies.sh

detect_docker()          # Detect Docker installation
install_docker()         # Install Docker
verify_docker()          # Verify Docker works
detect_packages()        # Detect system packages
install_packages()       # Install missing packages
```

**Acceptance Criteria:**
- Detects existing Docker
- Installs Docker on fresh system
- Verifies Docker Compose v2
- Installs required packages
- All installations verified

---

### Milestone 2.2: Docker Setup (Day 9)

**Deliverables:**
- [ ] Configure Docker daemon
- [ ] Start Docker service
- [ ] Add user to docker group
- [ ] Test Docker functionality
- [ ] Handle docker group membership

**Docker Functions:**
```bash
# lib/docker.sh

configure_docker()       # Configure Docker daemon
start_docker()           # Start Docker service
add_user_to_docker()     # Add user to docker group
test_docker()            # Test Docker with hello-world
verify_docker_access()   # Verify Docker socket access
```

**Acceptance Criteria:**
- Docker service running
- User added to docker group
- Docker commands work (with sudo if needed)
- Test container runs successfully

---

### Milestone 2.3: Release Download (Day 10)

**Deliverables:**
- [ ] Download release manifest
- [ ] Download checksums
- [ ] Download release archive
- [ ] Implement retry logic
- [ ] Handle network failures

**Release Functions:**
```bash
# lib/release.sh

determine_version()      # Determine target version
download_manifest()      # Download manifest.json
download_checksums()     # Download checksums.txt
download_release()       # Download release archive
retry_download()         # Retry failed download
```

**Acceptance Criteria:**
- Downloads from official server
- Retries on failure (3 times)
- Handles network interruptions
- Saves to temp directory

---

### Milestone 2.4: Verification & Extraction (Day 11)

**Deliverables:**
- [ ] Verify checksums
- [ ] Display security alert on failure
- [ ] Extract release archive
- [ ] Validate extracted contents
- [ ] Set file permissions

**Verification Functions:**
```bash
# lib/release.sh

verify_checksum()            # Verify SHA256 checksum
display_security_alert()     # Show security alert
extract_release()            # Extract archive
validate_extracted()         # Validate contents
set_permissions()            # Set file permissions
```

**Acceptance Criteria:**
- Checksum verification works
- Blocks on verification failure
- Displays security alert
- Extraction succeeds
- File permissions correct

---

### Milestone 2.5: Configuration Generation (Day 12)

**Deliverables:**
- [ ] Generate installation ID
- [ ] Create directory structure
- [ ] Generate .env file
- [ ] Generate instance metadata
- [ ] Generate secrets

**Configuration Functions:**
```bash
# lib/config.sh

generate_instance_id()   # Generate unique ID
create_directories()     # Create directory structure
generate_env()           # Generate .env file
generate_metadata()      # Generate instance.json

# lib/secrets.sh

generate_password()      # Generate secure password
generate_secret()        # Generate secret (base64)
generate_hex_key()       # Generate hex key
store_secret()           # Store secret to file
```

**Acceptance Criteria:**
- Unique installation ID generated
- Directory structure created
- .env file generated with random secrets
- All secrets cryptographically random
- File permissions set correctly (600)
- No secrets in logs

---

### Milestone 2.6: Service Deployment (Day 13)

**Deliverables:**
- [ ] Generate docker-compose.yml
- [ ] Configure domain (if provided)
- [ ] Configure Caddy
- [ ] Pull Docker images
- [ ] Start containers

**Deployment Functions:**
```bash
# lib/deploy.sh

generate_compose()       # Generate docker-compose.yml
configure_domain()       # Configure domain/HTTPS
configure_caddy()        # Generate Caddyfile
pull_images()            # Pull Docker images
start_services()         # Start containers
wait_for_startup()       # Wait for services
```

**Acceptance Criteria:**
- docker-compose.yml generated
- Domain configured (if provided)
- Caddy configured correctly
- All images pulled
- All containers running

---

### Milestone 2.7: Health Checks & Completion (Day 14)

**Deliverables:**
- [ ] Implement database health check
- [ ] Implement API health check
- [ ] Implement Redis health check
- [ ] Implement HTTPS check (if domain)
- [ ] Generate pairing code
- [ ] Display summary

**Health Functions:**
```bash
# lib/health.sh

wait_for_postgres()      # Wait for PostgreSQL
wait_for_redis()         # Wait for Redis
wait_for_api()           # Wait for API health endpoint
check_https()            # Check HTTPS certificate
run_health_checks()      # Run all health checks
```

**Completion:**
```bash
generate_pairing_code()  # Generate pairing token
display_summary()        # Display installation summary
save_final_state()       # Mark installation complete
```

**Phase 2 Completion Criteria:**
- Complete end-to-end installation works
- All services start successfully
- Health checks pass
- Pairing code generated
- Summary displayed
- Installation can be accessed via browser

---

## Phase 3: Security & Robustness (Days 15-21)

### Milestone 3.1: Firewall Configuration (Day 15)

**Deliverables:**
- [ ] Detect firewall (UFW)
- [ ] Backup firewall rules
- [ ] Configure firewall rules
- [ ] Verify SSH not blocked
- [ ] Test connectivity

**Firewall Functions:**
```bash
# lib/firewall.sh

detect_firewall()        # Detect UFW/firewalld
backup_firewall()        # Backup current rules
detect_ssh_port()        # Detect SSH port
configure_ufw()          # Configure UFW rules
verify_ssh()             # Verify SSH still works
```

**Acceptance Criteria:**
- Detects UFW if installed
- Backs up existing rules
- Detects actual SSH port
- Allows SSH, HTTP, HTTPS
- Denies PostgreSQL, Redis
- SSH remains accessible

---

### Milestone 3.2: Resume & Rollback (Day 16-17)

**Deliverables:**
- [ ] Implement resume functionality
- [ ] Detect incomplete installation
- [ ] Implement rollback
- [ ] Stop containers on rollback
- [ ] Clean up on rollback

**Rollback Functions:**
```bash
# lib/rollback.sh

detect_incomplete()      # Detect incomplete installation
offer_resume()           # Offer to resume
resume_installation()    # Resume from checkpoint
rollback()               # Rollback installation
stop_containers()        # Stop all containers
cleanup_installation()   # Clean up files
restore_firewall()       # Restore firewall rules
```

**Acceptance Criteria:**
- Detects incomplete installation
- Offers resume option
- Resumes from correct stage
- Rollback stops all containers
- Rollback cleans up files
- Rollback preserves logs

---

### Milestone 3.3: Error Handling (Day 18)

**Deliverables:**
- [ ] Implement error categories
- [ ] Implement retry logic
- [ ] Implement graceful degradation
- [ ] Display actionable errors
- [ ] Log all errors

**Error Handling:**
```bash
# Enhanced error handling

handle_error()           # Generic error handler
is_recoverable()         # Check if error is recoverable
retry_operation()        # Retry with backoff
fail_gracefully()        # Graceful failure
display_error_help()     # Display help for error
```

**Acceptance Criteria:**
- Retries recoverable errors
- Aborts non-recoverable errors
- Displays actionable error messages
- Logs all errors with context
- Preserves state on error

---

### Milestone 3.4: Security Hardening (Day 19)

**Deliverables:**
- [ ] Audit all sudo usage
- [ ] Verify no secrets in logs
- [ ] Verify file permissions
- [ ] Verify network isolation
- [ ] Run security checks

**Security Audit:**
```bash
# Security verification

audit_sudo_usage()       # Audit sudo commands
verify_no_secrets_logged() # Check logs for secrets
verify_permissions()     # Check file permissions
verify_network_isolation() # Check port exposure
run_security_scan()      # Post-install security scan
```

**Acceptance Criteria:**
- Sudo only used when necessary
- No secrets in logs
- All secret files 600 permissions
- Internal services not exposed
- Security scan passes

---

### Milestone 3.5: Documentation (Day 20)

**Deliverables:**
- [ ] Write installer usage guide
- [ ] Write troubleshooting guide
- [ ] Document all flags
- [ ] Document error messages
- [ ] Write examples

**Acceptance Criteria:**
- Complete usage documentation
- Troubleshooting guide with common issues
- All flags documented
- Examples for common scenarios

---

### Milestone 3.6: Code Quality (Day 21)

**Deliverables:**
- [ ] Run shellcheck on all scripts
- [ ] Fix all shellcheck warnings
- [ ] Add comments to complex sections
- [ ] Standardize coding style
- [ ] Code review

**Phase 3 Completion Criteria:**
- All security features implemented
- Firewall configuration works
- Resume/rollback work correctly
- Error handling comprehensive
- No secrets in logs
- Documentation complete
- Shellcheck clean
- Code reviewed

---

## Phase 4: Testing & Validation (Days 22-28)

### Milestone 4.1: Unit Testing (Day 22-23)

**Deliverables:**
- [ ] Write tests for validation functions
- [ ] Write tests for utility functions
- [ ] Write tests for error handling
- [ ] Run all unit tests

**Test Framework:**
```bash
# tests/unit/test_validation.sh

test_validate_domain() {
  # Test valid domains
  assert_success validate_domain "example.com"
  assert_success validate_domain "sub.example.com"
  
  # Test invalid domains
  assert_failure validate_domain "example.com/../../etc"
  assert_failure validate_domain "192.168.1.1"
}
```

**Acceptance Criteria:**
- Unit tests for critical functions
- All tests passing
- Edge cases covered

---

### Milestone 4.2: Integration Testing (Day 24)

**Deliverables:**
- [ ] Test on Ubuntu 22.04
- [ ] Test on Ubuntu 20.04
- [ ] Test with existing Docker
- [ ] Test without Docker
- [ ] Test with domain
- [ ] Test without domain

**Acceptance Criteria:**
- Works on Ubuntu 20.04, 22.04
- Works with/without existing Docker
- Works with/without domain
- All integration tests pass

---

### Milestone 4.3: VPS Provider Testing (Day 25)

**Deliverables:**
- [ ] Test on DigitalOcean
- [ ] Test on AWS EC2
- [ ] Test on Linode
- [ ] Test on Vultr

**Acceptance Criteria:**
- Works on all major VPS providers
- No provider-specific issues

---

### Milestone 4.4: Error Scenario Testing (Day 26)

**Deliverables:**
- [ ] Test interrupt and resume
- [ ] Test checksum failure
- [ ] Test network failure
- [ ] Test disk full
- [ ] Test port conflict
- [ ] Test rollback

**Acceptance Criteria:**
- Resume works after interrupt
- Checksum failure blocked
- Network failure handled
- Disk full detected
- Port conflicts detected
- Rollback works

---

### Milestone 4.5: Security Testing (Day 27)

**Deliverables:**
- [ ] Test checksum verification
- [ ] Test input validation
- [ ] Test secret generation
- [ ] Test network isolation
- [ ] Test firewall configuration
- [ ] Verify no secrets in logs

**Acceptance Criteria:**
- All security tests pass
- No exposed internal services
- Secrets have sufficient entropy
- Input validation blocks attacks

---

### Milestone 4.6: Final Validation (Day 28)

**Deliverables:**
- [ ] End-to-end test on fresh VPS
- [ ] Performance benchmarking
- [ ] Create validation report
- [ ] Fix any remaining issues
- [ ] Final code review

**Phase 4 Completion Criteria:**
- All tests passing
- Tested on multiple platforms
- Security validated
- Performance acceptable
- Validation report complete
- Ready for beta release

---

## Module Breakdown

### Module: lib/core.sh

**Purpose:** Core utilities used by all modules

**Functions:**
- Logging (info, success, warning, error)
- State management (save_state, load_state)
- Lock file management
- Progress display
- Banner display

**Dependencies:** None

**Size:** ~200 lines

---

### Module: lib/logging.sh

**Purpose:** Logging infrastructure

**Functions:**
- Log to file
- Log to console
- Log levels (DEBUG, INFO, WARN, ERROR)
- Structured logging
- Security event logging

**Dependencies:** core.sh

**Size:** ~100 lines

---

### Module: lib/platform.sh

**Purpose:** Platform detection

**Functions:**
- Detect OS
- Detect architecture
- Detect init system
- Detect package manager
- Platform support validation

**Dependencies:** core.sh, logging.sh

**Size:** ~150 lines

---

### Module: lib/resources.sh

**Purpose:** Resource checking

**Functions:**
- Check CPU
- Check RAM
- Check disk space
- Validate resources

**Dependencies:** core.sh, logging.sh

**Size:** ~100 lines

---

### Module: lib/network.sh

**Purpose:** Network utilities

**Functions:**
- Check internet connectivity
- Check DNS resolution
- Get public IP
- Check port availability
- DNS verification

**Dependencies:** core.sh, logging.sh

**Size:** ~150 lines

---

### Module: lib/permissions.sh

**Purpose:** Permission checking

**Functions:**
- Check sudo
- Check write access
- Check user
- Validate permissions

**Dependencies:** core.sh, logging.sh

**Size:** ~100 lines

---

### Module: lib/validation.sh

**Purpose:** Input validation

**Functions:**
- Validate domain
- Validate path
- Validate version
- Sanitize input
- Prevent injection

**Dependencies:** core.sh, logging.sh

**Size:** ~200 lines

---

### Module: lib/dependencies.sh

**Purpose:** Dependency management

**Functions:**
- Detect packages
- Install packages
- Detect Docker
- Install Docker
- Verify installations

**Dependencies:** core.sh, logging.sh, platform.sh

**Size:** ~250 lines

---

### Module: lib/docker.sh

**Purpose:** Docker utilities

**Functions:**
- Configure Docker
- Start Docker
- Add user to group
- Test Docker
- Verify access

**Dependencies:** core.sh, logging.sh

**Size:** ~200 lines

---

### Module: lib/release.sh

**Purpose:** Release download and verification

**Functions:**
- Determine version
- Download manifest
- Download release
- Verify checksum
- Extract archive

**Dependencies:** core.sh, logging.sh, network.sh

**Size:** ~300 lines

---

### Module: lib/config.sh

**Purpose:** Configuration generation

**Functions:**
- Generate instance ID
- Create directories
- Generate .env
- Generate metadata

**Dependencies:** core.sh, logging.sh, secrets.sh

**Size:** ~200 lines

---

### Module: lib/secrets.sh

**Purpose:** Secret generation

**Functions:**
- Generate password
- Generate secret
- Generate hex key
- Store secret
- Verify entropy

**Dependencies:** core.sh, logging.sh

**Size:** ~150 lines

---

### Module: lib/firewall.sh

**Purpose:** Firewall configuration

**Functions:**
- Detect firewall
- Backup rules
- Configure UFW
- Verify SSH
- Test connectivity

**Dependencies:** core.sh, logging.sh

**Size:** ~200 lines

---

### Module: lib/deploy.sh

**Purpose:** Service deployment

**Functions:**
- Generate compose file
- Configure domain
- Configure Caddy
- Pull images
- Start services

**Dependencies:** core.sh, logging.sh, docker.sh, config.sh

**Size:** ~250 lines

---

### Module: lib/health.sh

**Purpose:** Health checks

**Functions:**
- Wait for PostgreSQL
- Wait for Redis
- Wait for API
- Check HTTPS
- Run all checks

**Dependencies:** core.sh, logging.sh, network.sh

**Size:** ~200 lines

---

### Module: lib/rollback.sh

**Purpose:** Rollback procedures

**Functions:**
- Detect incomplete
- Offer resume
- Rollback installation
- Stop containers
- Clean up files

**Dependencies:** core.sh, logging.sh, docker.sh

**Size:** ~200 lines

---

### Module: lib/uninstall.sh

**Purpose:** Uninstall procedures

**Functions:**
- Stop services
- Backup config
- Remove files
- Preserve data
- Clean up

**Dependencies:** core.sh, logging.sh, docker.sh

**Size:** ~150 lines

---

## Estimated Totals

**Total Modules:** 15  
**Total Functions:** ~150  
**Total Lines of Code:** ~2,800  
**Total Documentation:** ~500 lines of comments  
**Total Tests:** ~1,000 lines

---

## Success Criteria

### Milestone 1 Success (Foundation)
- [ ] Installer can run preflight checks
- [ ] Detects supported platforms
- [ ] Validates resources
- [ ] Validates permissions
- [ ] Dry-run mode works
- [ ] Shellcheck passes

### Milestone 2 Success (Core Installation)
- [ ] Complete installation works end-to-end
- [ ] All services start
- [ ] Health checks pass
- [ ] Can access via browser

### Milestone 3 Success (Security)
- [ ] All security features work
- [ ] No secrets in logs
- [ ] Network isolation verified
- [ ] Firewall configured correctly

### Milestone 4 Success (Testing)
- [ ] All tests pass
- [ ] Works on multiple platforms
- [ ] Security validated
- [ ] Performance acceptable

### Final Success (Production Ready)
- [ ] All milestones complete
- [ ] Documentation complete
- [ ] Tested on real VPS
- [ ] Security audit passed
- [ ] Ready for public release

---

**Document Status:** Implementation Roadmap  
**Last Updated:** 2026-09-15 20:35 UTC  
**Next Review:** After each milestone completion

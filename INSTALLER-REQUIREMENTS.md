# Aether Installer - Requirements Document

**Version:** 1.0.0  
**Date:** 2026-09-15  
**Status:** Draft - Design Phase

---

## Executive Summary

The Aether installer enables users to install Aether Cloud OS on a VPS with a single command:

```bash
curl -fsSL https://aether-os.io/install.sh | bash
```

This document specifies functional and non-functional requirements for the installer.

---

## Functional Requirements

### FR1: Installation Workflow

**FR1.1** The installer MUST execute 19 distinct stages in sequence  
**FR1.2** The installer MUST display progress for each stage  
**FR1.3** The installer MUST save state after each stage  
**FR1.4** The installer MUST allow resuming from the last successful stage  
**FR1.5** The installer MUST complete within 15 minutes on typical hardware  

**Priority:** P0 (Must Have)  
**Status:** Not Implemented

---

### FR2: Platform Detection

**FR2.1** The installer MUST detect the operating system  
**FR2.2** The installer MUST detect the distribution and version  
**FR2.3** The installer MUST detect the CPU architecture  
**FR2.4** The installer MUST detect the package manager  
**FR2.5** The installer MUST detect the init system  
**FR2.6** The installer MUST block installation on unsupported platforms  

**Supported Platforms (MVP):**
- Ubuntu 20.04 LTS (x86_64)
- Ubuntu 22.04 LTS (x86_64)
- Ubuntu 24.04 LTS (x86_64)

**Priority:** P0 (Must Have)  
**Status:** Not Implemented

---

### FR3: Resource Validation

**FR3.1** The installer MUST check CPU cores  
**FR3.2** The installer MUST check RAM size  
**FR3.3** The installer MUST check available disk space  
**FR3.4** The installer MUST block if resources are below minimum  
**FR3.5** The installer MUST warn if resources are below recommended  

**Minimum Requirements:**
- CPU: 2 cores
- RAM: 4 GB
- Disk: 40 GB free

**Recommended Requirements:**
- CPU: 4 cores
- RAM: 8 GB
- Disk: 80 GB free

**Priority:** P0 (Must Have)  
**Status:** Not Implemented

---

### FR4: Network Validation

**FR4.1** The installer MUST verify internet connectivity  
**FR4.2** The installer MUST verify DNS resolution  
**FR4.3** The installer MUST detect public IP address  
**FR4.4** The installer MUST check port 80 availability  
**FR4.5** The installer MUST check port 443 availability  
**FR4.6** The installer MUST block if internet is unavailable  

**Priority:** P0 (Must Have)  
**Status:** Not Implemented

---

### FR5: Permission Validation

**FR5.1** The installer MUST check current user  
**FR5.2** The installer MUST verify sudo availability  
**FR5.3** The installer MUST verify write permissions to install directory  
**FR5.4** The installer MUST block if sudo is unavailable  
**FR5.5** The installer MUST warn if running as root  

**Priority:** P0 (Must Have)  
**Status:** Not Implemented

---

### FR6: Conflict Detection

**FR6.1** The installer MUST detect existing Aether installations  
**FR6.2** The installer MUST detect conflicting web servers  
**FR6.3** The installer MUST detect conflicting reverse proxies  
**FR6.4** The installer MUST detect port conflicts  
**FR6.5** The installer MUST warn about conflicts and suggest resolution  

**Priority:** P0 (Must Have)  
**Status:** Not Implemented

---

### FR7: Dependency Management

**FR7.1** The installer MUST detect existing Docker installation  
**FR7.2** The installer MUST install Docker if not present  
**FR7.3** The installer MUST verify Docker Compose v2 availability  
**FR7.4** The installer MUST install required system packages  
**FR7.5** The installer MUST verify all dependencies before proceeding  

**Required Dependencies:**
- Docker Engine (latest stable)
- Docker Compose v2
- curl
- wget  
- git
- openssl
- ca-certificates

**Priority:** P0 (Must Have)  
**Status:** Not Implemented

---

### FR8: Release Download

**FR8.1** The installer MUST download from official release server  
**FR8.2** The installer MUST use HTTPS for all downloads  
**FR8.3** The installer MUST support release channels (stable, beta, development)  
**FR8.4** The installer MUST download release manifest  
**FR8.5** The installer MUST download release artifact  
**FR8.6** The installer MUST download checksums file  
**FR8.7** The installer MUST retry failed downloads up to 3 times  

**Release Channels:**
- `stable` (default) - Production releases
- `beta` - Pre-release testing
- `development` - Latest builds (requires explicit opt-in)

**Priority:** P0 (Must Have)  
**Status:** Not Implemented

---

### FR9: Integrity Verification

**FR9.1** The installer MUST verify SHA256 checksum before extraction  
**FR9.2** The installer MUST abort if checksum verification fails  
**FR9.3** The installer MUST display security alert on verification failure  
**FR9.4** The installer MUST delete unverified files  
**FR9.5** The installer SHOULD support GPG signature verification (future)  

**Priority:** P0 (Must Have)  
**Status:** Not Implemented

---

### FR10: Configuration Generation

**FR10.1** The installer MUST generate unique instance ID  
**FR10.2** The installer MUST create installation directory structure  
**FR10.3** The installer MUST generate .env configuration file  
**FR10.4** The installer MUST create instance metadata file  
**FR10.5** The installer MUST set appropriate file permissions  

**Priority:** P0 (Must Have)  
**Status:** Not Implemented

---

### FR11: Secret Generation

**FR11.1** The installer MUST generate cryptographically random secrets  
**FR11.2** The installer MUST generate database password (≥32 chars)  
**FR11.3** The installer MUST generate Redis password (≥32 chars)  
**FR11.4** The installer MUST generate JWT secret (≥64 bytes)  
**FR11.5** The installer MUST generate encryption key (32 bytes hex)  
**FR11.6** The installer MUST generate session secret (≥64 bytes)  
**FR11.7** The installer MUST store secrets with 600 permissions  
**FR11.8** The installer MUST NOT display secrets in output or logs  
**FR11.9** The installer MUST NOT use default or predictable secrets  

**Priority:** P0 (Must Have)  
**Status:** Not Implemented

---

### FR12: Domain Configuration

**FR12.1** The installer MUST support installation without domain (IP-only)  
**FR12.2** The installer MUST accept domain via command-line argument  
**FR12.3** The installer MUST validate domain format  
**FR12.4** The installer MUST verify DNS points to server IP  
**FR12.5** The installer MUST configure Caddy for provided domain  
**FR12.6** The installer MUST warn if DNS is not correctly configured  

**Priority:** P0 (Must Have)  
**Status:** Not Implemented

---

### FR13: Firewall Configuration

**FR13.1** The installer MUST detect existing firewall (UFW, firewalld)  
**FR13.2** The installer MUST backup existing firewall rules  
**FR13.3** The installer MUST configure firewall to allow SSH (22)  
**FR13.4** The installer MUST configure firewall to allow HTTP (80)  
**FR13.5** The installer MUST configure firewall to allow HTTPS (443)  
**FR13.6** The installer MUST ensure internal services are not exposed  
**FR13.7** The installer MUST ask confirmation before modifying firewall  
**FR13.8** The installer MUST verify SSH remains accessible after changes  

**Priority:** P0 (Must Have)  
**Status:** Not Implemented

---

### FR14: Service Deployment

**FR14.1** The installer MUST deploy services via Docker Compose  
**FR14.2** The installer MUST start PostgreSQL container  
**FR14.3** The installer MUST start Redis container  
**FR14.4** The installer MUST start backend container  
**FR14.5** The installer MUST start frontend container  
**FR14.6** The installer MUST start Caddy container  
**FR14.7** The installer MUST wait for all containers to be healthy  
**FR14.8** The installer MUST configure internal-only Docker network  

**Priority:** P0 (Must Have)  
**Status:** Not Implemented

---

### FR15: Database Initialization

**FR15.1** The installer MUST wait for PostgreSQL to be ready  
**FR15.2** The installer MUST run database migrations  
**FR15.3** The installer MUST create initial schema  
**FR15.4** The installer MUST verify database connectivity  
**FR15.5** The installer MUST abort if database initialization fails  

**Priority:** P0 (Must Have)  
**Status:** Not Implemented

---

### FR16: Health Verification

**FR16.1** The installer MUST verify all containers are running  
**FR16.2** The installer MUST verify backend API health endpoint  
**FR16.3** The installer MUST verify PostgreSQL connectivity  
**FR16.4** The installer MUST verify Redis connectivity  
**FR16.5** The installer MUST verify frontend is accessible  
**FR16.6** The installer MUST abort if health checks fail  
**FR16.7** The installer MUST display container logs on failure  

**Priority:** P0 (Must Have)  
**Status:** Not Implemented

---

### FR17: HTTPS Setup

**FR17.1** The installer MUST configure Caddy to obtain SSL certificate  
**FR17.2** The installer MUST wait for certificate provisioning  
**FR17.3** The installer MUST verify HTTPS endpoint is accessible  
**FR17.4** The installer MUST skip HTTPS if no domain provided  
**FR17.5** The installer MUST warn if HTTPS setup fails  
**FR17.6** The installer MAY continue with HTTP if HTTPS fails  

**Priority:** P0 (Must Have)  
**Status:** Not Implemented

---

### FR18: Pairing Setup

**FR18.1** The installer MUST generate one-time pairing token  
**FR18.2** The installer MUST store pairing token in database  
**FR18.3** The installer MUST set token expiry (1 hour)  
**FR18.4** The installer MUST display pairing token to user  
**FR18.5** The installer MUST save pairing information to file  

**Priority:** P0 (Must Have)  
**Status:** Not Implemented

---

### FR19: Installation Summary

**FR19.1** The installer MUST display installation summary  
**FR19.2** The installer MUST display access URL  
**FR19.3** The installer MUST display pairing code  
**FR19.4** The installer MUST display next steps  
**FR19.5** The installer MUST provide links to documentation  
**FR19.6** The installer MUST save installation report to file  

**Priority:** P0 (Must Have)  
**Status:** Not Implemented

---

### FR20: Error Handling

**FR20.1** The installer MUST handle errors gracefully at each stage  
**FR20.2** The installer MUST save state on error  
**FR20.3** The installer MUST display clear error messages  
**FR20.4** The installer MUST suggest remediation steps  
**FR20.5** The installer MUST offer retry or rollback options  
**FR20.6** The installer MUST log all errors with context  

**Priority:** P0 (Must Have)  
**Status:** Not Implemented

---

### FR21: State Management

**FR21.1** The installer MUST create installation state file  
**FR21.2** The installer MUST update state after each stage  
**FR21.3** The installer MUST save stage-specific data  
**FR21.4** The installer MUST detect incomplete installations  
**FR21.5** The installer MUST offer to resume incomplete installations  
**FR21.6** The installer MUST preserve state across interruptions  

**Priority:** P0 (Must Have)  
**Status:** Not Implemented

---

### FR22: Rollback

**FR22.1** The installer MUST support rollback on failure  
**FR22.2** The installer MUST stop all containers during rollback  
**FR22.3** The installer MUST offer to remove installation directory  
**FR22.4** The installer MUST restore firewall rules if changed  
**FR22.5** The installer MUST cleanup temporary files  
**FR22.6** The installer MUST preserve logs during rollback  

**Priority:** P1 (Should Have)  
**Status:** Not Implemented

---

### FR23: Command-Line Interface

**FR23.1** The installer MUST support `--version` flag  
**FR23.2** The installer MUST support `--help` flag  
**FR23.3** The installer MUST support `--dry-run` flag  
**FR23.4** The installer MUST support `--yes` flag (non-interactive)  
**FR23.5** The installer MUST support `--domain <domain>` flag  
**FR23.6** The installer MUST support `--install-dir <path>` flag  
**FR23.7** The installer MUST support `--channel <stable|beta|development>` flag  
**FR23.8** The installer MUST support `--no-https` flag  
**FR23.9** The installer MUST support `--resume` flag  

**Priority:** P0 (Must Have)  
**Status:** Not Implemented

---

### FR24: Management Commands

**FR24.1** The installer MUST create `aether` CLI command  
**FR24.2** `aether status` MUST show service status  
**FR24.3** `aether logs [service]` MUST show logs  
**FR24.4** `aether restart [service]` MUST restart services  
**FR24.5** `aether update` MUST update to latest version  
**FR24.6** `aether rollback` MUST rollback to previous version  
**FR24.7** `aether backup` MUST backup configuration  
**FR24.8** `aether restore` MUST restore from backup  
**FR24.9** `aether repair` MUST repair broken installation  
**FR24.10** `aether uninstall` MUST remove Aether  

**Priority:** P1 (Should Have)  
**Status:** Not Implemented

---

### FR25: Logging

**FR25.1** The installer MUST create timestamped log file  
**FR25.2** The installer MUST log all stages  
**FR25.3** The installer MUST log all commands executed  
**FR25.4** The installer MUST log errors with stack traces  
**FR25.5** The installer MUST NOT log secrets  
**FR25.6** The installer MUST preserve logs on completion  
**FR25.7** The installer MUST display log file location  

**Priority:** P0 (Must Have)  
**Status:** Not Implemented

---

## Non-Functional Requirements

### NFR1: Performance

**NFR1.1** Installation MUST complete in ≤15 minutes on typical hardware  
**NFR1.2** Installation SHOULD complete in ≤10 minutes on recommended hardware  
**NFR1.3** Preflight checks MUST complete in ≤60 seconds  
**NFR1.4** Download SHOULD utilize available bandwidth efficiently  
**NFR1.5** Resource usage during installation SHOULD stay below 50% CPU/RAM  

**Priority:** P0 (Must Have)  
**Status:** Not Measured

---

### NFR2: Reliability

**NFR2.1** The installer MUST be idempotent (can run multiple times safely)  
**NFR2.2** The installer MUST handle network interruptions gracefully  
**NFR2.3** The installer MUST recover from temporary failures  
**NFR2.4** The installer MUST NOT corrupt existing data on failure  
**NFR2.5** The installer MUST have ≥99% success rate on supported platforms  

**Priority:** P0 (Must Have)  
**Status:** Not Measured

---

### NFR3: Security

**NFR3.1** The installer MUST use HTTPS for all downloads  
**NFR3.2** The installer MUST verify integrity of all downloads  
**NFR3.3** The installer MUST generate cryptographically secure secrets  
**NFR3.4** The installer MUST NOT expose internal services to internet  
**NFR3.5** The installer MUST set appropriate file permissions  
**NFR3.6** The installer MUST NOT log sensitive information  
**NFR3.7** The installer MUST validate all user inputs  
**NFR3.8** The installer MUST prevent command injection  
**NFR3.9** The installer MUST prevent path traversal  
**NFR3.10** The installer MUST use least privilege principle  

**Priority:** P0 (Must Have)  
**Status:** Not Verified

---

### NFR4: Usability

**NFR4.1** The installer MUST provide clear progress indication  
**NFR4.2** The installer MUST provide helpful error messages  
**NFR4.3** The installer MUST suggest remediation for common errors  
**NFR4.4** The installer MUST work for non-technical users  
**NFR4.5** The installer MUST support non-interactive mode  
**NFR4.6** The installer SHOULD complete with ≤2 user interactions  

**Priority:** P0 (Must Have)  
**Status:** Not Evaluated

---

### NFR5: Maintainability

**NFR5.1** The installer MUST be written in standard Bash  
**NFR5.2** The installer MUST be well-commented  
**NFR5.3** The installer MUST follow consistent coding style  
**NFR5.4** The installer MUST be modular (separate functions)  
**NFR5.5** The installer SHOULD be ≤2000 lines of code  

**Priority:** P1 (Should Have)  
**Status:** Not Implemented

---

### NFR6: Compatibility

**NFR6.1** The installer MUST work on Ubuntu 20.04+  
**NFR6.2** The installer MUST work with bash 4.0+  
**NFR6.3** The installer MUST work with systemd-based systems  
**NFR6.4** The installer SHOULD work behind corporate proxies  
**NFR6.5** The installer SHOULD work on IPv4-only networks  
**NFR6.6** The installer SHOULD work on IPv6-only networks  

**Priority:** P0 (Must Have)  
**Status:** Not Tested

---

### NFR7: Observability

**NFR7.1** The installer MUST log all operations  
**NFR7.2** The installer MUST provide installation ID for support  
**NFR7.3** The installer MUST save detailed state information  
**NFR7.4** The installer SHOULD support verbose mode  
**NFR7.5** The installer SHOULD provide progress percentage  

**Priority:** P1 (Should Have)  
**Status:** Not Implemented

---

### NFR8: Recoverability

**NFR8.1** The installer MUST support resume after interruption  
**NFR8.2** The installer MUST support rollback on failure  
**NFR8.3** The installer MUST preserve user data during rollback  
**NFR8.4** The installer MUST NOT require manual cleanup after failure  

**Priority:** P0 (Must Have)  
**Status:** Not Implemented

---

### NFR9: Documentation

**NFR9.1** The installer MUST include inline help text  
**NFR9.2** The installer MUST link to online documentation  
**NFR9.3** The installer MUST provide troubleshooting guidance  
**NFR9.4** Installation summary MUST include next steps  

**Priority:** P0 (Must Have)  
**Status:** Partially Complete

---

### NFR10: Update Support

**NFR10.1** The installer MUST support in-place updates  
**NFR10.2** Updates MUST preserve user data  
**NFR10.3** Updates MUST be reversible (rollback)  
**NFR10.4** Updates MUST verify integrity before applying  
**NFR10.5** Updates SHOULD have zero downtime (future)  

**Priority:** P1 (Should Have)  
**Status:** Not Implemented

---

## Constraints

### C1: Platform Constraints

**C1.1** Initial release supports Ubuntu x86_64 only  
**C1.2** Requires systemd init system  
**C1.3** Requires bash 4.0 or higher  
**C1.4** Requires internet connectivity during installation  
**C1.5** Requires sudo or root access  

---

### C2: Resource Constraints

**C2.1** Minimum 2 CPU cores required  
**C2.2** Minimum 4 GB RAM required  
**C2.3** Minimum 40 GB disk space required  
**C2.4** Requires public IP for external access  
**C2.5** Requires ports 80/443 available for HTTPS  

---

### C3: Network Constraints

**C3.1** Requires outbound HTTPS (443) access  
**C3.2** Requires DNS resolution  
**C3.3** HTTPS setup requires domain pointing to server  
**C3.4** Behind proxy requires HTTP_PROXY environment variable  

---

### C4: Security Constraints

**C4.1** Downloads must be over HTTPS  
**C4.2** Checksum verification is mandatory  
**C4.3** Default credentials are not allowed  
**C4.4** Internal services must not be exposed  

---

### C5: Time Constraints

**C5.1** MVP must be ready for testing within 2 weeks  
**C5.2** Production release targeted for 4 weeks  
**C5.3** Installation should complete in under 15 minutes  

---

## Acceptance Criteria

### AC1: MVP Acceptance

Installation is accepted for MVP when:

- [ ] Installs successfully on fresh Ubuntu 22.04 VPS
- [ ] All services start and are healthy
- [ ] Web interface is accessible
- [ ] Can complete initial setup wizard
- [ ] All security checks pass
- [ ] Documented troubleshooting available

---

### AC2: Production Acceptance

Installation is accepted for production when:

- [ ] Installs on Ubuntu 20.04, 22.04, 24.04
- [ ] Tested on 3+ VPS providers
- [ ] 99% success rate on supported platforms
- [ ] All security tests pass
- [ ] Resume/rollback work correctly
- [ ] Update mechanism works
- [ ] Comprehensive documentation available
- [ ] Third-party security audit completed (optional)

---

## Dependencies

### D1: External Dependencies

- Official Docker installation script
- Release artifact hosting (CDN or GitHub Releases)
- Domain registrar (for HTTPS)
- Let's Encrypt (for SSL certificates)

---

### D2: Internal Dependencies

- Release packaging pipeline
- Checksum generation
- Documentation website
- Support infrastructure

---

## Risks and Mitigations

### Risk 1: Checksum Verification Complexity

**Risk:** Users may not understand security implications  
**Impact:** High  
**Likelihood:** Medium  
**Mitigation:** Clear messaging, automatic verification

---

### Risk 2: Network Interruptions

**Risk:** Installation fails mid-download  
**Impact:** Medium  
**Likelihood:** High  
**Mitigation:** Retry logic, resume capability, state saving

---

### Risk 3: Docker Installation Issues

**Risk:** Docker fails to install on some systems  
**Impact:** High  
**Likelihood:** Medium  
**Mitigation:** Detailed error messages, official Docker script, fallback options

---

### Risk 4: Firewall Lockout

**Risk:** User locks themselves out via firewall changes  
**Impact:** Critical  
**Likelihood:** Low  
**Mitigation:** Always allow SSH first, verify SSH after changes, backup rules

---

### Risk 5: Resource Exhaustion

**Risk:** Installation fails due to insufficient resources  
**Impact:** Medium  
**Likelihood:** Medium  
**Mitigation:** Early resource checking, clear requirements, graceful degradation

---

## Future Enhancements

### Phase 2 (v1.1)
- [ ] Multi-architecture support (ARM64)
- [ ] Additional OS support (Debian, CentOS)
- [ ] GPG signature verification
- [ ] Proxy support improvements
- [ ] Offline installation mode

### Phase 3 (v1.2)
- [ ] Custom Docker registry support
- [ ] Air-gapped installation
- [ ] High availability setup
- [ ] Multi-node deployment
- [ ] Automated backups

### Phase 4 (v2.0)
- [ ] Kubernetes deployment option
- [ ] Cloud provider integrations
- [ ] Infrastructure as Code (Terraform)
- [ ] Zero-downtime updates
- [ ] Automated scaling

---

## Glossary

**VPS:** Virtual Private Server  
**MVP:** Minimum Viable Product  
**HTTPS:** Hypertext Transfer Protocol Secure  
**SSL:** Secure Sockets Layer (colloquially, includes TLS)  
**TLS:** Transport Layer Security  
**DNS:** Domain Name System  
**Checksum:** Cryptographic hash for integrity verification  
**Rollback:** Reverting to previous version  
**Idempotent:** Safe to run multiple times  
**Preflight:** Pre-installation checks  

---

## References

- [Docker Installation Documentation](https://docs.docker.com/engine/install/)
- [Let's Encrypt Documentation](https://letsencrypt.org/docs/)
- [Caddy Documentation](https://caddyserver.com/docs/)
- [PostgreSQL Documentation](https://www.postgresql.org/docs/)
- [Ubuntu Server Guide](https://ubuntu.com/server/docs)

---

**Document Status:** Draft for Review  
**Last Updated:** 2026-09-15 20:06 UTC  
**Approved By:** Pending  
**Next Review:** After MVP implementation

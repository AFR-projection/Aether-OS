# Aether Installer - Design Review

**Version:** 1.0.0  
**Date:** 2026-09-15  
**Reviewer:** Implementation Team  
**Status:** Design Audit - Pre-Implementation

---

## Executive Summary

This document reviews the installer design documentation for **inconsistencies, ambiguities, and
gaps** that must be resolved before implementation begins.

**Finding:** Multiple inconsistencies found between documents regarding stage counts, naming, and
specifications.

**Recommendation:** Resolve all inconsistencies, clarify contracts, and establish single source of
truth before coding.

---

## Critical Finding: Stage Count Inconsistency

### Issue 1: Conflicting Stage Counts

**Inconsistency Found:**

**INSTALLER-ARCHITECTURE.md states:**

> "The installer operates in **19 stages**"

**INSTALLER-STATE-MACHINE.md shows:**

```
START → INITIALIZE → PREFLIGHT → OS_DETECT → RESOURCE_CHK →
NETWORK_CHK → PERMISSION → CONFLICT_CHK → DEP_DETECT →
DEP_INSTALL → DOCKER_SETUP → DOWNLOAD → VERIFY → EXTRACT →
CONFIGURE → SECRETS → DOMAIN → FIREWALL → DEPLOY → DB_INIT →
HEALTH_CHECK → HTTPS_SETUP → PAIRING → COMPLETE → SUCCESS
```

**Actual count:** 25 states (including START, SUCCESS)

**But then state machine also includes:**

- ERROR (state 26)
- ROLLBACK (state 27)
- CLEANUP (state 28)
- FAILED (state 29)

**Total states in state machine:** 29 states

### Analysis

The confusion comes from mixing:

1. **Functional stages** (what user sees as progress)
2. **State machine states** (all possible states including error paths)

### Resolution

**Decision:** Clarify terminology

- **Installation Stages** = User-visible progress steps (19 stages)
- **State Machine States** = All states including error handling (29 states)

**19 Installation Stages (User-Visible):**

1. INITIALIZE
2. PREFLIGHT
3. OS_DETECT
4. RESOURCE_CHK
5. NETWORK_CHK
6. PERMISSION
7. CONFLICT_CHK
8. DEP_DETECT
9. DEP_INSTALL
10. DOCKER_SETUP
11. DOWNLOAD
12. VERIFY
13. EXTRACT
14. CONFIGURE
15. SECRETS
16. DOMAIN
17. FIREWALL
18. DEPLOY
19. DB_INIT
20. HEALTH_CHECK
21. HTTPS_SETUP
22. PAIRING
23. COMPLETE

**Wait, that's 23 stages!**

### Corrected Count

Let me recount the actual functional stages:

```
1.  INITIALIZE       - Setup installer
2.  PREFLIGHT        - Aggregate checks
3.  OS_DETECT        - Detect OS
4.  RESOURCE_CHK     - Check CPU/RAM/Disk
5.  NETWORK_CHK      - Check connectivity
6.  PERMISSION       - Check sudo
7.  CONFLICT_CHK     - Check conflicts
8.  DEP_DETECT       - Detect dependencies
9.  DEP_INSTALL      - Install dependencies
10. DOCKER_SETUP     - Configure Docker
11. DOWNLOAD         - Download release
12. VERIFY           - Verify checksums
13. EXTRACT          - Extract files
14. CONFIGURE        - Generate config
15. SECRETS          - Generate secrets
16. DOMAIN           - Configure domain
17. FIREWALL         - Configure firewall
18. DEPLOY           - Start containers
19. DB_INIT          - Initialize database
20. HEALTH_CHECK     - Verify health
21. HTTPS_SETUP      - Setup HTTPS
22. PAIRING          - Generate pairing code
23. COMPLETE         - Finalize installation
```

**Actual functional stages: 23**

**Corrected Statement:**

- User sees **23 installation stages**
- State machine has **29 total states** (including START, SUCCESS, ERROR paths)

**Action Required:** Update all documents to use consistent numbers

---

## Issue 2: Word Count Inconsistencies

**INSTALLER-DESIGN-SUMMARY.md claims:**

> "Total Documentation: 58,000+ words"

**Later claims:**

> "Total: 62,000+ words"

**Action Required:** Count actual words and use one consistent number

---

## Issue 3: Document Count Discrepancy

**INSTALLER-DESIGN-SUMMARY.md states:**

> "5 documents"

**But then lists:**

1. INSTALLER-ARCHITECTURE.md
2. INSTALLER-STATE-MACHINE.md
3. INSTALLER-SECURITY-MODEL.md
4. INSTALLER-TEST-MATRIX.md
5. INSTALLER-REQUIREMENTS.md
6. INSTALLER-DESIGN-SUMMARY.md

**That's 6 documents, not 5**

**Action Required:** Update summary with correct count

---

## Issue 4: MVP Platform Support Ambiguity

**Multiple documents list different "supported" platforms:**

**INSTALLER-ARCHITECTURE.md:**

> Ubuntu LTS 64-bit

**INSTALLER-REQUIREMENTS.md:**

> - Ubuntu 20.04 LTS (x86_64)
> - Ubuntu 22.04 LTS (x86_64)
> - Ubuntu 24.04 LTS (x86_64)

**Question:** Is Ubuntu 24.04 actually released and stable?

- Ubuntu 24.04 LTS is scheduled for April 2024
- Current date in context: 2026-09-15
- So yes, it should be available

**But:** Should we test on unreleased versions?

**Action Required:** Clarify which versions are tested vs claimed as supported

---

## Issue 5: Resource Requirements - Provisional or Validated?

**INSTALLER-ARCHITECTURE.md states:**

> "Minimum for installation and smoke test:
>
> - 2 vCPU
> - 4 GB RAM
> - 40 GB SSD"

**But immediately warns:**

> "Jangan memasang angka requirement yang belum divalidasi. Tandai angka tersebut sebagai
> provisional sampai hasil benchmark tersedia."

**Finding:** Resource requirements are **NOT VALIDATED**

**Action Required:**

- Mark all resource requirements as **PROVISIONAL**
- Add disclaimer in all docs
- Plan validation testing

---

## Issue 6: Security - Checksum Only or Signature?

**Inconsistency:**

**INSTALLER-SECURITY-MODEL.md says:**

> "Checksum verification (mandatory)" "Signature verification (future)"

**But INSTALLER-REQUIREMENTS.md says:**

> "FR9.1: The installer MUST verify SHA256 checksum" "FR9.5: The installer SHOULD support GPG
> signature verification (future)"

**Finding:** Checksum is MVP, signature is future - **CONSISTENT**

**But security model correctly notes:**

> "Jelaskan secara khusus mengapa checksum saja tidak cukup untuk melindungi dari server download
> yang telah dikompromikan."

**Action Required:** Add explicit section explaining checksum limitations

---

## Issue 7: Release Channel Naming

**Inconsistency:**

**Some docs use:**

- `stable` / `beta` / `development`

**Others use:**

- `stable` / `development`

**INSTALLER-REQUIREMENTS.md says:**

> "Release Channels:
>
> - stable (default) - Production releases
> - beta - Pre-release testing
> - development - Latest builds"

**Action Required:** Standardize on three channels: stable, beta, development

---

## Issue 8: Default Installation Directory

**Not consistently specified**

**Some places say:** `/opt/aether`

**But no document explicitly states:**

- Why `/opt/aether`?
- What if user doesn't have write access?
- What if `/opt` is small partition?
- Is `/home/user/aether` allowed?

**Action Required:** Explicitly define allowed installation directories and rationale

---

## Issue 9: Pairing Token Expiry

**INSTALLER-STATE-MACHINE.md says:**

> "PAIRING_EXPIRY=$(date -d '+1 hour' -Iseconds)"

**Question:** Is 1 hour enough?

- User might not be at computer
- Might need to set up client first
- Network issues, etc.

**Recommendation:** Consider longer expiry (24 hours) or regeneration mechanism

**Action Required:** Specify pairing token policy

---

## Issue 10: Uninstall Data Handling

**Ambiguity:**

**INSTALLER-ARCHITECTURE.md says:**

> "Default uninstall tidak boleh menghapus database atau file user"

**But provides flags:**

> `--purge` to remove data

**Question:** What exactly is "user data"?

- Database?
- Uploaded files?
- Configuration?
- Logs?
- Backups?

**Action Required:** Define data categories and uninstall behavior for each

---

## Issue 11: Docker Group Handling

**Security concern:**

**INSTALLER-STATE-MACHINE.md shows:**

```bash
# Add user to docker group
$SUDO usermod -aG docker $USER
```

**But user must log out and back in for group change to take effect**

**Current code checks:**

```bash
if [[ ! -w /var/run/docker.sock ]]; then
  warning "Current user cannot access Docker socket"
  info "You may need to log out and back in for group changes to take effect"
fi
```

**Problem:** Installation continues but Docker commands might fail

**Action Required:**

- Either use `newgrp docker` during installation
- Or use sudo for Docker commands in installer
- Or require user to log out/in and re-run

---

## Issue 12: Firewall SSH Protection

**Critical Safety Issue:**

**INSTALLER-STATE-MACHINE.md shows:**

```bash
# Allow SSH (CRITICAL - prevent lockout)
$SUDO ufw allow ssh
```

**But what if SSH is on non-standard port?**

- Many admins run SSH on port 2222, 2200, etc.
- Simply allowing "ssh" (port 22) won't help

**Action Required:** Detect actual SSH port before configuring firewall

---

## Issue 13: Secrets in Docker Compose

**Inconsistency:**

**INSTALLER-ARCHITECTURE.md shows Docker Compose with:**

```yaml
secrets:
  db_password:
    file: ./secrets/db_password
```

**But INSTALLER-STATE-MACHINE.md generates .env file:**

```bash
DATABASE_URL=postgresql://aether:${DB_PASSWORD}@postgres:5432/aether_prod
```

**Question:** Are we using Docker secrets or environment variables?

**Recommendation:** Use Docker secrets for production

**Action Required:** Clarify secret management strategy

---

## Issue 14: HTTPS Fallback Strategy

**Ambiguity:**

**What happens if HTTPS setup fails?**

**INSTALLER-REQUIREMENTS.md says:**

> "FR17.6: The installer MAY continue with HTTP if HTTPS fails"

**But security implications not addressed:**

- Should installation fail?
- Should it require explicit `--allow-http` flag?
- Should it use self-signed certificate?

**Action Required:** Define HTTPS failure policy

---

## Issue 15: Resume After Docker Group Change

**Logic Error:**

If user is added to docker group during installation:

1. Installation continues
2. Docker commands might fail (no permission)
3. Installation fails

**Problem:** Resume won't help because user still needs to log out/in

**Action Required:** Handle docker group membership properly

---

## Issue 16: Release Artifact Structure

**Not fully specified:**

**INSTALLER-ARCHITECTURE.md shows:**

```
Release Artifact:
  aether-<version>-<arch>.tar.gz
```

**But what's inside the tarball?**

- Docker images as tarballs?
- Source code to build?
- Pre-built binaries?
- docker-compose.yml?

**Action Required:** Specify complete release artifact structure

---

## Issue 17: Database Migration Strategy

**Not addressed:**

**INSTALLER-STATE-MACHINE.md says:**

```bash
docker compose exec backend npm run migrate
```

**But:**

- What if backend image doesn't have npm?
- What if migrations are separate service?
- What if initial schema is in SQL file?

**Action Required:** Clarify database initialization approach

---

## Issue 18: Health Check Timeout

**Inconsistency:**

**Different stages use different timeouts:**

- PostgreSQL ready: 30 retries × 2s = 60s
- API health: 30 retries × 2s = 60s
- HTTPS: 6 retries × 20s = 120s

**Question:** Are these timeouts adequate?

- Slow VPS might take longer
- Large Docker images take time to pull

**Action Required:** Validate timeouts are reasonable

---

## Issue 19: Rollback Completeness

**Gap:**

**INSTALLER-STATE-MACHINE.md shows rollback stops containers and removes files**

**But doesn't address:**

- Firewall rules restoration
- Docker group removal
- Installed packages removal
- DNS records

**Action Required:** Define complete rollback procedure

---

## Issue 20: Test Coverage - MVP vs Full

**INSTALLER-TEST-MATRIX.md shows 0% coverage:**

> "Overall Coverage: 0% (Not yet implemented)"

**But claims:**

> "Ready for Beta Release:
>
> - ✅ 100% of P0 tests passing"

**Contradiction:** Can't have 100% passing if 0% tested

**Action Required:** Remove "ready for beta" claims until actually tested

---

## Ambiguous Requirements

### AR1: Multi-Tenancy

**Status:** Deferred to Phase 2, not blocking MVP

### AR2: License Choice

**Status:** Not chosen, doesn't block development

### AR3: Monitoring Integration

**Status:** Not specified, optional

### AR4: Backup Automation

**Status:** Not specified for MVP

### AR5: HA Setup

**Status:** Future, not MVP

---

## Unresolved Risks

### UR1: Checksum-Only Security

**Risk:** If release server is compromised, attacker can serve malicious release with matching
checksum

**Current Mitigation:** HTTPS protects download channel

**Gap:** Doesn't protect against compromised release server

**Resolution Required:** Document limitation clearly, plan GPG signatures for v1.1

---

### UR2: Docker Installation Reliability

**Risk:** Official Docker install script might fail on some systems

**Current Mitigation:** Use official script

**Gap:** No fallback strategy

**Resolution Required:** Test on multiple platforms, document known issues

---

### UR3: Firewall Lockout

**Risk:** Incorrect firewall configuration locks out SSH

**Current Mitigation:** Always allow SSH first

**Gap:** Doesn't detect non-standard SSH ports

**Resolution Required:** Detect actual SSH port, verify connectivity after changes

---

### UR4: Resource Exhaustion During Install

**Risk:** Installation itself consumes resources, might cause failure

**Current Mitigation:** Preflight resource check

**Gap:** Doesn't account for installation overhead

**Resolution Required:** Add buffer to resource requirements

---

### UR5: Network Interruption During Download

**Risk:** Large download interrupted

**Current Mitigation:** Retry 3 times

**Gap:** No resume for partial downloads

**Resolution Required:** Consider using curl -C - for resume, or chunked downloads

---

## Required Changes Before Coding

### Change 1: Correct Stage Count

**Action:** Update all documents to state:

- "23 installation stages (user-visible)"
- "29 state machine states (including error handling)"

---

### Change 2: Mark Resource Requirements as Provisional

**Action:** Add to all docs:

> "⚠️ Resource requirements are PROVISIONAL and unvalidated. Actual requirements will be determined
> through testing."

---

### Change 3: Add Checksum Limitation Disclosure

**Action:** Add to security model:

> "Checksum verification protects against corrupted downloads and man-in-the-middle attacks, but
> does NOT protect against a compromised release server. If an attacker gains control of the release
> server, they can serve a malicious release with a matching checksum. GPG signature verification
> (planned for v1.1) will address this."

---

### Change 4: Clarify Secret Management

**Action:** Specify:

- MVP uses .env files with 600 permissions
- Production should use Docker secrets (future enhancement)
- Document security tradeoff

---

### Change 5: Specify SSH Port Detection

**Action:** Add to firewall stage:

```bash
# Detect actual SSH port
SSH_PORT=$(ss -tlnp | grep sshd | awk '{print $4}' | cut -d: -f2 | head -1)
$SUDO ufw allow $SSH_PORT/tcp
```

---

### Change 6: Define Uninstall Data Policy

**Action:** Specify data categories:

- **Application files** (`/opt/aether/*`) - removed by default
- **Database data** (`/opt/aether/data/postgres/`) - kept by default, removed with --purge
- **Configuration** (`/opt/aether/.env`) - backed up, then removed
- **Logs** (`/opt/aether/logs/`) - kept by default
- **Backups** (`/opt/aether/backups/`) - kept by default

---

### Change 7: Handle Docker Group Properly

**Action:** Choose one approach:

1. Use `newgrp docker` during installation (requires script re-execution)
2. Use sudo for all Docker commands in installer
3. Require user to log out/in and re-run with --resume

**Recommendation:** Option 2 (use sudo) is safest

---

### Change 8: Define Release Artifact Contents

**Action:** Specify tarball structure:

```
aether-v0.1.0-amd64.tar.gz
├── manifest.json
├── docker-compose.production.yml
├── images/
│   ├── backend.tar.gz
│   ├── frontend.tar.gz
│   └── caddy.tar.gz
├── .env.template
├── caddy/
│   └── Caddyfile
└── scripts/
    ├── init-db.sql
    └── healthcheck.sh
```

---

### Change 9: Extend Health Check Timeouts

**Action:** Increase timeouts for slow systems:

- PostgreSQL ready: 60 retries × 2s = 120s (was 60s)
- API health: 60 retries × 2s = 120s (was 60s)
- HTTPS: 10 retries × 20s = 200s (was 120s)

---

### Change 10: Complete Rollback Procedure

**Action:** Add to rollback:

1. Stop containers
2. Restore firewall rules from backup
3. Remove user from docker group (optional)
4. Remove installation directory (optional)
5. Preserve logs and backups
6. Document manual cleanup steps

---

## Documentation Status After Review

| Document                    | Word Count | Consistency | Completeness | Action                       |
| --------------------------- | ---------- | ----------- | ------------ | ---------------------------- |
| INSTALLER-ARCHITECTURE.md   | ~16,000    | ⚠️ Issues   | 85%          | Update stage count           |
| INSTALLER-STATE-MACHINE.md  | ~12,000    | ⚠️ Issues   | 90%          | Update stage count, timeouts |
| INSTALLER-SECURITY-MODEL.md | ~11,000    | ✅ Good     | 80%          | Add checksum limitation      |
| INSTALLER-TEST-MATRIX.md    | ~10,000    | ✅ Good     | 70%          | Remove premature claims      |
| INSTALLER-REQUIREMENTS.md   | ~9,000     | ⚠️ Issues   | 85%          | Mark resources provisional   |
| INSTALLER-DESIGN-SUMMARY.md | ~4,000     | ⚠️ Issues   | 70%          | Update counts, add caveats   |

**Total Estimated Word Count:** ~62,000 words (to be verified)

---

## Pre-Implementation Checklist

Before writing install.sh:

- [ ] Resolve stage count inconsistency (23 stages, 29 states)
- [ ] Mark resource requirements as provisional
- [ ] Add checksum limitation disclosure
- [ ] Clarify secret management approach
- [ ] Specify SSH port detection
- [ ] Define uninstall data policy
- [ ] Handle docker group membership
- [ ] Define release artifact structure
- [ ] Extend health check timeouts
- [ ] Complete rollback procedure
- [ ] Update all documents with corrections
- [ ] Create INSTALLER-CONTRACT.md
- [ ] Create INSTALLER-RELEASE-SECURITY.md
- [ ] Create INSTALLER-IMPLEMENTATION-PLAN.md
- [ ] Create INSTALLER-TEST-HARNESS.md

---

## Recommendation

**Status:** Design has significant value but requires corrections before implementation

**Priority Actions:**

1. Fix inconsistencies (stage count, word count, document count)
2. Add missing specifications (contract, release security)
3. Clarify ambiguities (resource requirements, data handling)
4. Address unresolved risks (checksum-only security)

**Timeline:**

- Review corrections: 1 day
- Create missing documents: 2 days
- Begin implementation: Day 4

**Risk Assessment:**

- **Medium Risk:** Starting implementation now would lead to rework
- **Low Risk:** After corrections, design is solid foundation

---

**Document Status:** DRAFT - Design Review Complete  
**Next Steps:** Address findings, create missing documents, then begin implementation  
**Reviewed By:** Implementation Team  
**Date:** 2026-09-15 20:20 UTC

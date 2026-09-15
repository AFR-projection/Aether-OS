# Aether Installer - Test Matrix

**Version:** 1.0.0  
**Date:** 2026-09-15  
**Status:** Draft - Design Phase

---

## Overview

This document defines comprehensive test coverage for the Aether installer across multiple dimensions:
- Operating systems and distributions
- Resource configurations
- Network conditions
- User permissions
- Installation scenarios
- Error conditions
- Security scenarios

**Test Coverage Goal:** 90%+ of real-world installation scenarios

---

## Test Dimensions

### Dimension 1: Operating System

| OS | Version | Architecture | Priority | Status |
|----|---------|--------------|----------|--------|
| Ubuntu | 22.04 LTS | x86_64 | **P0** | Not Tested |
| Ubuntu | 24.04 LTS | x86_64 | **P0** | Not Tested |
| Ubuntu | 20.04 LTS | x86_64 | P1 | Not Tested |
| Ubuntu | 22.04 LTS | aarch64 | P2 | Not Supported |
| Debian | 12 (Bookworm) | x86_64 | P2 | Not Supported |
| Debian | 11 (Bullseye) | x86_64 | P2 | Not Supported |
| Rocky Linux | 9 | x86_64 | P3 | Not Supported |
| CentOS Stream | 9 | x86_64 | P3 | Not Supported |
| Fedora | 39 | x86_64 | P3 | Not Supported |
| openSUSE | Leap 15 | x86_64 | P3 | Not Supported |
| Arch Linux | Rolling | x86_64 | P4 | Not Supported |
| Alpine Linux | 3.19 | x86_64 | P4 | Not Supported |

**Priority Definitions:**
- **P0**: Must work for MVP launch
- **P1**: Should work for v1.0
- **P2**: Nice to have for v1.x
- **P3**: Future consideration
- **P4**: Community contribution

---

### Dimension 2: VPS Providers

| Provider | Instance Type | Priority | Status |
|----------|--------------|----------|--------|
| DigitalOcean | Droplet (Basic) | **P0** | Not Tested |
| AWS | EC2 t3.medium | **P0** | Not Tested |
| Linode | Shared CPU | **P0** | Not Tested |
| Vultr | Cloud Compute | **P0** | Not Tested |
| Hetzner | CX21 | P1 | Not Tested |
| Google Cloud | e2-medium | P1 | Not Tested |
| Azure | B2s | P1 | Not Tested |
| OVH | VPS SSD | P2 | Not Tested |
| Contabo | VPS S | P2 | Not Tested |
| Custom/On-prem | Various | P3 | Not Tested |

---

### Dimension 3: Resource Configurations

#### CPU/RAM Combinations

| CPUs | RAM | Disk | Expected | Status |
|------|-----|------|----------|--------|
| 1 | 2 GB | 20 GB | ❌ Block (below minimum) | Not Tested |
| 2 | 4 GB | 40 GB | ✅ Allow (minimum) | Not Tested |
| 2 | 4 GB | 30 GB | ⚠️ Warn (disk low) | Not Tested |
| 4 | 8 GB | 80 GB | ✅ Allow (recommended) | Not Tested |
| 8 | 16 GB | 160 GB | ✅ Allow (ideal) | Not Tested |
| 2 | 8 GB | 100 GB | ✅ Allow | Not Tested |
| 4 | 4 GB | 80 GB | ⚠️ Warn (RAM low) | Not Tested |

---

### Dimension 4: Pre-existing Software

| Condition | Expected Behavior | Status |
|-----------|------------------|--------|
| Fresh Ubuntu install | ✅ Clean install | Not Tested |
| Docker already installed | ✅ Use existing | Not Tested |
| Docker Compose v1 installed | ✅ Install v2 | Not Tested |
| Nginx running on port 80 | ⚠️ Warn conflict | Not Tested |
| Apache running on port 80/443 | ⚠️ Warn conflict | Not Tested |
| Caddy already installed | ⚠️ Warn conflict | Not Tested |
| PostgreSQL installed locally | ⚠️ Warn, use Docker | Not Tested |
| Redis installed locally | ⚠️ Warn, use Docker | Not Tested |
| Existing Aether installation | ❌ Block or upgrade | Not Tested |
| UFW enabled | ✅ Configure rules | Not Tested |
| UFW disabled | ✅ Enable and configure | Not Tested |
| firewalld active | ⚠️ Manual configuration | Not Tested |
| iptables custom rules | ⚠️ Manual review | Not Tested |
| Fail2ban running | ✅ Compatible | Not Tested |

---

### Dimension 5: Network Conditions

| Condition | Expected Behavior | Status |
|-----------|------------------|--------|
| Fast internet (100+ Mbps) | ✅ Normal install | Not Tested |
| Slow internet (1-5 Mbps) | ⏳ Slower but succeeds | Not Tested |
| Unstable connection | 🔄 Retry downloads | Not Tested |
| IPv4 only | ✅ Works | Not Tested |
| IPv6 only | ✅ Works | Not Tested |
| Dual stack | ✅ Prefers IPv4 | Not Tested |
| Behind NAT | ✅ Works (outbound only) | Not Tested |
| Behind corporate proxy | ⚠️ May need configuration | Not Tested |
| Port 80 blocked | ❌ Block or alt port | Not Tested |
| Port 443 blocked | ❌ Block or alt port | Not Tested |
| DNS resolution slow | ⏳ Timeout increased | Not Tested |
| DNS resolution fails | ❌ Block | Not Tested |

---

### Dimension 6: Domain Configuration

| Scenario | Expected Behavior | Status |
|----------|------------------|--------|
| No domain provided | ✅ IP-only access, no HTTPS | Not Tested |
| Valid domain, DNS correct | ✅ HTTPS auto-configured | Not Tested |
| Valid domain, DNS not pointing | ⚠️ Warn, HTTP only | Not Tested |
| Invalid domain format | ❌ Block | Not Tested |
| Domain with subdomain | ✅ Works | Not Tested |
| Wildcard domain | ⚠️ Not supported | Not Tested |
| Domain behind CloudFlare | ✅ Works with proxy | Not Tested |
| Domain with existing SSL cert | ⚠️ Manual import needed | Not Tested |
| IP address instead of domain | ⚠️ Reject, suggest domain | Not Tested |

---

### Dimension 7: User Permissions

| User Type | sudo | Expected Behavior | Status |
|-----------|------|------------------|--------|
| root | N/A | ⚠️ Warn, proceed | Not Tested |
| user with passwordless sudo | Yes | ✅ Ideal | Not Tested |
| user with password sudo | Yes | ✅ Prompt for password | Not Tested |
| user without sudo | No | ❌ Block | Not Tested |
| user in docker group | Yes | ✅ No sudo for docker | Not Tested |
| user not in docker group | Yes | ✅ Add to group | Not Tested |

---

### Dimension 8: Installation Scenarios

| Scenario | Expected Behavior | Status |
|----------|------------------|--------|
| First-time install | ✅ Complete install | Not Tested |
| Re-run on same system | ⚠️ Detect existing, offer upgrade | Not Tested |
| Install after failed install | 🔄 Resume from checkpoint | Not Tested |
| Install after uninstall | ✅ Fresh install | Not Tested |
| Install with --dry-run | 📋 Show plan, no changes | Not Tested |
| Install with --yes | ✅ No prompts | Not Tested |
| Install with --domain | ✅ Use provided domain | Not Tested |
| Install with --install-dir | ✅ Use custom directory | Not Tested |
| Install with --channel dev | ✅ Use development release | Not Tested |
| Install interrupted (Ctrl+C) | 💾 Save state | Not Tested |
| Install interrupted (network) | 💾 Save state, resume | Not Tested |
| Install interrupted (disk full) | ❌ Fail gracefully | Not Tested |
| Install during system update | ⚠️ Warn, may conflict | Not Tested |

---

### Dimension 9: Error Scenarios

| Error | Expected Behavior | Status |
|-------|------------------|--------|
| Checksum mismatch | ❌ Block, security alert | Not Tested |
| Download fails (404) | ❌ Clear error message | Not Tested |
| Download fails (timeout) | 🔄 Retry 3 times | Not Tested |
| Disk full during install | ❌ Fail, cleanup | Not Tested |
| Out of memory | ❌ Fail, cleanup | Not Tested |
| Docker daemon won't start | ❌ Fail with diagnostics | Not Tested |
| PostgreSQL won't start | ❌ Fail with logs | Not Tested |
| Cannot bind port 80 | ❌ Fail, suggest alternatives | Not Tested |
| Database migration fails | ❌ Rollback | Not Tested |
| Health check fails | ❌ Fail, show logs | Not Tested |
| HTTPS cert fails | ⚠️ Warn, continue with HTTP | Not Tested |
| Firewall lockout | ⚠️ Warn, show fix | Not Tested |

---

### Dimension 10: Security Scenarios

| Scenario | Expected Behavior | Status |
|----------|------------------|--------|
| MITM attack (bad cert) | ❌ TLS error, block | Not Tested |
| Tampered release file | ❌ Checksum fail, block | Not Tested |
| SQL injection in domain | ❌ Input validation blocks | Not Tested |
| Command injection in path | ❌ Input validation blocks | Not Tested |
| Path traversal attempt | ❌ Path validation blocks | Not Tested |
| Weak secret generation | ✅ Sufficient entropy | Not Tested |
| Secret leakage in logs | ✅ No secrets in logs | Not Tested |
| Exposed PostgreSQL port | ❌ Should be internal only | Not Tested |
| Exposed Redis port | ❌ Should be internal only | Not Tested |
| Default credentials used | ❌ All credentials random | Not Tested |
| Docker socket mounted | ❌ Should not happen | Not Tested |

---

## Test Suites

### Suite 1: Smoke Tests (P0)

**Purpose:** Basic functionality on supported platforms

**Tests:**
1. Fresh Ubuntu 22.04 install
2. User with sudo access
3. No existing software
4. Good internet connection
5. No domain (IP-only)

**Expected Result:** Successful installation in < 10 minutes

**Status:** ❌ Not Tested

---

### Suite 2: Compatibility Tests (P1)

**Purpose:** Verify multiple OS and configurations

**Tests:**
1. Ubuntu 20.04, 22.04, 24.04
2. Minimum resources (2 CPU, 4 GB RAM)
3. Recommended resources (4 CPU, 8 GB RAM)
4. With Docker pre-installed
5. With Nginx on port 80

**Expected Result:** All pass or warn appropriately

**Status:** ❌ Not Tested

---

### Suite 3: Network Tests (P1)

**Purpose:** Various network conditions

**Tests:**
1. No domain provided
2. Domain with correct DNS
3. Domain with incorrect DNS
4. Behind NAT
5. Slow internet connection

**Expected Result:** Appropriate handling of each scenario

**Status:** ❌ Not Tested

---

### Suite 4: Error Handling Tests (P1)

**Purpose:** Graceful error handling

**Tests:**
1. Interrupt during download
2. Interrupt during deployment
3. Disk full
4. Network failure
5. Service start failure

**Expected Result:** Save state, allow resume or rollback

**Status:** ❌ Not Tested

---

### Suite 5: Security Tests (P0)

**Purpose:** Security controls work

**Tests:**
1. Checksum verification (valid)
2. Checksum verification (invalid)
3. Input validation (domain)
4. Input validation (path)
5. Secret generation (entropy)
6. Secret storage (permissions)
7. Network isolation (no exposed ports)
8. Firewall configuration

**Expected Result:** All security controls enforced

**Status:** ❌ Not Tested

---

### Suite 6: Upgrade Tests (P2)

**Purpose:** Upgrade existing installation

**Tests:**
1. Upgrade from v0.1.0 to v0.2.0
2. Upgrade with data preservation
3. Rollback after failed upgrade

**Expected Result:** Successful upgrade or rollback

**Status:** ❌ Not Tested

---

### Suite 7: Uninstall Tests (P2)

**Purpose:** Clean removal

**Tests:**
1. Uninstall (keep data)
2. Uninstall (remove data)
3. Uninstall and reinstall

**Expected Result:** Clean removal

**Status:** ❌ Not Tested

---

## Test Execution Plan

### Phase 1: Manual Testing (Week 1)

**Goal:** Validate installer works at all

**Platform:** Ubuntu 22.04 on DigitalOcean

**Tests:**
- [ ] Fresh install smoke test
- [ ] Installation completes without errors
- [ ] All services start
- [ ] Health checks pass
- [ ] Can access via browser
- [ ] Basic security checks

**Success Criteria:** One successful end-to-end installation

---

### Phase 2: Core Scenarios (Week 2)

**Goal:** Handle common scenarios

**Platforms:** Ubuntu 20.04, 22.04, 24.04

**Tests:**
- [ ] Fresh install on each version
- [ ] Install with existing Docker
- [ ] Install with domain + DNS
- [ ] Install with no domain
- [ ] Install with minimum resources

**Success Criteria:** 5/5 scenarios pass

---

### Phase 3: Error Handling (Week 3)

**Goal:** Graceful error handling

**Tests:**
- [ ] Interrupt and resume
- [ ] Checksum failure
- [ ] Network failure
- [ ] Disk full
- [ ] Port conflict
- [ ] Rollback

**Success Criteria:** All errors handled gracefully

---

### Phase 4: Security Validation (Week 3)

**Goal:** Security controls enforced

**Tests:**
- [ ] Checksum verification
- [ ] Input validation
- [ ] Secret generation
- [ ] Network isolation
- [ ] Firewall configuration
- [ ] No secrets in logs

**Success Criteria:** All security tests pass

---

### Phase 5: Multi-Provider (Week 4)

**Goal:** Works across VPS providers

**Providers:**
- [ ] DigitalOcean
- [ ] AWS
- [ ] Linode
- [ ] Vultr

**Success Criteria:** Works on all major providers

---

### Phase 6: Automated Testing (Ongoing)

**Goal:** Automated test suite

**Implementation:**
- CI/CD pipeline for installer
- Automated VM provisioning
- Test execution
- Result reporting

**Success Criteria:** Automated runs on every commit

---

## Test Cases

### TC001: Fresh Install - Ubuntu 22.04 LTS

**Priority:** P0  
**Status:** ❌ Not Tested

**Prerequisites:**
- Fresh Ubuntu 22.04 LTS install
- User with sudo access
- Internet connectivity
- Public IP address

**Steps:**
1. SSH into server
2. Run: `curl -fsSL https://aether-os.io/install.sh | bash`
3. Wait for installation
4. Verify services running: `docker compose ps`
5. Check health: `curl http://localhost:3000/health`
6. Access in browser: `http://<IP>`

**Expected Result:**
- Installation completes without errors
- All services running
- Health check passes
- Web interface accessible

**Actual Result:** Not tested

---

### TC002: Install with Domain and HTTPS

**Priority:** P0  
**Status:** ❌ Not Tested

**Prerequisites:**
- Fresh Ubuntu 22.04 LTS install
- Domain with DNS pointing to server
- User with sudo access

**Steps:**
1. Point DNS A record to server IP
2. Wait for DNS propagation
3. Run: `curl -fsSL https://aether-os.io/install.sh | bash -s -- --domain cloud.example.com`
4. Wait for installation
5. Verify HTTPS: `curl https://cloud.example.com/health`

**Expected Result:**
- Installation completes
- Caddy obtains SSL certificate
- HTTPS works

**Actual Result:** Not tested

---

### TC003: Install with Existing Docker

**Priority:** P1  
**Status:** ❌ Not Tested

**Prerequisites:**
- Ubuntu 22.04 with Docker pre-installed
- User in docker group

**Steps:**
1. Verify Docker: `docker --version`
2. Run installer
3. Verify Docker not reinstalled

**Expected Result:**
- Installer detects existing Docker
- Uses existing installation
- No Docker reinstallation

**Actual Result:** Not tested

---

### TC004: Install on Minimum Resources

**Priority:** P1  
**Status:** ❌ Not Tested

**Prerequisites:**
- VPS with 2 CPU, 4 GB RAM, 40 GB disk

**Steps:**
1. Run installer
2. Note any warnings

**Expected Result:**
- Installation succeeds
- Warning about meeting minimum (not recommended)
- All services start

**Actual Result:** Not tested

---

### TC005: Install Below Minimum Resources

**Priority:** P1  
**Status:** ❌ Not Tested

**Prerequisites:**
- VPS with 1 CPU, 2 GB RAM, 20 GB disk

**Steps:**
1. Run installer

**Expected Result:**
- Installation blocked
- Clear error message
- Resource requirements shown

**Actual Result:** Not tested

---

### TC006: Interrupt and Resume

**Priority:** P1  
**Status:** ❌ Not Tested

**Prerequisites:**
- Fresh Ubuntu install

**Steps:**
1. Start installation
2. Press Ctrl+C during DOWNLOAD stage
3. Verify state saved
4. Re-run installer
5. Verify resume offered

**Expected Result:**
- State saved on interrupt
- Resume option offered
- Installation continues from checkpoint

**Actual Result:** Not tested

---

### TC007: Checksum Verification Failure

**Priority:** P0  
**Status:** ❌ Not Tested

**Prerequisites:**
- Test environment with tampered release file

**Steps:**
1. Modify release artifact
2. Run installer
3. Observe checksum verification

**Expected Result:**
- Checksum mismatch detected
- Security alert displayed
- Installation blocked
- Downloaded file deleted

**Actual Result:** Not tested

---

### TC008: Input Validation - Domain

**Priority:** P0  
**Status:** ❌ Not Tested

**Test Inputs:**
```bash
# Valid
--domain example.com
--domain cloud.example.com
--domain sub.domain.example.com

# Invalid
--domain example.com/../../etc/passwd
--domain "example.com; rm -rf /"
--domain 192.168.1.1
--domain ../../../root
--domain <script>alert(1)</script>
```

**Expected Result:**
- Valid domains accepted
- Invalid domains rejected
- No command injection
- No path traversal

**Actual Result:** Not tested

---

### TC009: Network Isolation Verification

**Priority:** P0  
**Status:** ❌ Not Tested

**Steps:**
1. Complete installation
2. Test external access to internal services:
   ```bash
   curl http://<IP>:5432  # PostgreSQL
   curl http://<IP>:6379  # Redis
   curl http://<IP>:3000  # Backend
   ```

**Expected Result:**
- All requests fail (connection refused)
- Only Caddy (80/443) accessible

**Actual Result:** Not tested

---

### TC010: Secret Generation Quality

**Priority:** P0  
**Status:** ❌ Not Tested

**Steps:**
1. Complete installation
2. Examine generated secrets:
   ```bash
   cat /opt/aether/secrets/*
   ```
3. Verify entropy and length

**Expected Result:**
- All secrets cryptographically random
- Sufficient length (≥32 chars)
- Different from each other
- No predictable patterns

**Actual Result:** Not tested

---

### TC011: Rollback After Failure

**Priority:** P1  
**Status:** ❌ Not Tested

**Steps:**
1. Cause installation failure (simulate disk full)
2. Choose rollback option
3. Verify cleanup

**Expected Result:**
- Containers stopped
- Option to remove files
- Firewall rules restored
- Clean state

**Actual Result:** Not tested

---

### TC012: Uninstall and Reinstall

**Priority:** P2  
**Status:** ❌ Not Tested

**Steps:**
1. Complete installation
2. Run: `aether uninstall --purge`
3. Verify removal
4. Run installer again

**Expected Result:**
- Complete removal
- Fresh install succeeds

**Actual Result:** Not tested

---

## Test Automation

### Automated Test Framework

```bash
#!/bin/bash
# test-installer.sh

TESTS_PASSED=0
TESTS_FAILED=0
TESTS_SKIPPED=0

run_test() {
  local test_name=$1
  local test_function=$2
  
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "Running: $test_name"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  
  if $test_function; then
    echo "✅ PASSED: $test_name"
    TESTS_PASSED=$((TESTS_PASSED + 1))
  else
    echo "❌ FAILED: $test_name"
    TESTS_FAILED=$((TESTS_FAILED + 1))
  fi
  
  echo ""
}

# Test: Fresh install
test_fresh_install() {
  # Provision VM
  # Run installer
  # Verify services
  # Cleanup
  return 0
}

# Test: Checksum verification
test_checksum_verification() {
  # Create test release with known checksum
  # Verify installer validates correctly
  # Test with wrong checksum
  # Verify installer blocks
  return 0
}

# Run all tests
run_test "TC001: Fresh Install" test_fresh_install
run_test "TC007: Checksum Verification" test_checksum_verification

# Summary
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Test Summary"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Passed:  $TESTS_PASSED"
echo "Failed:  $TESTS_FAILED"
echo "Skipped: $TESTS_SKIPPED"
echo ""

if [[ $TESTS_FAILED -gt 0 ]]; then
  exit 1
fi

exit 0
```

---

## Test Infrastructure

### Test Environments

```yaml
# .github/workflows/test-installer.yml
name: Test Installer

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test-ubuntu-22:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
      
      - name: Run installer tests
        run: ./scripts/test-installer.sh
      
      - name: Upload logs
        if: always()
        uses: actions/upload-artifact@v3
        with:
          name: test-logs
          path: /tmp/aether-install-*.log

  test-ubuntu-20:
    runs-on: ubuntu-20.04
    steps:
      - uses: actions/checkout@v4
      - name: Run installer tests
        run: ./scripts/test-installer.sh
```

---

## Test Reporting

### Test Report Format

```
Aether Installer Test Report
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Date: 2026-09-15
Version: 0.1.0
Tester: CI/CD
Environment: Ubuntu 22.04 LTS

Test Summary
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Total Tests: 50
Passed: 45 ✅
Failed: 3 ❌
Skipped: 2 ⏭️

Pass Rate: 90%

Failed Tests
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
❌ TC008: Domain validation rejected valid subdomain
❌ TC009: Redis port was exposed (should be internal)
❌ TC011: Rollback failed to restore firewall rules

Critical Issues: 1 (TC009)
High Issues: 1 (TC011)
Medium Issues: 1 (TC008)

Recommendations
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Fix network isolation for Redis (CRITICAL)
2. Improve rollback procedure
3. Relax domain validation regex

Detailed Logs: /artifacts/test-logs-20260915.tar.gz
```

---

## Coverage Tracking

### Current Coverage (MVP - Not Yet Tested)

| Category | Target | Current | Status |
|----------|--------|---------|--------|
| OS Coverage | 3 versions | 0 | ❌ 0% |
| VPS Providers | 4 providers | 0 | ❌ 0% |
| Error Scenarios | 15 scenarios | 0 | ❌ 0% |
| Security Tests | 10 tests | 0 | ❌ 0% |
| Network Tests | 8 scenarios | 0 | ❌ 0% |
| Installation Scenarios | 12 scenarios | 0 | ❌ 0% |

**Overall Coverage:** 0% (Not yet implemented)

---

## Testing Timeline

### Week 1: Foundation
- [ ] Set up test infrastructure
- [ ] Create test VMs
- [ ] Implement basic test harness
- [ ] Run first smoke test

### Week 2: Core Testing
- [ ] Test on 3 Ubuntu versions
- [ ] Test on 2 VPS providers
- [ ] Basic error handling
- [ ] Security validation

### Week 3: Comprehensive
- [ ] All error scenarios
- [ ] Network configurations
- [ ] Resume/rollback
- [ ] Complete security suite

### Week 4: Automation
- [ ] CI/CD integration
- [ ] Automated provisioning
- [ ] Test reporting
- [ ] Performance benchmarks

---

## Success Criteria

**Ready for Beta Release:**
- ✅ 100% of P0 tests passing
- ✅ 80% of P1 tests passing
- ✅ All security tests passing
- ✅ Tested on 3 OS versions
- ✅ Tested on 2 VPS providers

**Ready for Production:**
- ✅ 100% of P0 and P1 tests passing
- ✅ 50% of P2 tests passing
- ✅ Automated test suite
- ✅ Tested on 4+ VPS providers
- ✅ Third-party security audit

---

## Known Limitations

1. **Not yet implemented** - Installer is in design phase
2. **No automated tests** - Manual testing only initially
3. **Limited OS support** - Ubuntu only for MVP
4. **No signature verification** - Checksum only for MVP
5. **Single architecture** - x86_64 only for MVP

---

## Test Data

### Test Domains
- `test1.aether-os.io` → Points to test server 1
- `test2.aether-os.io` → Points to test server 2
- `invalid.test` → Does not resolve

### Test Credentials
- Test DB: `aether_test` / `test_password_123`
- Test Redis: `test_redis_password`

### Test Releases
- `test-release-valid.tar.gz` → Valid test release
- `test-release-invalid.tar.gz` → Invalid checksum
- `test-release-malformed.tar.gz` → Corrupted archive

---

**Document Status:** Draft for Review  
**Last Updated:** 2026-09-15 20:30 UTC  
**Next:** Implementation and first test execution

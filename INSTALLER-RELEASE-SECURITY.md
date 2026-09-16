# Aether Installer - Release Security Model

**Version:** 1.0.0  
**Date:** 2026-09-15  
**Status:** Draft - Security Specification

---

## Purpose

This document specifies the security model for Aether release artifacts, addressing:

- How releases are built and packaged
- How integrity is verified
- Why checksum-only verification is insufficient
- Path to cryptographic signatures
- Trust model and threat scenarios

---

## 1. Current Security Model (MVP)

### 1.1 Release Artifacts

**Release Package Structure:**

```
aether-v0.1.0-amd64.tar.gz          # Main release archive
├── manifest.json                    # Release metadata
├── docker-compose.production.yml    # Production configuration
├── images/                          # Docker images
│   ├── backend.tar.gz              # Backend image
│   ├── frontend.tar.gz             # Frontend image
│   └── caddy.tar.gz                # Caddy image
├── .env.template                    # Environment template
├── caddy/                           # Caddy configuration
│   └── Caddyfile.template          # Caddy template
└── scripts/                         # Helper scripts
    ├── init-db.sql                 # Database initialization
    └── healthcheck.sh              # Health check script
```

**Accompanying Files:**

```
checksums.txt                        # SHA256 checksums
manifest.json                        # Release manifest (public)
CHANGELOG.md                         # Release notes
```

---

### 1.2 Manifest Format

**manifest.json:**

```json
{
  "version": "0.1.0",
  "release_date": "2026-09-15T20:00:00Z",
  "channel": "stable",
  "git_commit": "a1b2c3d4e5f6g7h8i9j0",
  "build_id": "20260915-200000-a1b2c3",
  "architecture": "amd64",
  "artifacts": {
    "archive": {
      "name": "aether-v0.1.0-amd64.tar.gz",
      "size": 524288000,
      "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    },
    "checksums": {
      "name": "checksums.txt",
      "sha256": "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592"
    }
  },
  "components": {
    "backend": {
      "version": "0.1.0",
      "image": "images/backend.tar.gz",
      "sha256": "..."
    },
    "frontend": {
      "version": "0.1.0",
      "image": "images/frontend.tar.gz",
      "sha256": "..."
    },
    "caddy": {
      "version": "2.7.6",
      "image": "images/caddy.tar.gz",
      "sha256": "..."
    }
  },
  "requirements": {
    "min_cpu_cores": 2,
    "min_ram_gb": 4,
    "min_disk_gb": 40
  },
  "compatibility": {
    "min_installer_version": "1.0.0",
    "os": ["ubuntu-20.04", "ubuntu-22.04", "ubuntu-24.04"],
    "architecture": ["amd64"]
  }
}
```

---

### 1.3 Checksum File Format

**checksums.txt:**

```
# Aether Cloud OS v0.1.0 Release Checksums
# Generated: 2026-09-15T20:00:00Z
# Algorithm: SHA256

e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  aether-v0.1.0-amd64.tar.gz
a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f2  images/backend.tar.gz
1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p7q8r9s0t1u2v3w4x5y6z7a8b9c0d1e2f3  images/frontend.tar.gz
9z8y7x6w5v4u3t2s1r0q9p8o7n6m5l4k3j2i1h0g9f8e7d6c5b4a3z2y1x0w9v8u7  images/caddy.tar.gz
```

---

### 1.4 Verification Process (MVP)

**Installer verification steps:**

1. **Download manifest:**

   ```bash
   curl -fsSL https://releases.aether-os.io/stable/v0.1.0/manifest.json \
     -o /tmp/aether-manifest.json
   ```

2. **Download checksums:**

   ```bash
   curl -fsSL https://releases.aether-os.io/stable/v0.1.0/checksums.txt \
     -o /tmp/aether-checksums.txt
   ```

3. **Download release archive:**

   ```bash
   curl -fsSL https://releases.aether-os.io/stable/v0.1.0/aether-v0.1.0-amd64.tar.gz \
     -o /tmp/aether-release.tar.gz
   ```

4. **Verify checksum:**

   ```bash
   cd /tmp
   sha256sum -c aether-checksums.txt --ignore-missing

   # Expected output:
   # aether-v0.1.0-amd64.tar.gz: OK
   ```

5. **If verification fails:**

   ```bash
   # Display security alert
   echo "╔════════════════════════════════════════════════════════╗"
   echo "║             SECURITY ALERT                              ║"
   echo "╚════════════════════════════════════════════════════════╝"
   echo ""
   echo "Checksum verification FAILED."
   echo ""
   echo "Expected: $(grep 'aether-v0.1.0' aether-checksums.txt | awk '{print $1}')"
   echo "Actual:   $(sha256sum aether-release.tar.gz | awk '{print $1}')"
   echo ""
   echo "This could indicate:"
   echo "  • Corrupted download"
   echo "  • Man-in-the-middle attack"
   echo "  • Compromised release server"
   echo ""
   echo "DO NOT PROCEED WITH INSTALLATION."
   echo ""
   echo "1. Verify you're downloading from: https://releases.aether-os.io"
   echo "2. Check your network connection"
   echo "3. Contact security@aether-os.io"
   echo ""
   echo "Installation ID: $INSTALL_ID"
   echo "Log file: /tmp/aether-install-*.log"

   # Delete unverified file
   rm -f /tmp/aether-release.tar.gz

   # Exit with error
   exit 1
   ```

6. **If verification succeeds:**
   ```bash
   # Proceed with extraction
   tar -xzf /tmp/aether-release.tar.gz -C /opt/aether
   ```

---

## 2. Security Analysis: Checksum-Only Model

### 2.1 What Checksums Protect Against

✅ **Checksums PROTECT against:**

1. **Corrupted Downloads**
   - Network errors causing bit flips
   - Incomplete downloads
   - Storage corruption

2. **Man-in-the-Middle Attacks (with HTTPS)**
   - Active MITM modifying download in transit
   - DNS poisoning redirecting to fake server
   - TLS + checksum provides good protection

3. **Accidental Modifications**
   - Files modified after download
   - Disk errors
   - Memory corruption

---

### 2.2 What Checksums DO NOT Protect Against

❌ **Checksums DO NOT protect against:**

1. **Compromised Release Server**

   **Scenario:**

   ```
   Attacker compromises releases.aether-os.io
   → Replaces release artifact with backdoored version
   → Regenerates checksums for malicious release
   → Updates checksums.txt on server
   → Users download and verify successfully
   → Malicious code installed ✗
   ```

   **Why checksum doesn't help:**
   - Checksum is generated from the malicious file
   - Checksum verification passes
   - User has no way to know file is malicious

2. **Compromised Build Pipeline**

   **Scenario:**

   ```
   Attacker compromises CI/CD pipeline
   → Injects malicious code during build
   → Build produces backdoored release
   → Checksums generated from backdoored release
   → Published to release server
   → Checksums match perfectly ✗
   ```

3. **Insider Threat**

   **Scenario:**

   ```
   Malicious insider with release access
   → Builds malicious release
   → Generates valid checksums
   → Publishes to official server
   → All verification passes ✗
   ```

4. **Supply Chain Attack**

   **Scenario:**

   ```
   Attacker compromises upstream dependency
   → Dependency included in build
   → Release contains malicious dependency
   → Checksums valid for compromised release ✗
   ```

---

### 2.3 Trust Model with Checksums Only

**Current trust model:**

```
User trusts:
  ↓
HTTPS connection to releases.aether-os.io
  ↓
Release server not compromised
  ↓
Build pipeline not compromised
  ↓
Developers not malicious
  ↓
Dependencies not compromised
```

**Single point of failure:** If release server is compromised, checksums provide no protection.

---

## 3. Enhanced Security: GPG Signatures (Future)

### 3.1 Why GPG Signatures Are Needed

**GPG signatures provide:**

1. **Authenticity** - Proves release came from trusted source
2. **Integrity** - Proves release hasn't been modified
3. **Non-repudiation** - Signer cannot deny signing
4. **Offline Verification** - Can verify without contacting server

**Key property:**

> Even if release server is compromised, attacker cannot forge GPG signature without private key.

---

### 3.2 GPG Signature Model (v1.1 Target)

**Release structure with signatures:**

```
aether-v0.1.0-amd64.tar.gz
aether-v0.1.0-amd64.tar.gz.sig       # GPG signature
checksums.txt
checksums.txt.sig                     # GPG signature
manifest.json
manifest.json.sig                     # GPG signature
```

**GPG signature verification:**

```bash
# Import Aether public key (one time)
gpg --keyserver keys.openpgp.org --recv-keys AETHER_KEY_ID

# Verify signature
gpg --verify aether-v0.1.0-amd64.tar.gz.sig aether-v0.1.0-amd64.tar.gz

# Expected output:
# gpg: Signature made Sat 15 Sep 2026 08:00:00 PM UTC
# gpg:                using RSA key AETHER_KEY_ID
# gpg: Good signature from "Aether Release Team <releases@aether-os.io>"
```

---

### 3.3 Trust Model with GPG Signatures

**Enhanced trust model:**

```
User trusts:
  ↓
Aether GPG public key (verified out-of-band)
  ↓
Signature is valid and from trusted key
  ↓
Release is authentic
```

**Benefits:**

- Release server compromise doesn't bypass signature
- Build pipeline compromise detected (unsigned or wrong signature)
- Insider must have private key (can be protected with HSM)
- Supply chain attack detected if signing process validates

---

### 3.4 Key Management

**GPG key requirements:**

**Primary Key:**

- Algorithm: RSA 4096 or EdDSA (Ed25519)
- Usage: Certification only
- Storage: Offline, air-gapped
- Backup: Encrypted, multiple locations

**Signing Subkey:**

- Algorithm: RSA 4096 or EdDSA (Ed25519)
- Usage: Signing only
- Storage: HSM (Hardware Security Module)
- Rotation: Annually or on compromise

**Key Publication:**

- Public key server: keys.openpgp.org
- Website: https://aether-os.io/pgp-key.asc
- Fingerprint published on:
  - Website
  - Documentation
  - GitHub README
  - Twitter/social media

**Key Fingerprint Display:**

```
Primary Key Fingerprint: XXXX XXXX XXXX XXXX XXXX  XXXX XXXX XXXX XXXX XXXX
```

---

### 3.5 Signing Process (Future)

**Automated signing in CI/CD:**

```yaml
# .github/workflows/release.yml
- name: Sign release
  run: |
    # HSM-backed signing
    gpg --sign --detach-sig --armor \
      --local-user releases@aether-os.io \
      aether-v${VERSION}-amd64.tar.gz

    gpg --sign --detach-sig --armor \
      --local-user releases@aether-os.io \
      checksums.txt
```

**Manual verification by release manager:**

```bash
# Verify signature before publishing
gpg --verify aether-v0.1.0-amd64.tar.gz.sig

# If valid, publish to CDN
aws s3 sync ./release/ s3://releases.aether-os.io/stable/v0.1.0/
```

---

## 4. Installer Integration

### 4.1 MVP (Checksum Only)

**Current installer behavior:**

```bash
verify_release() {
  local file=$1
  local checksums=$2

  info "Verifying release integrity..."

  cd /tmp
  if sha256sum -c "$checksums" --ignore-missing 2>&1 | grep -q "OK"; then
    success "Checksum verification passed"
    log_security_event "CHECKSUM_VERIFIED" "$file"
    return 0
  else
    error "Checksum verification FAILED"
    log_security_event "CHECKSUM_FAILED" "$file"

    # Display security alert
    display_security_alert

    # Delete unverified file
    rm -f "$file"

    return 1
  fi
}
```

---

### 4.2 Future (with GPG Signatures)

**Enhanced installer behavior:**

```bash
verify_release_with_signature() {
  local file=$1
  local signature=$2
  local checksums=$3
  local checksums_sig=$4

  info "Verifying release signature..."

  # First verify checksums file signature
  if ! gpg --verify "$checksums_sig" "$checksums" 2>/dev/null; then
    error "Checksums signature verification FAILED"
    log_security_event "SIGNATURE_FAILED" "$checksums"
    display_security_alert_signature
    rm -f "$file" "$checksums"
    return 1
  fi

  success "Checksums signature valid"

  # Then verify release archive signature
  if ! gpg --verify "$signature" "$file" 2>/dev/null; then
    error "Release signature verification FAILED"
    log_security_event "SIGNATURE_FAILED" "$file"
    display_security_alert_signature
    rm -f "$file"
    return 1
  fi

  success "Release signature valid"

  # Finally verify checksums match
  if sha256sum -c "$checksums" --ignore-missing 2>&1 | grep -q "OK"; then
    success "Checksum verification passed"
    log_security_event "RELEASE_VERIFIED" "$file"
    return 0
  else
    error "Checksum mismatch despite valid signature"
    error "This should never happen - possible bug or attack"
    rm -f "$file"
    return 1
  fi
}
```

---

## 5. Release Channels

### 5.1 Channel Definitions

**stable:**

- Production releases
- Fully tested
- Security reviewed
- GPG signed (future)
- Recommended for production

**beta:**

- Pre-release testing
- Feature complete
- Not fully tested
- GPG signed (future)
- For early adopters

**development:**

- Latest builds
- May be unstable
- Not fully tested
- Checksum only (no signature)
- Explicit opt-in required
- NOT for production

---

### 5.2 Channel Selection

**Default behavior:**

```bash
# Installer uses stable by default
CHANNEL=${AETHER_CHANNEL:-stable}
```

**Explicit development channel:**

```bash
# User must explicitly request development
curl -fsSL https://aether-os.io/install.sh | bash -s -- --channel development

# Installer warns:
warning "Using development channel - NOT FOR PRODUCTION"
warning "Development builds may be unstable"
warning "No security guarantees for development releases"

read -p "Are you sure? [y/N] " -n 1 -r
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  exit 1
fi
```

---

## 6. Release Hosting

### 6.1 Release Server Requirements

**Hosting options:**

**Option 1: GitHub Releases**

- ✅ Free
- ✅ Reliable CDN
- ✅ Built-in checksums
- ✅ Release notes
- ✅ Version tracking
- ⚠️ Requires GitHub account compromise to attack

**Option 2: Cloudflare R2 + CDN**

- ✅ Fast global CDN
- ✅ DDoS protection
- ✅ Custom domain
- ✅ Access logs
- ⚠️ Requires Cloudflare compromise to attack

**Option 3: Self-hosted CDN**

- ✅ Full control
- ✅ Custom infrastructure
- ⚠️ More maintenance
- ⚠️ More attack surface

**Recommendation:** GitHub Releases for MVP, migrate to Cloudflare R2 for production

---

### 6.2 Release URL Structure

**Stable releases:**

```
https://releases.aether-os.io/stable/v0.1.0/aether-v0.1.0-amd64.tar.gz
https://releases.aether-os.io/stable/v0.1.0/checksums.txt
https://releases.aether-os.io/stable/v0.1.0/manifest.json
https://releases.aether-os.io/stable/latest -> v0.1.0/
```

**Beta releases:**

```
https://releases.aether-os.io/beta/v0.2.0-beta.1/...
https://releases.aether-os.io/beta/latest -> v0.2.0-beta.1/
```

**Development releases:**

```
https://releases.aether-os.io/development/v0.3.0-dev.20260915/...
https://releases.aether-os.io/development/latest -> v0.3.0-dev.20260915/
```

---

## 7. Threat Scenarios

### 7.1 Scenario: Compromised Release Server (MVP)

**Attack:**

1. Attacker gains access to releases.aether-os.io
2. Replaces release with backdoored version
3. Regenerates checksums for backdoored release
4. Users download and install malicious version

**Detection:** None with checksum-only model

**Impact:** Critical - widespread compromise

**Mitigation:**

- Server hardening
- Access controls
- Monitoring and alerting
- Regular audits
- **Future: GPG signatures prevent this**

---

### 7.2 Scenario: Man-in-the-Middle (Current)

**Attack:**

1. Attacker intercepts HTTPS connection
2. Serves fake release

**Detection:** TLS certificate validation fails

**Impact:** Low - HTTPS prevents MITM

**Mitigation:**

- HTTPS enforced
- Checksum verification
- Certificate pinning (future)

---

### 7.3 Scenario: DNS Hijacking (Current)

**Attack:**

1. Attacker compromises DNS
2. Redirects aether-os.io to fake server
3. Serves malicious release

**Detection:**

- TLS certificate mismatch (if attacker doesn't have valid cert)
- Checksum mismatch (if attacker doesn't know checksums)

**Impact:** Medium - requires DNS compromise + valid TLS cert

**Mitigation:**

- DNSSEC (future)
- Certificate pinning (future)
- GPG signatures (future)

---

### 7.4 Scenario: Compromised Build Pipeline (MVP)

**Attack:**

1. Attacker compromises CI/CD
2. Injects malicious code during build
3. Build produces backdoored release with valid checksums

**Detection:** None with checksum-only model

**Impact:** Critical - supply chain attack

**Mitigation:**

- Build pipeline security
- Code review
- Automated testing
- **Future: Multi-party signing**

---

## 8. Roadmap

### Phase 1 (MVP - Current)

- ✅ SHA256 checksums
- ✅ HTTPS downloads
- ✅ Manifest with metadata
- ✅ Checksum verification in installer

### Phase 2 (v1.1 - Target: Q4 2026)

- ⏳ GPG key generation
- ⏳ GPG signing in CI/CD
- ⏳ Public key publication
- ⏳ Signature verification in installer
- ⏳ Key rotation procedures

### Phase 3 (v1.2 - Target: Q1 2027)

- ⏳ Reproducible builds
- ⏳ Build attestation
- ⏳ SBOM (Software Bill of Materials)
- ⏳ Supply chain provenance

### Phase 4 (v2.0 - Target: Q2 2027)

- ⏳ Multi-party signing (2-of-3 required)
- ⏳ Hardware security module integration
- ⏳ Certificate transparency logs
- ⏳ Binary transparency

---

## 9. Disclosure

### 9.1 Current Limitations (MVP)

**⚠️ IMPORTANT DISCLOSURE:**

> The Aether installer (v1.0) uses SHA256 checksum verification to ensure download integrity. This
> protects against corrupted downloads and man-in-the-middle attacks when combined with HTTPS.
>
> **However, checksum verification alone does NOT protect against:**
>
> - Compromised release server
> - Compromised build pipeline
> - Insider threats
>
> **If the release server or build infrastructure is compromised, an attacker could serve malicious
> releases with valid checksums.**
>
> GPG signature verification (planned for v1.1) will address this limitation by cryptographically
> proving releases are from the Aether team.
>
> For production deployments requiring maximum security, wait for v1.1 with GPG signatures or
> implement additional verification steps.

---

### 9.2 Recommended Additional Verification

**For high-security deployments:**

1. **Verify installer hash out-of-band:**
   - Check installer SHA256 on multiple sources
   - Compare with published hash on GitHub, Twitter, etc.

2. **Use specific version, not "latest":**

   ```bash
   AETHER_VERSION=v0.1.0 curl ... | bash
   ```

3. **Review release before deploying:**
   - Check release notes
   - Review code changes
   - Test in staging environment

4. **Monitor for security advisories:**
   - Subscribe to security@aether-os.io
   - Follow @AetherOS on Twitter
   - Check https://aether-os.io/security/advisories

---

## 10. Security Contact

**Report security issues:**

- Email: security@aether-os.io
- PGP Key: https://aether-os.io/pgp-key.asc (when available)
- Response time: 48 hours

**Bug bounty:** https://aether-os.io/security/bounty (future)

---

**Document Status:** Draft - Security Specification  
**Classification:** Public  
**Last Updated:** 2026-09-15 20:30 UTC  
**Next Review:** Q4 2026 (before v1.1 release)

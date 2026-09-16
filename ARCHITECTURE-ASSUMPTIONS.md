# ARCHITECTURE ASSUMPTIONS

**Project:** Aether Cloud OS  
**Purpose:** Document all assumptions made during architecture and implementation  
**Last Updated:** 2026-09-15 19:00

---

## 📋 Assumption Status Legend

- ✅ **Validated** - Assumption confirmed through testing or research
- ⏳ **Active** - Currently assumed, not yet validated
- ⚠️ **Risk** - Assumption with known risks
- ❌ **Invalidated** - Assumption proven wrong, needs adjustment
- 🔄 **Needs Validation** - Should be tested soon

---

## 🎯 CRITICAL ASSUMPTIONS (High Impact)

### ASSUME-001: Target Deployment Platform

**Status:** ⏳ Active  
**Category:** Infrastructure  
**Risk Level:** Low

**Assumption:** Primary deployment target is Ubuntu 22.04 LTS or 24.04 LTS on VPS.

**Rationale:**

- Most popular VPS OS
- Long-term support (LTS)
- Well-documented
- Good package availability

**Impact if Wrong:**

- Installation scripts may not work
- Package dependencies unavailable
- systemd assumptions incorrect

**Validation Plan:**

- Test on Ubuntu 22.04 (Phase 2)
- Test on Ubuntu 24.04 (Phase 2)
- Document other distros as "experimental"

**Alternative Considered:**

- Debian (very similar to Ubuntu)
- CentOS/RHEL (different package manager)
- Fedora (cutting edge, less stable)

**Related Decisions:** DEC-005

---

### ASSUME-002: Minimum VPS Resources

**Status:** ⏳ Active  
**Category:** Performance  
**Risk Level:** Medium

**Assumption:** Target VPS has minimum:

- 2 vCPU cores
- 4 GB RAM
- 20 GB SSD storage
- 100 Mbps network

**Rationale:**

- Common VPS tier ($10-20/month)
- Enough for PostgreSQL + Redis + Backend + Agent
- Supports 5-10 concurrent users

**Impact if Wrong:**

- Performance degradation
- Out of memory errors
- Database connection issues
- Slow file operations

**Validation Plan:**

- Load testing on 2 vCPU / 4 GB VPS (Phase 5)
- Test with 10 concurrent users (Phase 6)
- Memory profiling (Phase 10)

**Risk Mitigation:**

- Document minimum requirements clearly
- Provide resource monitoring
- Graceful degradation under load
- Resource limits per user/app

**Related Questions:** Q-002 (resource constraints)

---

### ASSUME-003: Internet Connectivity

**Status:** ⏳ Active  
**Category:** Network  
**Risk Level:** Medium

**Assumption:** VPS has stable internet connection with:

- Latency: < 100ms (typical)
- Packet loss: < 1%
- Uptime: 99%+

**Rationale:**

- Standard VPS network quality
- Required for WebSocket reliability
- Real-time terminal responsiveness

**Impact if Wrong:**

- Frequent disconnections
- Poor terminal experience
- File sync issues
- User frustration

**Validation Plan:**

- Test with simulated network issues (Phase 4)
- Test reconnection logic (Phase 4)
- Test on real VPS with varying quality (Phase 5)

**Risk Mitigation:**

- WebSocket auto-reconnect
- Session persistence
- Buffering strategies
- Clear connection status to user

**Related Questions:** Q-014 (WebSocket ping interval)

---

### ASSUME-004: User Technical Skill

**Status:** ⏳ Active  
**Category:** User Experience  
**Risk Level:** Medium

**Assumption:** Target users are comfortable with:

- Basic Linux commands
- SSH and terminal usage
- VPS management concepts
- Web browser usage

**Rationale:**

- Aether is for developers/sysadmins
- Not consumer product
- Replacing SSH workflow

**Impact if Wrong:**

- Need more documentation
- Need simpler UI
- Need guided setup
- Support burden higher

**Validation Plan:**

- User testing with target audience (Phase 6)
- Documentation feedback (Phase 7)
- Usability testing (Phase 10)

**Risk Mitigation:**

- Comprehensive documentation
- Setup wizard
- Contextual help
- Video tutorials

---

### ASSUME-005: Single Host per User (MVP)

**Status:** ⏳ Active  
**Category:** Features  
**Risk Level:** Low

**Assumption:** MVP users primarily manage one host at a time.

**Rationale:**

- Simpler UI/UX
- Most users have 1-3 VPS
- Multi-host view can be added later

**Impact if Wrong:**

- Users want to switch between hosts frequently
- Need dashboard view
- Need bulk operations

**Validation Plan:**

- User feedback after MVP (Phase 6)
- Usage analytics (Phase 7+)

**Risk Mitigation:**

- Design database schema for multi-host
- UI allows host switching
- Can add host dashboard later

**Related Questions:** Q-001 (multi-tenancy)

---

## 🔧 TECHNICAL ASSUMPTIONS

### ASSUME-006: node-pty Reliability

**Status:** ⏳ Active  
**Category:** Technology  
**Risk Level:** Low

**Assumption:** node-pty library is stable and production-ready for PTY terminal.

**Rationale:**

- Used by VS Code (millions of users)
- Actively maintained
- Mature (v1.0+)
- Good Linux support

**Impact if Wrong:**

- Terminal crashes
- Memory leaks
- Platform-specific bugs
- Need alternative PTY library

**Validation Plan:**

- Stress testing (Phase 4)
- Long-running session tests (Phase 5)
- Memory leak detection (Phase 10)

**Risk Mitigation:**

- Thorough testing
- Monitoring and alerting
- Session timeouts
- Resource limits

**Fallback:** Switch to alternative PTY library if issues found

---

### ASSUME-007: WebSocket Scaling

**Status:** ⏳ Active  
**Category:** Performance  
**Risk Level:** Medium

**Assumption:** Single Node.js backend can handle 100+ WebSocket connections.

**Rationale:**

- Node.js is good at I/O
- WebSocket connections are lightweight
- Each terminal = 1 connection

**Impact if Wrong:**

- Connection limits reached
- Need horizontal scaling
- Need WebSocket clustering

**Validation Plan:**

- Load testing with 100 connections (Phase 5)
- Concurrent terminal testing (Phase 6)
- Resource monitoring (Phase 10)

**Risk Mitigation:**

- Connection limits
- Resource monitoring
- Horizontal scaling path documented
- Sticky sessions for scaling

**Scaling Path:**

- Phase 1-9: Single backend
- Phase 10+: Multiple backends with load balancer

---

### ASSUME-008: PostgreSQL Performance

**Status:** ⏳ Active  
**Category:** Database  
**Risk Level:** Low

**Assumption:** PostgreSQL on 4GB VPS can handle MVP load:

- 50 concurrent users
- 1000 req/min
- 10GB database size

**Rationale:**

- PostgreSQL is lightweight
- Most data in Redis cache
- Not high-frequency writes

**Impact if Wrong:**

- Slow queries
- Connection pool exhaustion
- Need query optimization
- Need database scaling

**Validation Plan:**

- Load testing (Phase 5)
- Query performance monitoring (Phase 6)
- Database profiling (Phase 10)

**Risk Mitigation:**

- Database indexes
- Query optimization
- Connection pooling
- Redis caching
- Read replicas (future)

**Related Questions:** Q-015 (connection pooling)

---

### ASSUME-009: Browser Compatibility

**Status:** ⏳ Active  
**Category:** Frontend  
**Risk Level:** Low

**Assumption:** Target browsers support modern features:

- Chrome/Edge 90+
- Firefox 88+
- Safari 14+
- WebSocket
- IndexedDB
- Service Workers

**Rationale:**

- Focus on modern browsers
- No IE11 support needed
- Developer audience has updated browsers

**Impact if Wrong:**

- Some users cannot access
- Need polyfills
- Need fallbacks

**Validation Plan:**

- Browser testing matrix (Phase 3)
- User agent analytics (Phase 7+)

**Risk Mitigation:**

- Browser detection
- Feature detection
- Clear requirements documented
- Graceful degradation

---

### ASSUME-010: File System Access Pattern

**Status:** 🔄 Needs Validation  
**Category:** Performance  
**Risk Level:** Medium

**Assumption:** Most file operations are:

- Small files (< 1 MB)
- Text files (code, configs)
- Infrequent large uploads
- Not video/media heavy

**Rationale:**

- Developer/sysadmin use case
- VPS typically for apps/services
- Not media server

**Impact if Wrong:**

- File transfer bottleneck
- Memory issues with large files
- Need streaming upload/download
- Need progress indicators

**Validation Plan:**

- User testing (Phase 5)
- Usage analytics (Phase 7+)
- Performance testing with large files (Phase 6)

**Risk Mitigation:**

- File size limits
- Streaming for large files
- Progress indicators
- Chunked uploads

**Related Questions:** Q-008 (upload size limits)

---

## 🔒 SECURITY ASSUMPTIONS

### ASSUME-011: Non-Root Agent Default

**Status:** ✅ Validated  
**Category:** Security  
**Risk Level:** Low

**Assumption:** Host Agent can run as non-root user for most operations.

**Rationale:**

- Better security posture
- Principle of least privilege
- Most file/terminal operations don't need root

**Impact if Wrong:**

- Some operations fail
- Users must run as root (bad)
- Need sudo prompts frequently

**Validation:**

- Researched node-pty requirements (✓)
- Tested PTY as non-root (pending)
- Tested filesystem access (pending)

**Validation Plan:**

- Prototype testing (Phase 1 prep)
- Integration testing (Phase 2)

**Risk Mitigation:**

- Clear documentation on permissions needed
- Optional elevation for specific operations
- Audit logging for privileged ops

---

### ASSUME-012: Path Traversal Risks

**Status:** ⚠️ Risk  
**Category:** Security  
**Risk Level:** High

**Assumption:** Path validation and canonicalization can prevent path traversal.

**Rationale:**

- Standard security practice
- Node.js `path.resolve()` available
- Allowlist approach

**Impact if Wrong:**

- Security vulnerability
- Unauthorized file access
- Data breach

**Validation Plan:**

- Security testing (Phase 1 prep - prototype)
- Fuzzing (Phase 4)
- Security audit (Phase 10)

**Risk Mitigation:**

- Multiple validation layers
- Allowlist, not blocklist
- Forbidden path patterns
- Audit logging
- Regular security reviews

**CRITICAL:** Must validate with prototype before Phase 1

**Related:** Security documentation in Phase 0

---

### ASSUME-013: API Key Security

**Status:** ⏳ Active  
**Category:** Security  
**Risk Level:** Medium

**Assumption:** API keys can be stored securely on host:

- Linux: Secret Service API / keyring
- Windows: Credential Manager
- macOS: Keychain

**Rationale:**

- OS-provided secure storage
- Better than file system
- Standard practice

**Impact if Wrong:**

- Keys stored in plaintext
- Security risk
- Need alternative storage

**Validation Plan:**

- Test on each platform (Phase 2)
- Fallback to encrypted file if needed

**Risk Mitigation:**

- Encrypted file as fallback
- File permissions (0600)
- Documentation on securing keys

---

## 📦 DEPLOYMENT ASSUMPTIONS

### ASSUME-014: systemd Availability

**Status:** ⏳ Active  
**Category:** Deployment  
**Risk Level:** Low

**Assumption:** Ubuntu LTS VPS has systemd for service management.

**Rationale:**

- systemd is standard on Ubuntu 16.04+
- Replaced upstart
- Good service management features

**Impact if Wrong:**

- Service setup fails
- Need alternative (upstart, init.d)
- Manual process management

**Validation Plan:**

- Test on Ubuntu 22.04 (Phase 2)
- Test on Ubuntu 24.04 (Phase 2)

**Risk Mitigation:**

- Check for systemd in installer
- Fallback to manual instructions
- Support multiple init systems (future)

**Related:** Installation scripts

---

### ASSUME-015: HTTPS/TLS Availability

**Status:** ⏳ Active  
**Category:** Security  
**Risk Level:** Medium

**Assumption:** Users can obtain HTTPS certificate (Let's Encrypt) for their VPS.

**Rationale:**

- Let's Encrypt is free
- certbot is easy to use
- HTTPS required for security

**Impact if Wrong:**

- Users cannot get certificate
- No domain name (only IP)
- Self-signed certificate warnings

**Validation Plan:**

- Test Let's Encrypt setup (Phase 2)
- Document manual setup (Phase 2)

**Risk Mitigation:**

- Support self-signed certificates (dev)
- Document DNS requirements
- Provide certificate troubleshooting
- Support HTTP for local development

---

### ASSUME-016: Port Availability

**Status:** ⏳ Active  
**Category:** Network  
**Risk Level:** Low

**Assumption:** Ports 80, 443, 3000, 5432, 6379 are available on VPS.

**Rationale:**

- Standard ports
- Typical VPS has them open
- Can be configured

**Impact if Wrong:**

- Port conflicts
- Need port remapping
- Firewall issues

**Validation Plan:**

- Port check in installer (Phase 2)
- Configurable ports (Phase 2)

**Risk Mitigation:**

- Check port availability first
- Allow custom ports
- Documentation for firewall setup

---

## 📊 PERFORMANCE ASSUMPTIONS

### ASSUME-017: Terminal Latency

**Status:** 🔄 Needs Validation  
**Category:** Performance  
**Risk Level:** Medium

**Assumption:** Terminal feels responsive with:

- Keystroke latency: < 50ms
- Output latency: < 100ms
- Over internet connection

**Rationale:**

- WebSocket is low-latency
- PTY is fast
- No heavy processing

**Impact if Wrong:**

- Sluggish terminal experience
- User frustration
- Not competitive with SSH

**Validation Plan:**

- Latency testing (Phase 4)
- Real-world testing (Phase 5)
- User feedback (Phase 6)

**Risk Mitigation:**

- Optimize WebSocket
- Reduce overhead
- Client-side prediction (future)
- Clear latency indicators

---

### ASSUME-018: File Upload Speed

**Status:** 🔄 Needs Validation  
**Category:** Performance  
**Risk Level:** Low

**Assumption:** File uploads are acceptable:

- 10 MB file: < 10 seconds
- 100 MB file: < 2 minutes
- On typical broadband (10 Mbps upload)

**Rationale:**

- HTTP upload is standard
- No compression overhead
- Direct to server

**Impact if Wrong:**

- Uploads too slow
- Timeouts
- User frustration

**Validation Plan:**

- Upload testing various file sizes (Phase 4)
- Network throttling tests (Phase 5)

**Risk Mitigation:**

- Progress indicators
- Resumable uploads (future)
- Chunked uploads
- Compression (optional)

---

## 🔄 ASSUMPTION VALIDATION SCHEDULE

| Assumption | Validate By | Method               | Priority |
| ---------- | ----------- | -------------------- | -------- |
| ASSUME-002 | Phase 5     | Load testing         | High     |
| ASSUME-003 | Phase 4     | Network simulation   | High     |
| ASSUME-006 | Phase 4     | Stress testing       | High     |
| ASSUME-007 | Phase 5     | Load testing         | High     |
| ASSUME-010 | Phase 5     | User testing         | Medium   |
| ASSUME-012 | Phase 1     | Prototype (CRITICAL) | Critical |
| ASSUME-017 | Phase 4     | Latency testing      | High     |
| ASSUME-018 | Phase 4     | Upload testing       | Medium   |

---

## 📝 HOW TO MANAGE ASSUMPTIONS

### Adding New Assumptions

1. Assign unique ID (ASSUME-XXX)
2. Set status and risk level
3. Document rationale
4. Define validation plan
5. Identify mitigation strategies

### Validating Assumptions

1. Execute validation plan
2. Document results
3. Update status (Validated or Invalidated)
4. If invalidated: create action plan

### Reviewing Assumptions

- **Weekly:** Review high-risk assumptions
- **Phase End:** Review all active assumptions
- **Monthly:** Update validation progress

---

**Document Owner:** Architecture Team  
**Last Review:** 2026-09-15 19:00  
**Next Review:** 2026-09-22 09:00

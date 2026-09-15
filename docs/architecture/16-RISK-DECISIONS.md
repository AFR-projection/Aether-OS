# AETHER CLOUD OS - RISK REGISTER & DECISIONS

**Part of:** Comprehensive Architecture Document  
**Version:** 1.0.0  
**Date:** 2026-09-15

---

## 16. RISK REGISTER

### 16.1 Critical Risks

#### RISK-001: PTY Terminal Security
**Category:** Security  
**Severity:** Critical  
**Probability:** High

**Description:**
Terminal with direct shell access is the highest security risk. Improper implementation could allow:
- Command injection
- Privilege escalation
- Access to forbidden paths
- Exposure of secrets in environment variables

**Mitigation:**
1. Agent runs as non-root user by default
2. Implement strict permission checks before PTY creation
3. Environment variable filtering (strip sensitive vars)
4. Working directory restrictions
5. Command audit logging (privacy-aware)
6. Session timeout and idle disconnect
7. Rate limiting on terminal creation
8. Shell escape sequence filtering if needed

**Owner:** Security Team  
**Status:** Mitigated (design phase)

---

#### RISK-002: Path Traversal Attacks
**Category:** Security  
**Severity:** Critical  
**Probability:** Medium

**Description:**
File operations could allow access to forbidden files via path traversal (e.g., `../../etc/shadow`).

**Mitigation:**
1. Path canonicalization on every request
2. Allowlist of accessible directories
3. Forbidden path patterns (e.g., `/etc/shadow`, private keys)
4. Symlink policy enforcement
5. Input validation with schema
6. Multiple validation layers (frontend, backend, agent)

**Owner:** Security Team  
**Status:** Mitigated (design phase)

---

#### RISK-003: Host Agent Compromise
**Category:** Security  
**Severity:** Critical  
**Probability:** Low

**Description:**
If Host Agent is compromised, attacker has access to host OS.

**Mitigation:**
1. Agent API key stored securely (keyring)
2. TLS for all communications
3. Regular security updates
4. Minimal permissions (non-root)
5. Code signing (future)
6. Intrusion detection (future)
7. Agent process hardening (systemd restrictions)

**Owner:** Security Team  
**Status:** Accepted with mitigations

---

#### RISK-004: WebSocket Connection Stability
**Category:** Reliability  
**Severity:** High  
**Probability:** Medium

**Description:**
WebSocket disconnections could disrupt terminal sessions and real-time features.

**Mitigation:**
1. Automatic reconnection with exponential backoff
2. PTY session persistence on agent
3. Session resumption after reconnect
4. Heartbeat/ping-pong mechanism
5. Connection state visible to user
6. Graceful degradation (offline mode)

**Owner:** Backend Team  
**Status:** Mitigated (design phase)

---

#### RISK-005: Resource Exhaustion on VPS
**Category:** Performance  
**Severity:** High  
**Probability:** Medium

**Description:**
Multiple users or apps could exhaust VPS resources (CPU, RAM, disk).

**Mitigation:**
1. Resource limits per app
2. Resource limits per user
3. Process monitoring and alerts
4. Automatic throttling
5. Resource quotas enforced
6. Early warning thresholds
7. Graceful degradation under load

**Owner:** Backend Team  
**Status:** Mitigated (design phase)

---

### 16.2 High Risks

#### RISK-006: Database Migration Failures
**Category:** Operations  
**Severity:** High  
**Probability:** Low

**Description:**
Failed database migration could corrupt data or prevent application startup.

**Mitigation:**
1. Automated database backups before migrations
2. Test migrations on staging
3. Migration rollback procedures
4. Forward-only migrations
5. Schema validation
6. Dry-run capability

**Owner:** DevOps Team  
**Status:** Mitigated (design phase)

---

#### RISK-007: Third-Party App Security
**Category:** Security  
**Severity:** High  
**Probability:** Medium

**Description:**
Malicious third-party apps could abuse permissions or exploit vulnerabilities.

**Mitigation:**
1. App sandboxing with limited API access
2. Permission review before installation
3. App signing and verification (future)
4. App store moderation
5. User reviews and ratings
6. Revocable permissions
7. Resource limits per app

**Owner:** App Runtime Team  
**Status:** Mitigated (design phase)

---

#### RISK-008: AI Agent Abuse
**Category:** Security  
**Severity:** High  
**Probability:** Medium

**Description:**
AI agent could be tricked into executing destructive operations or exposing sensitive data.

**Mitigation:**
1. Tool permission system
2. Approval required for sensitive operations
3. No direct root access
4. Audit logging of all AI actions
5. Rate limiting
6. Context filtering (no secrets in prompts)
7. User can revoke AI access anytime

**Owner:** AI Team  
**Status:** Mitigated (design phase)

---

### 16.3 Medium Risks

#### RISK-009: Browser Compatibility
**Category:** Compatibility  
**Severity:** Medium  
**Probability:** Medium

**Description:**
Desktop may not work correctly on older browsers.

**Mitigation:**
1. Target modern browsers (Chrome 90+, Firefox 88+, Safari 14+)
2. Polyfills for missing features
3. Browser detection with warning
4. Progressive enhancement
5. Graceful degradation

**Owner:** Frontend Team  
**Status:** Accepted

---

#### RISK-010: Cloud Storage Costs
**Category:** Financial  
**Severity:** Medium  
**Probability:** High

**Description:**
S3 storage costs could become prohibitive with many users.

**Mitigation:**
1. Storage quotas per user
2. Lifecycle policies (auto-delete old files)
3. Compression for text files
4. Deduplication (future)
5. Cost monitoring and alerts
6. Tiered storage (hot/cold)

**Owner:** Product Team  
**Status:** Accepted with monitoring

---

#### RISK-011: Multi-device Sync Conflicts
**Category:** Data Integrity  
**Severity:** Medium  
**Probability:** High

**Description:**
Same file modified on multiple devices could cause data loss if conflicts not handled properly.

**Mitigation:**
1. Conflict detection based on timestamps and checksums
2. Conflict resolution UI
3. Keep both versions option
4. Sync status visible to user
5. File versioning (future)
6. Operational transformation (future, complex)

**Owner:** Sync Team  
**Status:** Mitigated (design phase)

---

### 16.4 Low Risks

#### RISK-012: Agent Update Failures
**Category:** Operations  
**Severity:** Medium  
**Probability:** Low

**Description:**
Failed agent update could leave agent in broken state.

**Mitigation:**
1. Atomic update process
2. Automatic rollback on failure
3. Version compatibility checks
4. Update verification
5. Backup of current version before update

**Owner:** Agent Team  
**Status:** Mitigated (design phase)

---

#### RISK-013: Email Delivery Failures
**Category:** Operations  
**Severity:** Low  
**Probability:** Medium

**Description:**
Verification emails or notifications might not be delivered.

**Mitigation:**
1. Retry logic for failed sends
2. Multiple SMTP providers (fallback)
3. SPF/DKIM/DMARC configuration
4. Email delivery monitoring
5. Alternative verification methods (SMS, future)

**Owner:** Backend Team  
**Status:** Accepted

---

## 17. DECISION LOG

### Architecture Decision Records (ADR)

#### ADR-001: Use Node.js for Backend and Initial Agent
**Date:** 2026-09-15  
**Status:** Accepted  
**Context:**
Need to choose backend runtime and Host Agent runtime.

**Decision:**
Use Node.js + TypeScript for both backend and initial Host Agent implementation.

**Rationale:**
1. Single language across stack (TypeScript)
2. Type sharing between frontend and backend
3. node-pty is most mature PTY library
4. Faster development velocity for MVP
5. Large ecosystem

**Consequences:**
- Higher memory usage than Go
- Plan to rewrite agent in Go after protocol stabilizes
- Good enough for MVP, optimize later

**Alternatives Considered:**
- Go: Better performance but slower development, less mature PTY
- Python: Not suitable for real-time WebSocket performance

---

#### ADR-002: Use PostgreSQL as Primary Database
**Date:** 2026-09-15  
**Status:** Accepted  
**Context:**
Need to choose primary database for structured data.

**Decision:**
PostgreSQL 16+ with Prisma ORM.

**Rationale:**
1. ACID compliance for critical data
2. JSON support for flexible schemas (capabilities)
3. Row-level security
4. Excellent backup tools
5. Production-proven
6. Free and open source

**Consequences:**
- Slightly higher resource usage than SQLite
- More complex administration
- Requires separate service (not embedded)

**Alternatives Considered:**
- SQLite: Not suitable for concurrent multi-user access
- MySQL: PostgreSQL has better JSON support and features
- MongoDB: Overkill, relational data fits better

---

#### ADR-003: Use React for Frontend
**Date:** 2026-09-15  
**Status:** Accepted  
**Context:**
Need to choose frontend framework for complex desktop UI.

**Decision:**
React 18+ with TypeScript, Vite, Tailwind CSS.

**Rationale:**
1. Mature ecosystem with many UI libraries
2. Excellent TypeScript support
3. Virtual DOM suitable for complex UI
4. Large community
5. Component reusability
6. Available UI component libraries (Radix, Headless UI)

**Consequences:**
- Larger bundle size than Svelte
- Requires build tooling
- Learning curve for state management

**Alternatives Considered:**
- Svelte: Smaller but less mature ecosystem
- Vue: Less TypeScript-focused
- Vanilla JS: Too complex for this scale

---

#### ADR-004: Simple iframe Browser for MVP, Remote Browser Later
**Date:** 2026-09-15  
**Status:** Accepted  
**Context:**
Need to decide browser implementation approach.

**Decision:**
MVP: Simple iframe wrapper for external sites
Future: Remote browser with headless Chromium

**Rationale:**
1. iframe is simple and works today
2. Remote browser is complex and resource-intensive
3. Remote browser should be Phase 7+ enhancement
4. Honest about limitations (same-origin restrictions)

**Consequences:**
- Limited browser capabilities in MVP
- Some sites won't work in iframe (X-Frame-Options)
- Full browser requires significant additional work

**Alternatives Considered:**
- Remote browser in MVP: Too complex, delays MVP
- No browser: Users need web access
- Browser extension: Different security model

---

#### ADR-005: WebSocket for Realtime, REST for Request/Response
**Date:** 2026-09-15  
**Status:** Accepted  
**Context:**
Need to choose communication protocols.

**Decision:**
- REST API for request/response operations
- WebSocket for realtime (terminal, monitoring, events)

**Rationale:**
1. REST is simple and cacheable
2. WebSocket necessary for terminal I/O and live updates
3. HTTP/2 not needed for MVP
4. Clear separation of concerns

**Consequences:**
- Need to maintain both protocols
- WebSocket connection management complexity

**Alternatives Considered:**
- GraphQL: Overkill for this use case
- gRPC: Complexity not justified
- Server-Sent Events: Less flexible than WebSocket
- HTTP/2 streams: Browser support not universal

---

#### ADR-006: Linux-First, Other Platforms Later
**Date:** 2026-09-15  
**Status:** Accepted  
**Context:**
Need to prioritize platform support.

**Decision:**
Linux (Ubuntu LTS) is primary target for MVP.
Windows and macOS support in Phase 9.

**Rationale:**
1. VPS typically run Linux
2. Linux has best PTY support
3. Focus ensures quality on primary platform
4. Can expand after Linux is solid

**Consequences:**
- MVP limited to Linux
- Windows/macOS users must wait
- Platform adapter architecture allows expansion

**Alternatives Considered:**
- Cross-platform from day one: Delays MVP, dilutes quality
- Windows-first: Not typical VPS OS

---

#### ADR-007: Argon2id for Password Hashing
**Date:** 2026-09-15  
**Status:** Accepted  
**Context:**
Need to choose password hashing algorithm.

**Decision:**
Argon2id with parameters: memoryCost=65536, timeCost=3, parallelism=4

**Rationale:**
1. Winner of Password Hashing Competition
2. Resistant to GPU/ASIC attacks
3. Configurable parameters
4. Widely adopted

**Consequences:**
- Slightly slower than bcrypt
- Higher memory usage (intentional)

**Alternatives Considered:**
- bcrypt: Older, less resistant to hardware attacks
- scrypt: Good but Argon2 is newer standard
- PBKDF2: Not recommended for passwords anymore

---

#### ADR-008: JWT for Access Tokens, Database for Refresh Tokens
**Date:** 2026-09-15  
**Status:** Accepted  
**Context:**
Need to choose authentication token strategy.

**Decision:**
- Short-lived JWT for access tokens (15 min)
- Long-lived refresh tokens in database (30 days)

**Rationale:**
1. JWT doesn't require database lookup (fast)
2. Short expiry limits exposure
3. Refresh tokens in DB allow revocation
4. Standard pattern

**Consequences:**
- Token refresh logic needed
- Database queries for refresh

**Alternatives Considered:**
- JWT only: Can't revoke
- Sessions only: Database query on every request
- OAuth: Overkill for self-hosted

---

#### ADR-009: Monorepo Structure
**Date:** 2026-09-15  
**Status:** Accepted  
**Context:**
Need to organize codebase structure.

**Decision:**
Monorepo with packages:
- `packages/frontend` - React app
- `packages/backend` - Node.js backend
- `packages/agent` - Host Agent
- `packages/shared` - Shared types and utilities

**Rationale:**
1. Easy code sharing (types, constants)
2. Coordinated versioning
3. Single CI/CD pipeline
4. Atomic cross-package changes

**Consequences:**
- All code in one repo
- Need monorepo tooling (npm workspaces or pnpm)
- Slightly more complex build

**Alternatives Considered:**
- Separate repos: Harder to share code and coordinate
- Single package: Too monolithic

---

#### ADR-010: S3-Compatible Object Storage
**Date:** 2026-09-15  
**Status:** Accepted  
**Context:**
Need to choose cloud storage backend.

**Decision:**
S3-compatible storage (AWS S3, MinIO, Cloudflare R2).

**Rationale:**
1. S3 API is de facto standard
2. Multiple provider options
3. Scalable and reliable
4. Cost-effective for large files
5. Can self-host with MinIO

**Consequences:**
- S3 API dependency
- Storage costs for hosted version
- Need lifecycle policies for cost management

**Alternatives Considered:**
- Database BLOB storage: Not scalable for large files
- Local filesystem: Not scalable, no redundancy
- Custom storage API: Reinventing wheel

---

## 18. OPEN QUESTIONS

### QUESTION-001: AI Model Selection
**Category:** AI Agent  
**Priority:** Medium  
**Context:**
Which AI model to use for AI assistant?

**Options:**
1. Claude 3.5 Sonnet (Anthropic API)
2. GPT-4 (OpenAI API)
3. Self-hosted Llama 3
4. Multiple model support

**Considerations:**
- Cost per request
- Tool calling capability
- Context window size
- Privacy concerns (API vs self-hosted)
- Rate limits

**Decision Required By:** Phase 8 start  
**Owner:** AI Team

---

### QUESTION-002: Email Service Provider
**Category:** Infrastructure  
**Priority:** Low  
**Context:**
Which email service for transactional emails?

**Options:**
1. SendGrid
2. AWS SES
3. Postmark
4. Self-hosted SMTP (Postfix)

**Considerations:**
- Deliverability
- Cost
- Setup complexity
- Scalability

**Decision Required By:** Phase 1 complete  
**Owner:** Backend Team

---

### QUESTION-003: Monitoring Solution
**Category:** Operations  
**Priority:** Medium  
**Context:**
What monitoring stack to use for production?

**Options:**
1. Prometheus + Grafana (self-hosted)
2. Datadog (SaaS)
3. New Relic (SaaS)
4. CloudWatch (AWS only)

**Considerations:**
- Self-hosted vs SaaS
- Cost
- Features (metrics, logs, traces)
- Ease of setup

**Decision Required By:** Phase 10 start  
**Owner:** DevOps Team

---

### QUESTION-004: Multi-tenancy Model
**Category:** Architecture  
**Priority:** Medium  
**Context:**
Should Aether support organizations/teams, or only individual users?

**Options:**
1. Individual users only (MVP)
2. Organizations with teams (later)
3. Organizations from day one

**Considerations:**
- MVP scope
- Database schema changes later
- Permission model complexity
- Market demand

**Decision Required By:** Phase 1 start  
**Owner:** Product Team

---

### QUESTION-005: Internationalization (i18n)
**Category:** Features  
**Priority:** Low  
**Context:**
Should Aether support multiple languages?

**Options:**
1. English only (MVP)
2. i18n from day one
3. i18n in Phase 9+

**Considerations:**
- Development complexity
- Target market
- Translation costs
- UI text extraction

**Decision Required By:** Phase 3 start  
**Owner:** Frontend Team

---

## 19. TESTING STRATEGY

### 19.1 Testing Pyramid

```
                    ╱╲
                   ╱  ╲
                  ╱ E2E ╲              10%
                 ╱────────╲
                ╱          ╲
               ╱ Integration╲          30%
              ╱──────────────╲
             ╱                ╲
            ╱   Unit Tests     ╲       60%
           ╱────────────────────╲
```

**Target Coverage:**
- Unit tests: 80%+ coverage
- Integration tests: Critical paths
- E2E tests: User journeys

### 19.2 Unit Testing

**Tools:**
- Frontend: Vitest + React Testing Library
- Backend: Jest + Supertest
- Agent: Jest

**Scope:**
- Pure functions
- Component logic
- Business logic
- Validation schemas
- Permission checks
- Path security utilities
- Error handling

**Example:**
```typescript
describe('validateFilesystemPath', () => {
  it('should reject path traversal attempts', () => {
    const result = validateFilesystemPath(
      '../../../etc/shadow',
      ['/home/user']
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('outside allowed');
  });
  
  it('should accept valid path', () => {
    const result = validateFilesystemPath(
      '/home/user/documents/file.txt',
      ['/home/user']
    );
    expect(result.valid).toBe(true);
    expect(result.canonicalPath).toBeDefined();
  });
});
```

### 19.3 Integration Testing

**Scope:**
- API endpoints with database
- WebSocket communication
- Host Agent <-> Backend
- Authentication flow
- File operations
- Terminal sessions

**Example:**
```typescript
describe('Terminal API', () => {
  it('should create PTY session', async () => {
    const res = await request(app)
      .post('/api/hosts/host123/terminal/sessions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        shell: '/bin/bash',
        cwd: '/home/user',
        rows: 24,
        cols: 80
      });
    
    expect(res.status).toBe(200);
    expect(res.body.data.sessionId).toBeDefined();
    expect(res.body.data.pid).toBeGreaterThan(0);
  });
});
```

### 19.4 End-to-End Testing

**Tools:** Playwright

**Scope:**
- User registration and login
- Host pairing
- Desktop loading
- Opening and using apps
- Terminal command execution
- File operations
- Multi-window management

**Example:**
```typescript
test('user can create file in terminal and see it in file manager', async ({ page }) => {
  // Login
  await page.goto('http://localhost:3000');
  await page.fill('[name=email]', 'test@example.com');
  await page.fill('[name=password]', 'password123');
  await page.click('button[type=submit]');
  
  // Wait for desktop
  await page.waitForSelector('[data-testid=desktop]');
  
  // Open terminal
  await page.click('[data-app=terminal]');
  await page.waitForSelector('[data-testid=terminal]');
  
  // Create file
  await page.keyboard.type('echo "Hello Aether" > test.txt\n');
  await page.waitForTimeout(1000);
  
  // Open file manager
  await page.click('[data-app=files]');
  await page.waitForSelector('[data-testid=file-manager]');
  
  // Verify file exists
  const file = await page.locator('[data-file=test.txt]');
  await expect(file).toBeVisible();
});
```

### 19.5 Security Testing

**Manual Testing:**
- Path traversal attempts
- Command injection attempts
- XSS attempts
- CSRF testing
- Session hijacking attempts
- Permission bypass attempts

**Automated (future):**
- OWASP ZAP scanning
- Dependency vulnerability scanning (npm audit)
- Static analysis (ESLint security plugins)

### 19.6 Performance Testing

**Tools:** k6 or Artillery

**Scope:**
- API endpoint response times
- WebSocket connection limits
- Concurrent user load
- Database query performance
- File upload/download throughput

**Example:**
```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';

export let options = {
  stages: [
    { duration: '2m', target: 10 },  // Ramp up
    { duration: '5m', target: 50 },  // Stay at 50 users
    { duration: '2m', target: 0 },   // Ramp down
  ],
};

export default function () {
  let res = http.get('https://aether.example.com/api/hosts');
  check(res, {
    'status is 200': (r) => r.status === 200,
    'response time < 500ms': (r) => r.timings.duration < 500,
  });
  sleep(1);
}
```

---

## 20. CONCLUSION

This comprehensive architecture document provides the foundation for building Aether Cloud OS as a production-ready, reliable, and secure browser-based desktop environment for VPS and local hosts.

**Key Takeaways:**

1. **Reliability First:** Every design decision prioritizes stability over features.

2. **Security by Design:** Multiple layers of security from transport to application.

3. **Honest Capabilities:** No fake features—detect and adapt to real host capabilities.

4. **Modular Architecture:** Clean separation allows independent development and testing.

5. **Linux-First:** Master one platform before expanding.

6. **Phased Approach:** Each phase delivers value and can be validated.

**Next Steps:**

1. **Review this document** with all stakeholders
2. **Resolve open questions** and decision points marked as "DECISION REQUIRED"
3. **Create UI/UX mockups** based on design system specs
4. **Set up development environment** (Phase 1)
5. **Begin implementation** following the roadmap

**Success Criteria:**

Aether Cloud OS will be considered successful when users can:
- Deploy it on their Ubuntu VPS in under 30 minutes
- Access a stable desktop through their browser
- Use a real terminal that executes commands on the host
- Manage files on their host securely
- Run multiple applications reliably
- Trust that their data is secure

This is not just a UI that looks like an OS—this is a real, functional desktop environment that brings the power of VPS to anyone with a browser.

---

**Document Version:** 1.0.0  
**Last Updated:** 2026-09-15  
**Status:** Ready for Review  
**Next Review:** After stakeholder feedback

---

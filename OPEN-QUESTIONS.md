# OPEN QUESTIONS

**Project:** Aether Cloud OS  
**Purpose:** Track unresolved questions requiring decisions  
**Last Updated:** 2026-09-15 18:53

---

## 🎯 Question Status Legend

- 🔴 **Critical** - Blocking progress, needs immediate decision
- 🟡 **High** - Important, needs decision soon
- 🟢 **Medium** - Can wait, but should be addressed
- ⚪ **Low** - Nice to have, can defer

---

## 🔴 CRITICAL QUESTIONS (Blocking Phase 1)

### Q-001: Multi-tenancy Scope

**Priority:** 🔴 Critical  
**Category:** Architecture  
**Deadline:** 2026-09-20

**Question:** Should Aether MVP support multiple users per instance, or single-user only?

**Context:**

- Affects database schema fundamentally
- Changes authentication complexity
- Impacts permission model
- Influences deployment model

**Options:**

1. **Single-user per instance** (recommended)
   - Each Aether instance = one user
   - Simpler schema, faster MVP
   - Most self-hosted use case

2. **Multi-user from day one**
   - Users, roles, organizations
   - More complex, slower MVP
   - Better for SaaS offering

**Current Blocker:** Cannot finalize Prisma schema without this decision

**Impact if Delayed:**

- Phase 1 cannot start
- Database design stalled
- Authentication system uncertain

**Recommendation:** Single-user for MVP, add multi-user later

**Assigned To:** Product Manager  
**Stakeholders:** Product Team, Engineering Leads  
**Related Decisions:** DEC-001

---

### Q-002: License Selection

**Priority:** 🔴 Critical  
**Category:** Legal  
**Deadline:** 2026-09-20

**Question:** Which open-source license should we use?

**Context:**

- Affects all source code headers
- Influences commercial strategy
- Impacts community contributions
- Cannot start repository without license

**Options:**

1. **MIT** - Most permissive, simple
2. **Apache 2.0** - Patent grant, enterprise-friendly (recommended)
3. **AGPL 3.0** - Copyleft, forces source disclosure

**Current Blocker:**

- Cannot create public repository
- Cannot accept contributions
- Unclear commercial rights

**Impact if Delayed:**

- Phase 1 blocked
- Cannot push code to Git
- Contribution guidelines incomplete

**Recommendation:** Apache 2.0

**Assigned To:** Legal/Leadership  
**Stakeholders:** CEO, CTO, Legal  
**Related Decisions:** DEC-002

---

## 🟡 HIGH PRIORITY QUESTIONS

### Q-003: Database Schema Extension Strategy

**Priority:** 🟡 High  
**Category:** Architecture  
**Deadline:** 2026-09-23

**Question:** If we start with single-user, how do we design schema to be extensible for multi-user
later?

**Context:**

- Want to avoid major schema rewrite
- Need migration path
- Should use `userId` even if always same?
- What tables need organization/team support later?

**Proposed Approach:**

```sql
-- Use userId in all tables even if single-user
CREATE TABLE hosts (
  id UUID PRIMARY KEY,
  userId UUID NOT NULL,  -- Always present
  ...
);

-- Reserve columns for future
-- organizationId UUID NULL (add later)
```

**Open Questions:**

- Should we add `organizationId` columns now (NULL)?
- Or add them in migration later?
- What's the upgrade path for existing single-user instances?

**Assigned To:** Backend Lead  
**Stakeholders:** Architecture Team  
**Related Questions:** Q-001

---

### Q-004: WebSocket Message Format

**Priority:** 🟡 High  
**Category:** Protocol Design  
**Deadline:** 2026-09-25

**Question:** What should be the exact WebSocket message format?

**Context:**

- Need consistent protocol for all real-time communication
- Terminal, monitoring, notifications all use WebSocket
- Must support request/response and events
- Need error handling

**Proposed Format:**

```typescript
interface WSMessage {
  id: string; // correlation ID
  type: 'request' | 'response' | 'event' | 'error';
  timestamp: string; // ISO 8601
  payload: any;
}
```

**Open Questions:**

- Should we use JSON or MessagePack?
- How to handle binary data (terminal output)?
- Compression strategy?
- Message size limits?

**Recommendation:** JSON for MVP, MessagePack later

**Assigned To:** Backend Lead  
**Stakeholders:** Backend Team, Agent Team

---

### Q-005: Agent Installation Method

**Priority:** 🟡 High  
**Category:** Deployment  
**Deadline:** 2026-09-30

**Question:** How should users install the Host Agent?

**Context:**

- Need easy installation on Ubuntu VPS
- Should work without Docker
- systemd service setup
- Security considerations

**Options:**

1. **Bash installer script** (recommended)

   ```bash
   curl -fsSL install.aether-os.io/agent.sh | sudo bash
   ```

2. **Package manager (apt/yum)**
   - More official, but slower to setup
   - Need to maintain packages

3. **Docker container**
   - Isolated, but adds complexity
   - Harder to access host PTY

**Open Questions:**

- Should installer run as root?
- How to handle existing installations?
- Update mechanism?
- Uninstall process?

**Recommendation:** Bash script for MVP, apt package later

**Assigned To:** DevOps Lead  
**Stakeholders:** DevOps Team, Security Team

---

## 🟢 MEDIUM PRIORITY QUESTIONS

### Q-006: API Versioning Strategy

**Priority:** 🟢 Medium  
**Category:** API Design  
**Deadline:** 2026-10-05

**Question:** Should we version the API from day one?

**Options:**

1. **URL versioning** - `/api/v1/hosts`
2. **Header versioning** - `Accept: application/vnd.aether.v1+json`
3. **No versioning initially** - Add when needed

**Recommendation:** URL versioning from start (`/api/v1/`)

**Assigned To:** Backend Lead  
**Stakeholders:** Backend Team

---

### Q-007: Error Code Standard

**Priority:** 🟢 Medium  
**Category:** Standards  
**Deadline:** 2026-10-05

**Question:** What error code format should we use?

**Proposed:**

```typescript
enum ErrorCode {
  // Format: CATEGORY_SPECIFIC_ERROR
  AUTH_INVALID_CREDENTIALS = "AUTH_INVALID_CREDENTIALS",
  AUTH_TOKEN_EXPIRED = "AUTH_TOKEN_EXPIRED",
  FS_PATH_NOT_FOUND = "FS_PATH_NOT_FOUND",
  FS_PERMISSION_DENIED = "FS_PERMISSION_DENIED",
  ...
}
```

**Open Questions:**

- Numeric codes or string codes?
- Hierarchy (general → specific)?
- HTTP status code mapping?

**Assigned To:** Backend Lead  
**Stakeholders:** Backend Team, Frontend Team

---

### Q-008: File Upload Size Limits

**Priority:** 🟢 Medium  
**Category:** Configuration  
**Deadline:** 2026-10-10

**Question:** What should be the maximum file upload size?

**Considerations:**

- VPS bandwidth limits
- nginx configuration
- Browser memory limits
- User experience

**Proposed:**

- Default: 100 MB
- Configurable per installation
- Large files: Use resumable uploads (future)

**Assigned To:** Backend Lead  
**Stakeholders:** Backend Team, DevOps

---

### Q-009: Terminal Session Limits

**Priority:** 🟢 Medium  
**Category:** Resource Management  
**Deadline:** 2026-10-15

**Question:** How many terminal sessions should one user be allowed?

**Considerations:**

- Resource usage (each PTY = process)
- Security (prevent abuse)
- User experience

**Proposed:**

- Default: 10 sessions per user
- Configurable
- Idle timeout: 30 minutes
- Cleanup on disconnect: configurable

**Assigned To:** Agent Lead  
**Stakeholders:** Backend Team, Agent Team

---

## ⚪ LOW PRIORITY QUESTIONS

### Q-010: Internationalization (i18n)

**Priority:** ⚪ Low  
**Category:** Features  
**Deadline:** 2026-11-15

**Question:** Should we support multiple languages in MVP?

**Recommendation:** English only for MVP, add i18n later

**Assigned To:** Product Manager  
**Stakeholders:** Product Team, Frontend Team

---

### Q-011: Theme Customization

**Priority:** ⚪ Low  
**Category:** Features  
**Deadline:** 2026-12-01

**Question:** Should users be able to customize themes beyond the 3 built-in options?

**Options:**

1. Fixed themes only (MVP)
2. Color customization
3. Full CSS customization

**Recommendation:** Fixed themes for MVP

**Assigned To:** Frontend Lead  
**Stakeholders:** Frontend Team, UX

---

### Q-012: Desktop Icon Management

**Priority:** ⚪ Low  
**Category:** Features  
**Deadline:** 2026-12-01

**Question:** Should users be able to place files/shortcuts on desktop?

**Recommendation:** Defer to post-MVP, start with taskbar only

**Assigned To:** Frontend Lead  
**Stakeholders:** Frontend Team

---

## 📊 TECHNICAL QUESTIONS

### Q-013: PTY Buffer Size

**Priority:** 🟡 High  
**Category:** Terminal  
**Deadline:** 2026-10-20

**Question:** What should be the terminal scrollback buffer size?

**Considerations:**

- Memory usage
- User experience
- Network transfer

**Proposed:**

- Scrollback: 10,000 lines (default xterm.js)
- Configurable per session
- Clear buffer option

**Needs Testing:** Real-world usage patterns

**Assigned To:** Backend Lead  
**Stakeholders:** Backend Team

---

### Q-014: WebSocket Ping/Pong Interval

**Priority:** 🟡 High  
**Category:** Network  
**Deadline:** 2026-10-20

**Question:** How often should we send heartbeat/keepalive?

**Proposed:**

- Ping every: 30 seconds
- Timeout if no pong: 60 seconds
- Max reconnect attempts: 5
- Backoff: exponential (1s, 2s, 4s, 8s, 16s)

**Needs Testing:** Various network conditions

**Assigned To:** Backend Lead  
**Stakeholders:** Backend Team, Agent Team

---

### Q-015: Database Connection Pooling

**Priority:** 🟢 Medium  
**Category:** Performance  
**Deadline:** 2026-10-25

**Question:** What should be the PostgreSQL connection pool size?

**Considerations:**

- VPS resource limits
- Concurrent users
- Prisma defaults

**Proposed:**

- Min connections: 2
- Max connections: 10
- Timeout: 10 seconds

**Needs Testing:** Load testing in Phase 5

**Assigned To:** Backend Lead  
**Stakeholders:** Backend Team, DevOps

---

## 🔍 SECURITY QUESTIONS

### Q-016: Password Requirements

**Priority:** 🟡 High  
**Category:** Security  
**Deadline:** 2026-09-30

**Question:** What password requirements should we enforce?

**Proposed:**

- Minimum length: 12 characters
- Require: uppercase, lowercase, number, symbol
- No common passwords (check against list)
- No user info in password

**Open Questions:**

- Maximum length?
- Password history (prevent reuse)?
- Password expiry? (not recommended by NIST)

**Assigned To:** Security Lead  
**Stakeholders:** Security Team, Backend Team

---

### Q-017: Session Duration

**Priority:** 🟡 High  
**Category:** Security  
**Deadline:** 2026-09-30

**Question:** How long should sessions last?

**Proposed (from Phase 0):**

- Access token: 15 minutes
- Refresh token: 30 days
- Idle timeout: ?

**Open Questions:**

- Idle timeout vs absolute timeout?
- Remember me option?
- Different timeout for different roles?

**Assigned To:** Security Lead  
**Stakeholders:** Security Team, Backend Team

---

### Q-018: Rate Limiting Thresholds

**Priority:** 🟡 High  
**Category:** Security  
**Deadline:** 2026-10-05

**Question:** What should be the rate limits for different endpoints?

**Proposed:**

- Login: 5 attempts per 15 minutes
- API: 100 requests per minute per user
- File upload: 10 per 15 minutes
- Terminal creation: 5 per minute

**Needs:** Real usage testing

**Assigned To:** Security Lead  
**Stakeholders:** Security Team, Backend Team

---

## 📅 QUESTION REVIEW SCHEDULE

- **Daily:** Review critical questions in standup
- **Weekly:** Review high-priority questions
- **Bi-weekly:** Review medium/low priority
- **Monthly:** Cleanup resolved questions

---

## 📝 HOW TO ADD NEW QUESTIONS

1. Add question with priority and deadline
2. Provide context and options
3. Assign owner and stakeholders
4. Link to related decisions/questions
5. Update this document

---

**Document Owner:** Architecture Team  
**Last Review:** 2026-09-15 18:53  
**Next Review:** 2026-09-16 09:00

# DECISION LOG

**Project:** Aether Cloud OS  
**Purpose:** Track all architectural and implementation decisions  
**Last Updated:** 2026-09-15

---

## 🎯 Decision Status Legend

- ✅ **Approved** - Decision finalized and approved
- ⏳ **Pending** - Awaiting stakeholder approval
- 🚧 **Proposed** - Under discussion
- ❌ **Rejected** - Decision rejected
- 🔄 **Revisit** - Needs reconsideration

---

## 📋 CRITICAL DECISIONS (Blocking Phase 1)

### DEC-001: Multi-tenancy Model

**Status:** ⏳ Pending  
**Priority:** Critical  
**Deadline:** 2026-09-26 (Before Phase 1)

**Question:** Should Aether support multiple users/organizations from day one?

**Options:**

1. **Single-user only (MVP)** - Each Aether instance = one user
2. **Multi-user from day one** - Users, roles, organizations

**Recommendation:** Option 1 (Single-user for MVP)

**Rationale:**

- Simpler database schema
- Faster MVP delivery
- Most self-hosted VPS = single user/team
- Can add multi-user in Phase 7-8
- Lower security complexity initially

**Impact:**

- Database schema design
- Authentication complexity
- Permission model
- Development timeline: -2 weeks for MVP

**Trade-offs:**

- Pro: Faster MVP, simpler code, easier to secure
- Con: Need migration later if adding multi-user
- Con: SaaS offering requires multi-user

**Implementation Notes:**

- Design schema to be extensible
- Use `userId` in all tables (even if always same)
- Document multi-user migration path

**Stakeholders:** Product Team, Engineering Leads  
**Decision Maker:** Product Manager + CTO  
**Date Needed:** 2026-09-20

---

### DEC-002: Open Source License

**Status:** ⏳ Pending  
**Priority:** Critical  
**Deadline:** 2026-09-26 (Before first commit)

**Question:** Which open-source license should Aether use?

**Options:**

1. **MIT License** - Most permissive
2. **Apache 2.0** - Permissive + patent grant
3. **AGPL 3.0** - Copyleft, requires source disclosure

**Recommendation:** Option 2 (Apache 2.0)

**Comparison:**

| Aspect                  | MIT       | Apache 2.0 | AGPL 3.0             |
| ----------------------- | --------- | ---------- | -------------------- |
| **Permissiveness**      | Very high | High       | Low (copyleft)       |
| **Patent Grant**        | No        | Yes        | Yes                  |
| **Commercial Use**      | Allowed   | Allowed    | Must disclose source |
| **Attribution**         | Required  | Required   | Required             |
| **SaaS Loophole**       | Yes       | Yes        | No (must share)      |
| **Enterprise Friendly** | Very      | Very       | Limited              |
| **Community Growth**    | Easy      | Easy       | Moderate             |

**Rationale for Apache 2.0:**

- Balance of openness and protection
- Patent grant protects contributors and users
- Enterprise-friendly (unlike AGPL)
- Allows proprietary forks (business model flexibility)
- Used by major projects (Kubernetes, Kafka, etc.)
- Better than MIT (patent protection)
- More permissive than AGPL (wider adoption)

**Impact:**

- License headers in all source files
- LICENSE file in repository
- Contribution guidelines
- Commercial strategy

**Stakeholders:** Legal, Leadership, Engineering  
**Decision Maker:** CEO/CTO  
**Date Needed:** 2026-09-20

---

## 🔧 TECHNICAL DECISIONS (Non-blocking but important)

### DEC-003: Monorepo Tool

**Status:** 🚧 Proposed  
**Priority:** High  
**Deadline:** 2026-09-23

**Question:** Which monorepo tool should we use?

**Options:**

1. **PNPM Workspaces** - Simple, fast
2. **Turborepo + PNPM** - Adds caching
3. **Nx** - Powerful but complex
4. **Yarn Workspaces** - Mature but slower

**Recommendation:** Option 1 (PNPM Workspaces for MVP)

**Rationale:**

- PNPM is fastest package manager
- Excellent disk space efficiency
- Simple monorepo support
- Can add Turborepo later if needed
- Lower learning curve
- Good enough for MVP scale

**Impact:**

- `pnpm-workspace.yaml` configuration
- Package linking strategy
- Build scripts
- CI/CD pipeline

**Can be changed later?** Yes (low risk)

**Decision Made:** 2026-09-15  
**Decided By:** Architecture Team

---

### DEC-004: Frontend State Management

**Status:** ✅ Approved  
**Priority:** Medium  
**Deadline:** N/A

**Question:** Which state management solution for React?

**Options:**

1. **Zustand** - Simple, lightweight
2. **Redux Toolkit** - Powerful, boilerplate
3. **Jotai** - Atomic state
4. **Context API only** - Built-in

**Decision:** Option 1 (Zustand)

**Rationale:**

- Simpler than Redux
- Less boilerplate
- Good TypeScript support
- Easy to learn
- Sufficient for MVP needs
- Can coexist with React Query for server state

**Impact:**

- Store structure
- State persistence
- DevTools integration

**Decision Made:** 2026-09-15  
**Decided By:** Architecture Team

---

### DEC-005: Agent Runtime (MVP)

**Status:** ✅ Approved  
**Priority:** High  
**Deadline:** N/A

**Question:** What runtime for Host Agent in MVP?

**Options:**

1. **Node.js** - Fast development
2. **Go** - Better performance
3. **Rust** - Best performance, complex

**Decision:** Option 1 (Node.js for MVP, Go migration later)

**Rationale:**

- node-pty is most mature PTY library
- Faster MVP development
- Type sharing with backend
- Easier debugging
- Known trade-off: higher memory usage
- Migration to Go planned for Phase 9+

**Impact:**

- Development velocity: +2 weeks faster MVP
- Runtime memory: ~50-100MB higher
- Cross-compilation: Later with Go

**Migration Plan:**

- Phase 1-6: Node.js agent
- Phase 9+: Rewrite in Go
- Keep protocol compatible

**Decision Made:** 2026-09-15  
**Decided By:** Architecture Team (documented in ADR-001)

---

### DEC-006: Testing Framework

**Status:** ✅ Approved  
**Priority:** Medium  
**Deadline:** N/A

**Question:** Which testing frameworks?

**Decision:**

- **Frontend:** Vitest + React Testing Library
- **Backend:** Jest + Supertest
- **E2E:** Playwright

**Rationale:**

- Vitest: Faster than Jest, Vite-native
- Jest: Mature, good Node.js support
- Playwright: Best E2E tool, multi-browser
- React Testing Library: Best practices
- Supertest: Easy API testing

**Impact:**

- Test setup configuration
- CI/CD pipeline
- Coverage reporting

**Decision Made:** 2026-09-15  
**Decided By:** Architecture Team

---

### DEC-007: Database Migration Strategy

**Status:** ✅ Approved  
**Priority:** High  
**Deadline:** N/A

**Question:** How to handle database migrations?

**Decision:** Prisma Migrate (forward-only)

**Rationale:**

- Prisma is chosen ORM
- Built-in migration tool
- Version controlled
- TypeScript-first
- No rollback migrations (forward-only safer)

**Migration Rules:**

1. Never modify existing migrations
2. Always create new migration for changes
3. Test migrations on staging first
4. Backup before production migration
5. Migrations must be idempotent where possible

**Impact:**

- `prisma/migrations/` directory
- Migration scripts in CI/CD
- Backup requirements

**Decision Made:** 2026-09-15  
**Decided By:** Architecture Team

---

## 📊 PENDING DECISIONS (Need Input)

### DEC-008: AI Model Selection

**Status:** ⏳ Pending  
**Priority:** Low (Phase 8)  
**Deadline:** 2027-02-01

**Question:** Which AI model for AI Assistant?

**Options:**

1. Claude 3.5 Sonnet (Anthropic)
2. GPT-4 (OpenAI)
3. Self-hosted Llama 3
4. Multi-model support

**Considerations:**

- Cost per request
- Tool calling capability
- Context window
- Privacy (API vs self-hosted)
- Rate limits

**Action:** Defer to Phase 8 planning

---

### DEC-009: Email Service Provider

**Status:** ⏳ Pending  
**Priority:** Medium (Phase 1)  
**Deadline:** 2026-10-11

**Question:** Which email service for transactional emails?

**Options:**

1. SendGrid
2. AWS SES
3. Postmark
4. Self-hosted (Postfix)

**Considerations:**

- Deliverability
- Cost
- Setup complexity
- Scalability

**Action:** DevOps team to evaluate during Phase 1

---

### DEC-010: Monitoring Solution

**Status:** ⏳ Pending  
**Priority:** Low (Phase 10)  
**Deadline:** 2027-03-01

**Question:** Production monitoring stack?

**Options:**

1. Prometheus + Grafana (self-hosted)
2. Datadog (SaaS)
3. New Relic (SaaS)
4. CloudWatch (AWS only)

**Considerations:**

- Self-hosted vs SaaS
- Cost
- Features needed
- Learning curve

**Action:** Defer to Phase 10 planning

---

### DEC-011: Internationalization (i18n)

**Status:** ⏳ Pending  
**Priority:** Low (Phase 3)  
**Deadline:** 2026-11-15

**Question:** Should Aether support multiple languages?

**Options:**

1. English only (MVP)
2. i18n from Phase 3
3. i18n in Phase 9+

**Considerations:**

- Development complexity
- Target market
- Translation costs

**Recommendation:** English only for MVP

**Action:** Product team to decide during Phase 3 planning

---

## 🔄 REVISIT DECISIONS

### DEC-012: Browser Implementation

**Status:** ✅ Approved (but revisit later)  
**Priority:** Medium  
**Original Decision:** iframe browser for MVP

**Question:** Full browser vs iframe wrapper?

**MVP Decision:** iframe wrapper (simple, honest about limitations)

**Revisit In:** Phase 7+

**Options for Future:**

1. Remote browser (headless Chromium)
2. Browser engine embedding
3. Keep iframe

**Current Status:** iframe for MVP, evaluate remote browser in Phase 7

---

## 📝 ASSUMPTIONS LOG

### ASSUMPTION-001: Deployment Target

**Assumption:** Primary deployment is Ubuntu 22.04/24.04 LTS VPS  
**Status:** Active  
**Impact:** Installation scripts, dependencies, testing  
**Risk:** Low  
**Validation:** Confirmed in Phase 0 architecture

### ASSUMPTION-002: Resource Constraints

**Assumption:** Target VPS has minimum 2 vCPU, 4GB RAM  
**Status:** Active  
**Impact:** Performance optimization, feature scope  
**Risk:** Medium  
**Validation:** Need real-world testing in Phase 4+

### ASSUMPTION-003: Internet Connectivity

**Assumption:** Host has stable internet connection  
**Status:** Active  
**Impact:** WebSocket reliability, reconnection strategy  
**Risk:** Medium  
**Validation:** Need testing with poor connections

### ASSUMPTION-004: Single Host per User (MVP)

**Assumption:** MVP users manage one host at a time  
**Status:** Active (may change)  
**Impact:** UI complexity, state management  
**Risk:** Low  
**Validation:** User feedback after MVP

---

## 📅 Decision Timeline

| Date       | Decision                        | Status      | Impact                |
| ---------- | ------------------------------- | ----------- | --------------------- |
| 2026-09-15 | Monorepo: PNPM Workspaces       | 🚧 Proposed | Development workflow  |
| 2026-09-15 | State: Zustand                  | ✅ Approved | Frontend architecture |
| 2026-09-15 | Agent: Node.js (MVP)            | ✅ Approved | Development speed     |
| 2026-09-15 | Testing: Vitest+Jest+Playwright | ✅ Approved | Quality assurance     |
| 2026-09-20 | Multi-tenancy                   | ⏳ Pending  | **BLOCKING**          |
| 2026-09-20 | License                         | ⏳ Pending  | **BLOCKING**          |

---

## 🔍 Decision Review Schedule

- **Weekly:** Review pending decisions in standup
- **Phase End:** Review all decisions for next phase
- **Monthly:** Review assumptions validity
- **Quarterly:** Review approved decisions for reconsideration

---

**Document Owner:** Architecture Team  
**Last Review:** 2026-09-15  
**Next Review:** 2026-09-22

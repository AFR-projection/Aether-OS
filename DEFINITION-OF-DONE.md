# Definition of Done

**Version:** 1.0.0  
**Date:** 2026-09-15  
**Purpose:** Define clear completion criteria for all work items

---

## Universal Criteria

Every task, feature, or component is considered "done" ONLY when ALL of the following are true:

### 1. Code Quality

- [ ] Code exists and compiles without errors
- [ ] TypeScript: No `any` types without justification
- [ ] All imports resolve correctly
- [ ] ESLint passes with no errors (warnings documented)
- [ ] Prettier formatting applied
- [ ] No commented-out code blocks
- [ ] No TODO comments without tracking issue
- [ ] No console.log in production code (use proper logging)

### 2. Functionality

- [ ] Feature works as specified
- [ ] All acceptance criteria met
- [ ] Edge cases handled
- [ ] Error cases handled gracefully
- [ ] User feedback provided (loading, success, error states)
- [ ] No critical bugs

### 3. Testing

- [ ] Unit tests written for business logic
- [ ] Tests pass locally
- [ ] Test coverage ≥ 70% for critical paths
- [ ] Integration tests for API endpoints (where applicable)
- [ ] Manual testing performed
- [ ] Security edge cases tested

### 4. Security

- [ ] Input validation implemented
- [ ] Authorization checks in place
- [ ] No secrets in code or logs
- [ ] SQL injection prevented (parameterized queries)
- [ ] Command injection prevented (no shell execution with user input)
- [ ] Path traversal prevented (validated paths)
- [ ] CSRF protection (where applicable)
- [ ] XSS prevention (React handles most, verify edge cases)

### 5. Documentation

- [ ] Public APIs documented (JSDoc/TSDoc)
- [ ] Complex logic explained with comments
- [ ] README updated (if public interface changed)
- [ ] CHANGELOG updated (if user-facing change)
- [ ] Known limitations documented

### 6. Git

- [ ] Code committed with clear message
- [ ] Commit follows conventional commit format
- [ ] No merge conflicts
- [ ] Pushed to remote repository

---

## Component-Specific Criteria

### Backend API Endpoint

**Definition of Done:**

- [ ] Route registered in Fastify
- [ ] Request validation (Zod schema)
- [ ] Business logic implemented
- [ ] Error handling (try-catch, proper status codes)
- [ ] Response formatting
- [ ] Authentication middleware (if required)
- [ ] Authorization checks (if required)
- [ ] Database transactions (if data modification)
- [ ] Audit logging (for sensitive operations)
- [ ] Unit tests for business logic
- [ ] Integration test for endpoint
- [ ] API documentation (JSDoc)
- [ ] Manual test with curl/Postman

**NOT Done If:**

- Returns 500 errors
- Missing input validation
- No error handling
- No tests
- Security checks missing

---

### Frontend Component

**Definition of Done:**

- [ ] Component renders without errors
- [ ] Props properly typed (TypeScript)
- [ ] Handles loading state
- [ ] Handles error state
- [ ] Handles empty state
- [ ] Accessibility (ARIA labels, keyboard nav)
- [ ] Responsive (works on different screen sizes)
- [ ] Unit test (if complex logic)
- [ ] Storybook story (if reusable component)
- [ ] Manual testing in browser

**NOT Done If:**

- Console errors
- TypeScript errors
- No error handling
- Accessibility issues
- Not responsive

---

### Database Migration

**Definition of Done:**

- [ ] Migration file created with timestamp
- [ ] Up migration (schema change)
- [ ] Down migration (rollback)
- [ ] Tested locally (up + down)
- [ ] No data loss in down migration (or documented)
- [ ] Indexes created for foreign keys
- [ ] Constraints properly defined
- [ ] Default values specified
- [ ] Migration documented in CHANGELOG

**NOT Done If:**

- Cannot rollback
- Data loss not documented
- Not tested
- Missing indexes

---

### Installer Script Module

**Definition of Done:**

- [ ] Shell script follows best practices
- [ ] Uses `set -euo pipefail` (or equivalent)
- [ ] All variables quoted properly
- [ ] Input validated
- [ ] Error messages are actionable
- [ ] Idempotent (can run multiple times)
- [ ] Dry-run mode supported
- [ ] Logs all operations
- [ ] Passes shellcheck
- [ ] Tested in dry-run mode
- [ ] Tested on Ubuntu 22.04 (if possible)

**NOT Done If:**

- Shellcheck errors
- Not idempotent
- Poor error messages
- No input validation
- Destructive without confirmation

---

### Docker Configuration

**Definition of Done:**

- [ ] Dockerfile builds successfully
- [ ] Multi-stage build (if applicable)
- [ ] Non-root user
- [ ] Health check defined
- [ ] Environment variables documented
- [ ] Image size optimized
- [ ] .dockerignore configured
- [ ] docker-compose.yml updated
- [ ] Services start successfully
- [ ] Health checks pass
- [ ] Network configuration correct
- [ ] Volume mounts correct

**NOT Done If:**

- Build fails
- Runs as root
- No health check
- Services don't start
- Security issues

---

## Feature-Level Criteria

### Authentication System

**Definition of Done:**

- [ ] User can register (if applicable)
- [ ] User can login
- [ ] User can logout
- [ ] JWT tokens generated correctly
- [ ] Token expiration handled
- [ ] Refresh token flow works
- [ ] Password hashing (bcrypt)
- [ ] Session management
- [ ] Protected routes work
- [ ] Unauthorized access blocked
- [ ] CSRF protection
- [ ] Rate limiting on auth endpoints
- [ ] Audit logging (login attempts)
- [ ] Tests for all flows
- [ ] Security review passed

**NOT Done If:**

- Can bypass authentication
- Tokens don't expire
- No rate limiting
- Passwords not hashed
- Security vulnerabilities

---

### Terminal Feature

**Definition of Done:**

- [ ] Can create terminal session
- [ ] Can send input
- [ ] Receives output in real-time
- [ ] Colors and formatting work
- [ ] Resize works
- [ ] Can terminate session
- [ ] Session cleanup on disconnect
- [ ] Multiple terminals work
- [ ] Command history works
- [ ] Copy/paste works
- [ ] Security: commands sandboxed to user
- [ ] Security: no command injection
- [ ] Error handling (connection loss)
- [ ] Tests for backend API
- [ ] Tests for frontend component
- [ ] Manual testing with complex commands

**NOT Done If:**

- Output not real-time
- Memory leaks
- Security bypasses
- Doesn't handle disconnection
- No session cleanup

---

### File Manager Feature

**Definition of Done:**

- [ ] Can list directory
- [ ] Can navigate directories
- [ ] Can view file contents
- [ ] Can create file/directory
- [ ] Can delete file/directory
- [ ] Can rename/move
- [ ] Can upload file
- [ ] Can download file
- [ ] Path validation (no traversal)
- [ ] Permission checks
- [ ] Hidden files handling
- [ ] Large file handling
- [ ] Error messages clear
- [ ] Tests for all operations
- [ ] Security review passed

**NOT Done If:**

- Path traversal possible
- No permission checks
- Crashes on large files
- Can access unauthorized paths

---

## Installer Milestones

### Installer Preflight Complete

**Definition of Done:**

- [ ] Detects OS and architecture
- [ ] Detects unsupported platforms
- [ ] Checks CPU, RAM, disk
- [ ] Blocks if below minimum
- [ ] Warns if below recommended
- [ ] Checks internet connectivity
- [ ] Checks DNS resolution
- [ ] Checks port availability
- [ ] Checks sudo availability
- [ ] Displays clear summary
- [ ] Asks for confirmation
- [ ] Dry-run mode works
- [ ] All checks pass on Ubuntu 22.04
- [ ] Shellcheck passes

**NOT Done If:**

- False positives on checks
- Doesn't block unsupported
- No confirmation step
- Shellcheck errors

---

### Installer Full Pipeline

**Definition of Done:**

- [ ] All 23 stages implemented
- [ ] State saved after each stage
- [ ] Can resume after interruption
- [ ] Rollback works on failure
- [ ] Docker installed (if missing)
- [ ] Release downloaded
- [ ] Checksum verified
- [ ] Secrets generated securely
- [ ] docker-compose.yml created
- [ ] Services started
- [ ] Database initialized
- [ ] Health checks pass
- [ ] HTTPS configured (if domain)
- [ ] Firewall configured
- [ ] SSH not blocked
- [ ] Summary displayed
- [ ] Logs preserved
- [ ] Tested on fresh Ubuntu VPS
- [ ] Tested with existing Docker
- [ ] Tested with/without domain

**NOT Done If:**

- Cannot resume
- Rollback doesn't work
- Services don't start
- Health checks fail
- SSH blocked
- Not tested on VPS

---

## Testing Criteria

### Unit Test Suite

**Definition of Done:**

- [ ] Tests for all business logic
- [ ] Tests for all validation functions
- [ ] Tests for edge cases
- [ ] Tests for error cases
- [ ] All tests pass
- [ ] Coverage ≥ 70% for critical paths
- [ ] Fast execution (< 1 second total)
- [ ] No flaky tests
- [ ] Clear test names
- [ ] Arrange-Act-Assert pattern

**NOT Done If:**

- Tests fail
- Coverage < 70%
- Flaky tests
- Slow tests (> 5s)

---

### Integration Test Suite

**Definition of Done:**

- [ ] Tests for API endpoints
- [ ] Tests for database operations
- [ ] Tests for authentication flow
- [ ] Tests for WebSocket communication
- [ ] All tests pass
- [ ] Tests isolated (no shared state)
- [ ] Test database used (not production)
- [ ] Cleanup after tests
- [ ] Can run locally

**NOT Done If:**

- Tests fail
- Tests interfere with each other
- Uses production database
- No cleanup

---

### Security Test Suite

**Definition of Done:**

- [ ] Tests for input validation
- [ ] Tests for authentication bypass attempts
- [ ] Tests for authorization bypass attempts
- [ ] Tests for SQL injection
- [ ] Tests for command injection
- [ ] Tests for path traversal
- [ ] Tests for XSS (if applicable)
- [ ] Tests for CSRF
- [ ] All tests pass
- [ ] Documented security boundaries

**NOT Done If:**

- Tests fail
- Security vulnerabilities found
- Bypasses possible

---

## Deployment Criteria

### Development Deployment

**Definition of Done:**

- [ ] docker-compose up succeeds
- [ ] All containers start
- [ ] Health checks pass
- [ ] Can access frontend
- [ ] Can access backend API
- [ ] Database migrations run
- [ ] Seed data loaded
- [ ] Logs accessible
- [ ] Can develop locally

**NOT Done If:**

- Services don't start
- Health checks fail
- Cannot access UI
- Database errors

---

### Production Deployment (VPS)

**Definition of Done:**

- [ ] Installer runs successfully
- [ ] All services start
- [ ] Health checks pass
- [ ] HTTPS works (with domain)
- [ ] Internal services not exposed
- [ ] Firewall configured
- [ ] SSH accessible
- [ ] Can login to UI
- [ ] Terminal works
- [ ] Files app works
- [ ] No security warnings
- [ ] Logs configured
- [ ] Monitoring works (if implemented)
- [ ] Backup strategy documented

**NOT Done If:**

- Installer fails
- Services fail
- HTTPS doesn't work
- Internal services exposed
- Security issues
- SSH blocked

---

## Documentation Criteria

### API Documentation

**Definition of Done:**

- [ ] All endpoints documented
- [ ] Request format documented
- [ ] Response format documented
- [ ] Authentication documented
- [ ] Error codes documented
- [ ] Examples provided
- [ ] Up-to-date with code

**NOT Done If:**

- Missing endpoints
- Out of date
- No examples

---

### User Documentation

**Definition of Done:**

- [ ] Installation guide
- [ ] Quick start guide
- [ ] Feature documentation
- [ ] Troubleshooting guide
- [ ] FAQ
- [ ] Screenshots/videos (if applicable)
- [ ] Up-to-date

**NOT Done If:**

- Missing sections
- Outdated
- Confusing

---

## Release Criteria

### MVP Release

**Definition of Done:**

- [ ] All P0 features complete
- [ ] All tests pass
- [ ] Security review completed
- [ ] Performance acceptable
- [ ] Documentation complete
- [ ] Tested on Ubuntu 22.04 VPS
- [ ] Known issues documented
- [ ] Release notes written
- [ ] Changelog updated
- [ ] Version tagged in git

**NOT Done If:**

- P0 features missing
- Tests fail
- Security issues
- Performance problems
- Not tested on VPS

---

## Honest Assessment Checklist

Before marking anything as "done", ask:

1. **Does the code exist and compile?**
   - If NO → Not Done

2. **Have you tested it manually?**
   - If NO → Not Done

3. **Do automated tests exist and pass?**
   - If NO → Not Done (for non-trivial features)

4. **Is it secure?**
   - If UNSURE → Not Done, need security review

5. **Does it work on the target platform?**
   - If NOT TESTED → Not Done (or mark as "Untested on VPS")

6. **Is it documented?**
   - If NO → Not Done

7. **Would you be comfortable deploying this to production?**
   - If NO → Not Done

---

## Labels for Honest Status

Use these labels accurately:

- ✅ **Complete** - All criteria met, tested, working
- 🔄 **In Progress** - Code started, not all criteria met
- ⏸️ **Blocked** - Cannot proceed (specify blocker)
- ❌ **Not Started** - No code written
- 🚫 **Deferred** - Intentionally out of scope
- ⚠️ **Partial** - Works but missing criteria (specify what's missing)
- 🧪 **Needs Testing** - Code written, not tested on target platform
- 🔒 **Security Review Needed** - Works but security not verified

---

## Example: Honest Status Reporting

**GOOD:**

```
✅ User login endpoint
  - API endpoint implemented
  - Password hashing with bcrypt
  - JWT token generation
  - Input validation
  - Rate limiting
  - Unit tests pass
  - Integration tests pass
  - Tested manually
  - Security reviewed

⚠️ File upload endpoint (Partial)
  - Basic upload works
  - Missing: file size limit
  - Missing: virus scanning
  - Missing: progress tracking
  - Tests: basic tests only
```

**BAD:**

```
✅ Everything works perfectly!
  (No evidence, no tests, not deployed)
```

---

## Commitment

I commit to:

- ✅ Use this Definition of Done for all work
- ✅ Mark items honestly based on criteria
- ✅ Not claim "done" without evidence
- ✅ Document gaps and limitations
- ✅ Test before marking complete

I will NOT:

- ❌ Mark items done without testing
- ❌ Skip security checks
- ❌ Hide issues or limitations
- ❌ Claim production-ready without VPS testing

---

**Status:** Active  
**Applies To:** All implementation work  
**Review:** After each milestone

This is the standard. No exceptions.

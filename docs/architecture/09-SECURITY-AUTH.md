# AETHER CLOUD OS - SECURITY, AUTHENTICATION & AUTHORIZATION

**Part of:** Comprehensive Architecture Document  
**Version:** 1.0.0  
**Date:** 2026-09-15

---

## 9. AUTHENTICATION & SECURITY

### 9.1 Security Architecture Overview

Security is a first-class concern, not an afterthought.

```
┌─────────────────────────────────────────────────────────────┐
│                     SECURITY LAYERS                          │
├─────────────────────────────────────────────────────────────┤
│  1. Transport Security (TLS 1.3)                            │
│     ├─ HTTPS for all HTTP traffic                          │
│     ├─ WSS for WebSocket connections                       │
│     └─ Certificate validation                              │
├─────────────────────────────────────────────────────────────┤
│  2. Authentication Layer                                     │
│     ├─ User authentication (password + optional 2FA)       │
│     ├─ Host Agent authentication (API key)                 │
│     ├─ Session management (JWT + refresh tokens)           │
│     └─ Device fingerprinting                               │
├─────────────────────────────────────────────────────────────┤
│  3. Authorization Layer (RBAC)                              │
│     ├─ Role-based access control                           │
│     ├─ Resource-level permissions                          │
│     ├─ Host-specific permissions                           │
│     └─ App permissions                                     │
├─────────────────────────────────────────────────────────────┤
│  4. Input Validation & Sanitization                         │
│     ├─ Schema validation (Zod)                             │
│     ├─ Path traversal prevention                           │
│     ├─ Command injection prevention                        │
│     ├─ XSS prevention                                      │
│     └─ SQL injection prevention (ORM)                      │
├─────────────────────────────────────────────────────────────┤
│  5. Rate Limiting & Abuse Prevention                        │
│     ├─ API rate limiting (per user, per IP)               │
│     ├─ Failed login throttling                            │
│     ├─ WebSocket connection limits                        │
│     └─ Resource usage limits                              │
├─────────────────────────────────────────────────────────────┤
│  6. Audit & Monitoring                                      │
│     ├─ Security event logging                             │
│     ├─ Sensitive operation audit trail                    │
│     ├─ Failed authentication tracking                     │
│     └─ Anomaly detection (future)                         │
├─────────────────────────────────────────────────────────────┤
│  7. Secret Management                                       │
│     ├─ Password hashing (Argon2id)                        │
│     ├─ API key encryption                                 │
│     ├─ Environment variable security                      │
│     └─ No secrets in logs                                 │
└─────────────────────────────────────────────────────────────┘
```

### 9.2 Authentication

#### User Authentication

```typescript
interface User {
  id: string;
  email: string;
  passwordHash: string; // Argon2id
  role: UserRole;

  // 2FA
  twoFactorEnabled: boolean;
  twoFactorSecret?: string; // TOTP secret, encrypted

  // Account status
  emailVerified: boolean;
  accountLocked: boolean;
  lockReason?: string;

  // Metadata
  createdAt: string;
  lastLoginAt?: string;
  lastPasswordChangeAt: string;
  failedLoginAttempts: number;
  lastFailedLoginAt?: string;
}

enum UserRole {
  OWNER = 'owner', // Full access, can manage users
  ADMIN = 'admin', // Can manage hosts and apps
  MEMBER = 'member', // Standard user access
  READ_ONLY = 'read_only', // View-only access
}
```

**Registration Flow:**

```typescript
async function register(data: {
  email: string;
  password: string;
  name: string;
}): Promise<{ userId: string; verificationToken: string }> {
  // 1. Validate input
  const schema = z.object({
    email: z.string().email(),
    password: z
      .string()
      .min(12)
      .regex(/[A-Z]/)
      .regex(/[0-9]/)
      .regex(/[^A-Za-z0-9]/),
    name: z.string().min(1).max(100),
  });

  const validated = schema.parse(data);

  // 2. Check if email exists
  const existing = await db.user.findUnique({
    where: { email: validated.email },
  });

  if (existing) {
    throw new Error('Email already registered');
  }

  // 3. Hash password (Argon2id)
  const passwordHash = await argon2.hash(validated.password, {
    type: argon2.argon2id,
    memoryCost: 65536, // 64 MB
    timeCost: 3,
    parallelism: 4,
  });

  // 4. Create user
  const user = await db.user.create({
    data: {
      email: validated.email,
      passwordHash,
      name: validated.name,
      role: UserRole.MEMBER,
      emailVerified: false,
      twoFactorEnabled: false,
      createdAt: new Date().toISOString(),
      lastPasswordChangeAt: new Date().toISOString(),
      failedLoginAttempts: 0,
    },
  });

  // 5. Generate email verification token
  const verificationToken = await generateToken(
    {
      userId: user.id,
      type: 'email_verification',
    },
    '24h'
  );

  // 6. Send verification email
  await emailService.sendVerificationEmail(user.email, verificationToken);

  // 7. Log event
  auditLog.log({
    action: 'user.registered',
    userId: user.id,
    email: user.email,
    timestamp: new Date().toISOString(),
  });

  return { userId: user.id, verificationToken };
}
```

**Login Flow:**

```typescript
async function login(data: {
  email: string;
  password: string;
  totpCode?: string; // if 2FA enabled
  deviceId?: string;
}): Promise<{
  accessToken: string;
  refreshToken: string;
  user: PublicUser;
  requires2FA?: boolean;
}> {
  // 1. Rate limiting check
  const rateLimitKey = `login:${data.email}`;
  const attempts = await redis.get(rateLimitKey);

  if (attempts && parseInt(attempts) > 5) {
    throw new Error('Too many login attempts. Try again later.');
  }

  // 2. Find user
  const user = await db.user.findUnique({
    where: { email: data.email },
  });

  if (!user) {
    // Don't reveal if email exists
    await incrementRateLimit(rateLimitKey);
    throw new Error('Invalid credentials');
  }

  // 3. Check if account locked
  if (user.accountLocked) {
    throw new Error(`Account locked: ${user.lockReason}`);
  }

  // 4. Verify password
  const validPassword = await argon2.verify(user.passwordHash, data.password);

  if (!validPassword) {
    // Increment failed attempts
    await db.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: { increment: 1 },
        lastFailedLoginAt: new Date().toISOString(),
      },
    });

    // Lock account after 10 failed attempts
    if (user.failedLoginAttempts >= 9) {
      await db.user.update({
        where: { id: user.id },
        data: {
          accountLocked: true,
          lockReason: 'Too many failed login attempts',
        },
      });
    }

    await incrementRateLimit(rateLimitKey);
    throw new Error('Invalid credentials');
  }

  // 5. Check 2FA
  if (user.twoFactorEnabled) {
    if (!data.totpCode) {
      return { requires2FA: true };
    }

    const valid = authenticator.verify({
      token: data.totpCode,
      secret: decrypt(user.twoFactorSecret),
    });

    if (!valid) {
      throw new Error('Invalid 2FA code');
    }
  }

  // 6. Reset failed attempts
  await db.user.update({
    where: { id: user.id },
    data: {
      failedLoginAttempts: 0,
      lastLoginAt: new Date().toISOString(),
    },
  });

  // 7. Create session
  const session = await createSession(user.id, data.deviceId);

  // 8. Generate tokens
  const accessToken = jwt.sign(
    {
      userId: user.id,
      sessionId: session.id,
      role: user.role,
    },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );

  const refreshToken = await generateRefreshToken(user.id, session.id);

  // 9. Log event
  auditLog.log({
    action: 'user.logged_in',
    userId: user.id,
    sessionId: session.id,
    deviceId: data.deviceId,
    timestamp: new Date().toISOString(),
  });

  return {
    accessToken,
    refreshToken,
    user: sanitizeUser(user),
  };
}
```

#### Session Management

```typescript
interface Session {
  id: string;
  userId: string;
  deviceId?: string;
  deviceName?: string;
  deviceType?: 'desktop' | 'mobile' | 'tablet';
  ipAddress: string;
  userAgent: string;

  createdAt: string;
  lastActiveAt: string;
  expiresAt: string;

  refreshToken: string; // hashed
  revoked: boolean;
  revokedAt?: string;
  revokedReason?: string;
}

// Create session
async function createSession(userId: string, deviceId?: string): Promise<Session> {
  const sessionId = nanoid();

  const session: Session = {
    id: sessionId,
    userId,
    deviceId,
    deviceName: detectDeviceName(req.headers['user-agent']),
    deviceType: detectDeviceType(req.headers['user-agent']),
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days
    refreshToken: await hashRefreshToken(nanoid(64)),
    revoked: false,
  };

  await db.session.create({ data: session });

  return session;
}

// Refresh access token
async function refreshAccessToken(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
}> {
  // 1. Hash and find session
  const hashedToken = await hashRefreshToken(refreshToken);
  const session = await db.session.findFirst({
    where: {
      refreshToken: hashedToken,
      revoked: false,
      expiresAt: { gt: new Date().toISOString() },
    },
    include: { user: true },
  });

  if (!session) {
    throw new Error('Invalid refresh token');
  }

  // 2. Update last active
  await db.session.update({
    where: { id: session.id },
    data: { lastActiveAt: new Date().toISOString() },
  });

  // 3. Generate new tokens
  const newAccessToken = jwt.sign(
    {
      userId: session.userId,
      sessionId: session.id,
      role: session.user.role,
    },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );

  // Rotate refresh token
  const newRefreshToken = nanoid(64);
  await db.session.update({
    where: { id: session.id },
    data: { refreshToken: await hashRefreshToken(newRefreshToken) },
  });

  return {
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
  };
}

// Revoke session (logout)
async function revokeSession(sessionId: string, reason?: string): Promise<void> {
  await db.session.update({
    where: { id: sessionId },
    data: {
      revoked: true,
      revokedAt: new Date().toISOString(),
      revokedReason: reason || 'User logged out',
    },
  });

  auditLog.log({
    action: 'session.revoked',
    sessionId,
    reason,
    timestamp: new Date().toISOString(),
  });
}

// Revoke all user sessions
async function revokeAllUserSessions(userId: string, exceptSessionId?: string): Promise<void> {
  await db.session.updateMany({
    where: {
      userId,
      id: exceptSessionId ? { not: exceptSessionId } : undefined,
      revoked: false,
    },
    data: {
      revoked: true,
      revokedAt: new Date().toISOString(),
      revokedReason: 'Revoked all sessions',
    },
  });
}
```

#### Host Agent Authentication

```typescript
interface HostAgent {
  id: string;
  hostId: string;
  userId: string; // owner

  apiKey: string; // hashed
  publicKey?: string; // for mTLS (future)

  version: string;
  lastConnectedAt?: string;
  ipAddress?: string;

  status: 'paired' | 'connected' | 'disconnected' | 'revoked';

  pairedAt: string;
  revokedAt?: string;
}

// Pairing flow
async function pairHost(pairingToken: string): Promise<{
  hostId: string;
  apiKey: string;
}> {
  // 1. Validate pairing token
  const token = await db.pairingToken.findUnique({
    where: { token: pairingToken },
  });

  if (!token || token.used || token.expiresAt < new Date().toISOString()) {
    throw new Error('Invalid or expired pairing token');
  }

  // 2. Mark token as used
  await db.pairingToken.update({
    where: { id: token.id },
    data: { used: true, usedAt: new Date().toISOString() },
  });

  // 3. Generate API key
  const apiKey = `aether_${nanoid(64)}`;
  const apiKeyHash = await bcrypt.hash(apiKey, 12);

  // 4. Create host agent record
  const agent = await db.hostAgent.create({
    data: {
      hostId: token.hostId || nanoid(),
      userId: token.userId,
      apiKey: apiKeyHash,
      version: token.agentVersion,
      status: 'paired',
      pairedAt: new Date().toISOString(),
    },
  });

  // 5. Log event
  auditLog.log({
    action: 'host.paired',
    userId: token.userId,
    hostId: agent.hostId,
    timestamp: new Date().toISOString(),
  });

  // Return plain API key (only time it's shown)
  return {
    hostId: agent.hostId,
    apiKey,
  };
}

// Authenticate agent WebSocket connection
async function authenticateAgentConnection(apiKey: string): Promise<HostAgent> {
  // Rate limiting
  const attempts = await redis.incr(`agent_auth:${apiKey.substring(0, 16)}`);
  if (attempts > 10) {
    throw new Error('Too many authentication attempts');
  }

  // Find agent by hashed API key
  const agents = await db.hostAgent.findMany({
    where: { status: { not: 'revoked' } },
  });

  for (const agent of agents) {
    const valid = await bcrypt.compare(apiKey, agent.apiKey);
    if (valid) {
      // Update last connected
      await db.hostAgent.update({
        where: { id: agent.id },
        data: {
          lastConnectedAt: new Date().toISOString(),
          status: 'connected',
        },
      });

      return agent;
    }
  }

  throw new Error('Invalid API key');
}

// Revoke host agent
async function revokeHostAgent(hostId: string): Promise<void> {
  await db.hostAgent.updateMany({
    where: { hostId },
    data: {
      status: 'revoked',
      revokedAt: new Date().toISOString(),
    },
  });

  // Close active connections
  await closeAgentConnections(hostId);

  auditLog.log({
    action: 'host.revoked',
    hostId,
    timestamp: new Date().toISOString(),
  });
}
```

### 9.3 Authorization (RBAC)

Role-Based Access Control with resource-level permissions.

```typescript
interface Permission {
  resource: string; // "filesystem", "terminal", "processes", etc.
  action: string; // "read", "write", "execute", "delete"
  scope?: string; // optional scope, e.g., specific host ID
}

const rolePermissions: Record<UserRole, Permission[]> = {
  [UserRole.OWNER]: [
    // Full access to everything
    { resource: '*', action: '*' },
  ],

  [UserRole.ADMIN]: [
    // Host management
    { resource: 'host', action: 'read' },
    { resource: 'host', action: 'pair' },
    { resource: 'host', action: 'unpair' },

    // Filesystem
    { resource: 'filesystem', action: 'read' },
    { resource: 'filesystem', action: 'write' },
    { resource: 'filesystem', action: 'delete' },

    // Terminal
    { resource: 'terminal', action: 'create' },
    { resource: 'terminal', action: 'execute' },

    // Processes
    { resource: 'processes', action: 'read' },
    { resource: 'processes', action: 'kill' },

    // Services
    { resource: 'services', action: 'read' },
    { resource: 'services', action: 'manage' },

    // Apps
    { resource: 'apps', action: 'install' },
    { resource: 'apps', action: 'uninstall' },

    // Users - limited
    { resource: 'users', action: 'read' },

    // No user management
  ],

  [UserRole.MEMBER]: [
    // Host - read only
    { resource: 'host', action: 'read' },

    // Filesystem - full access to workspace
    { resource: 'filesystem', action: 'read' },
    { resource: 'filesystem', action: 'write' },
    { resource: 'filesystem', action: 'delete' },

    // Terminal
    { resource: 'terminal', action: 'create' },
    { resource: 'terminal', action: 'execute' },

    // Processes - own processes only
    { resource: 'processes', action: 'read' },
    { resource: 'processes', action: 'kill', scope: 'own' },

    // Services - read only
    { resource: 'services', action: 'read' },

    // Apps
    { resource: 'apps', action: 'install' },
    { resource: 'apps', action: 'uninstall' },
  ],

  [UserRole.READ_ONLY]: [
    // Host - read only
    { resource: 'host', action: 'read' },

    // Filesystem - read only
    { resource: 'filesystem', action: 'read' },

    // No terminal access

    // Processes - read only
    { resource: 'processes', action: 'read' },

    // Services - read only
    { resource: 'services', action: 'read' },

    // Apps - read only
    { resource: 'apps', action: 'read' },
  ],
};

// Authorization check
function authorize(
  user: User,
  resource: string,
  action: string,
  context?: { hostId?: string; resourceId?: string }
): boolean {
  const permissions = rolePermissions[user.role];

  for (const perm of permissions) {
    // Wildcard match
    if (perm.resource === '*' && perm.action === '*') {
      return true;
    }

    // Resource match
    if (perm.resource === resource || perm.resource === '*') {
      // Action match
      if (perm.action === action || perm.action === '*') {
        // Scope check
        if (perm.scope) {
          // Check scope-specific logic
          if (perm.scope === 'own' && context?.resourceId !== user.id) {
            continue; // not own resource
          }
        }
        return true;
      }
    }
  }

  return false;
}

// Authorization middleware
function requirePermission(resource: string, action: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = req.user; // from JWT middleware

    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const authorized = authorize(user, resource, action, {
      hostId: req.params.hostId,
      resourceId: req.params.resourceId,
    });

    if (!authorized) {
      auditLog.log({
        action: 'authorization.denied',
        userId: user.id,
        resource,
        actionRequested: action,
        timestamp: new Date().toISOString(),
      });

      return res.status(403).json({
        error: 'Forbidden',
        message: `Insufficient permissions for ${resource}.${action}`,
      });
    }

    next();
  };
}

// Usage in routes
app.get(
  '/api/hosts/:hostId/filesystem',
  authenticate,
  requirePermission('filesystem', 'read'),
  async (req, res) => {
    // Handler
  }
);

app.delete(
  '/api/hosts/:hostId/filesystem',
  authenticate,
  requirePermission('filesystem', 'delete'),
  async (req, res) => {
    // Handler
  }
);

app.post(
  '/api/hosts/:hostId/terminal',
  authenticate,
  requirePermission('terminal', 'create'),
  async (req, res) => {
    // Handler
  }
);
```

### 9.4 Input Validation & Sanitization

Prevent injection attacks at every layer.

#### Path Traversal Prevention

```typescript
import path from 'path';
import { minimatch } from 'minimatch';

function validateFilesystemPath(
  requestedPath: string,
  allowedRoots: string[],
  forbiddenPatterns: string[] = []
): { valid: boolean; canonicalPath?: string; reason?: string } {
  try {
    // 1. Resolve to absolute path
    const canonical = path.resolve(requestedPath);

    // 2. Check against allowed roots
    const withinAllowedRoot = allowedRoots.some((root) => canonical.startsWith(path.resolve(root)));

    if (!withinAllowedRoot) {
      return {
        valid: false,
        reason: 'Path is outside allowed directories',
      };
    }

    // 3. Check against forbidden patterns
    for (const pattern of forbiddenPatterns) {
      if (minimatch(canonical, pattern)) {
        return {
          valid: false,
          reason: 'Path matches forbidden pattern',
        };
      }
    }

    // 4. Check for suspicious patterns
    const suspicious = [
      /\.\./, // parent directory
      /\/\//, // double slash
      /\0/, // null byte
      /[<>:"|?*]/, // invalid characters (Windows)
    ];

    for (const pattern of suspicious) {
      if (pattern.test(requestedPath)) {
        return {
          valid: false,
          reason: 'Path contains suspicious characters',
        };
      }
    }

    return { valid: true, canonicalPath: canonical };
  } catch (error) {
    return {
      valid: false,
      reason: 'Invalid path format',
    };
  }
}

// Forbidden paths (never accessible)
const FORBIDDEN_PATHS = [
  '/etc/shadow',
  '/etc/sudoers',
  '/etc/sudoers.d/**',
  '/root/.ssh/**',
  '/home/*/.ssh/id_*', // private keys
  '/home/*/.ssh/id_*.pub', // public keys (also sensitive)
  '**/.env',
  '**/.env.local',
  '**/.env.*.local',
  '**/secrets.json',
  '**/secrets.yaml',
  '**/credentials.json',
  '/proc/*/environ', // process env vars
  '/sys/firmware/**',
];
```

#### Command Injection Prevention

```typescript
// DO NOT do this:
function executeCommand(userInput: string) {
  exec(`ls ${userInput}`); // VULNERABLE
}

// Instead: use allowlist and parameterization
function executeAllowedCommand(command: AllowedCommand, args: string[]): Promise<string> {
  const allowlist = {
    'list-files': { cmd: 'ls', allowedArgs: ['-la', '-lh', '-a'] },
    'disk-usage': { cmd: 'df', allowedArgs: ['-h'] },
    'process-list': { cmd: 'ps', allowedArgs: ['aux'] },
  };

  const allowed = allowlist[command];
  if (!allowed) {
    throw new Error('Command not allowed');
  }

  // Validate args against allowlist
  const validArgs = args.filter((arg) => allowed.allowedArgs.includes(arg));

  // Use execFile with array (not shell expansion)
  return new Promise((resolve, reject) => {
    execFile(allowed.cmd, validArgs, (error, stdout, stderr) => {
      if (error) return reject(error);
      resolve(stdout);
    });
  });
}
```

#### XSS Prevention

```typescript
// React handles XSS automatically for most cases via JSX escaping
// But for dangerous operations, use DOMPurify

import DOMPurify from 'dompurify';

// Sanitize HTML content
function sanitizeHtml(dirty: string): string {
  return DOMPurify.sanitize(dirty, {
    ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'a', 'p', 'br'],
    ALLOWED_ATTR: ['href'],
  });
}

// For terminal output (already handled by xterm.js)
// xterm.js does not execute scripts in terminal output

// For user-generated content (app names, descriptions)
function sanitizeUserInput(input: string): string {
  return input
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
}
```

#### SQL Injection Prevention

```typescript
// Using Prisma ORM - automatically prevents SQL injection
// via parameterized queries

// Safe:
await prisma.user.findMany({
  where: {
    email: userInput, // parameterized
  },
});

// Safe:
await prisma.$queryRaw`
  SELECT * FROM users WHERE email = ${userInput}
`; // parameterized template

// NEVER do raw string concatenation:
// await prisma.$queryRawUnsafe(`SELECT * FROM users WHERE email = '${userInput}'`); // VULNERABLE
```

### 9.5 Rate Limiting

Prevent abuse and brute force attacks.

```typescript
import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';

// Login endpoint - strict
const loginLimiter = rateLimit({
  store: new RedisStore({ client: redis }),
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts
  message: 'Too many login attempts, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Rate limit by IP + email
    return `login:${req.ip}:${req.body.email}`;
  },
});

app.post('/api/auth/login', loginLimiter, loginHandler);

// API endpoints - moderate
const apiLimiter = rateLimit({
  store: new RedisStore({ client: redis }),
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Rate limit by user ID
    return `api:${req.user?.id || req.ip}`;
  },
});

app.use('/api', authenticate, apiLimiter);

// File upload - very strict
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // 10 uploads per 15 min
  keyGenerator: (req) => `upload:${req.user?.id}`,
});

app.post('/api/fs/upload', authenticate, uploadLimiter, uploadHandler);

// WebSocket connections - per user
const wsConnectionLimit = new Map<string, number>();

wss.on('connection', (ws, req) => {
  const userId = authenticateWsConnection(req);

  const currentConnections = wsConnectionLimit.get(userId) || 0;

  if (currentConnections >= 20) {
    ws.close(1008, 'Too many connections');
    return;
  }

  wsConnectionLimit.set(userId, currentConnections + 1);

  ws.on('close', () => {
    wsConnectionLimit.set(userId, (wsConnectionLimit.get(userId) || 1) - 1);
  });
});
```

### 9.6 Audit Logging

Track sensitive operations for security and compliance.

```typescript
interface AuditEvent {
  id: string;
  timestamp: string;

  // Actor
  userId?: string;
  sessionId?: string;
  ipAddress?: string;
  userAgent?: string;

  // Action
  action: string; // e.g., "user.login", "filesystem.delete", "host.paired"
  resource?: string;
  resourceId?: string;

  // Result
  success: boolean;
  errorMessage?: string;

  // Context
  metadata?: Record<string, any>;

  // Sensitivity
  sensitive: boolean; // redact from general logs
}

class AuditLogger {
  private db: Database;
  private stream: WritableStream;

  async log(event: Omit<AuditEvent, 'id' | 'timestamp'>): Promise<void> {
    const auditEvent: AuditEvent = {
      id: nanoid(),
      timestamp: new Date().toISOString(),
      ...event,
    };

    // Store in database
    await this.db.auditLog.create({ data: auditEvent });

    // Also write to append-only log file
    await this.stream.write(JSON.stringify(auditEvent) + '\n');

    // If sensitive, don't log to general application logs
    if (!event.sensitive) {
      logger.info('Audit event', {
        action: event.action,
        userId: event.userId,
      });
    }
  }

  async query(filter: {
    userId?: string;
    action?: string;
    startDate?: string;
    endDate?: string;
    limit?: number;
  }): Promise<AuditEvent[]> {
    return await this.db.auditLog.findMany({
      where: {
        userId: filter.userId,
        action: filter.action,
        timestamp: {
          gte: filter.startDate,
          lte: filter.endDate,
        },
      },
      orderBy: { timestamp: 'desc' },
      take: filter.limit || 100,
    });
  }
}

// Usage throughout application
auditLog.log({
  action: 'filesystem.delete',
  userId: req.user.id,
  sessionId: req.sessionId,
  resource: 'file',
  resourceId: filePath,
  success: true,
  metadata: { size: fileSize },
  sensitive: false,
});

auditLog.log({
  action: 'terminal.execute',
  userId: req.user.id,
  resource: 'command',
  success: true,
  metadata: {
    sessionId: terminalSessionId,
    // Do NOT log the actual command (may contain secrets)
  },
  sensitive: true,
});
```

### 9.7 Secret Management

Never expose secrets in logs, responses, or storage without encryption.

```typescript
// Environment variables
// - Store in .env file (never commit to git)
// - Use environment variable service in production
// - Validate required secrets on startup

const requiredSecrets = ['JWT_SECRET', 'DATABASE_URL', 'REDIS_URL', 'ENCRYPTION_KEY'];

for (const secret of requiredSecrets) {
  if (!process.env[secret]) {
    throw new Error(`Missing required secret: ${secret}`);
  }
}

// Password hashing - Argon2id (winner of password hashing competition)
import argon2 from 'argon2';

async function hashPassword(password: string): Promise<string> {
  return await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536, // 64 MB
    timeCost: 3, // iterations
    parallelism: 4, // threads
  });
}

async function verifyPassword(hash: string, password: string): Promise<boolean> {
  return await argon2.verify(hash, password);
}

// Encryption for sensitive data at rest
import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'hex'); // 32 bytes

function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);

  let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
  ciphertext += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  // Return: iv + authTag + ciphertext (all hex)
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + ciphertext;
}

function decrypt(encrypted: string): string {
  const parts = encrypted.split(':');
  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const ciphertext = parts[2];

  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(authTag);

  let plaintext = decipher.update(ciphertext, 'hex', 'utf8');
  plaintext += decipher.final('utf8');

  return plaintext;
}

// Never log secrets
logger.info('User logged in', {
  userId: user.id,
  // Do NOT log: password, token, apiKey, etc.
});

// Sanitize errors before sending to client
app.use((err, req, res, next) => {
  // Log full error server-side
  logger.error('Request error', {
    error: err.message,
    stack: err.stack,
    url: req.url,
  });

  // Send sanitized error to client
  res.status(err.statusCode || 500).json({
    error: err.message || 'Internal server error',
    // Do NOT send: stack trace, env vars, internal paths
  });
});
```

---

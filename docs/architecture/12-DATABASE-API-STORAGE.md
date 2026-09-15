# AETHER CLOUD OS - DATABASE, API & CLOUD STORAGE

**Part of:** Comprehensive Architecture Document  
**Version:** 1.0.0  
**Date:** 2026-09-15

---

## 12. DATABASE & API

### 12.1 Database Schema

PostgreSQL database schema with Prisma ORM.

```prisma
// schema.prisma

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

// ============================================================================
// USERS & AUTHENTICATION
// ============================================================================

model User {
  id                    String    @id @default(cuid())
  email                 String    @unique
  passwordHash          String
  name                  String
  role                  UserRole  @default(MEMBER)
  
  // 2FA
  twoFactorEnabled      Boolean   @default(false)
  twoFactorSecret       String?   // encrypted
  
  // Account status
  emailVerified         Boolean   @default(false)
  accountLocked         Boolean   @default(false)
  lockReason            String?
  
  // Security
  failedLoginAttempts   Int       @default(0)
  lastFailedLoginAt     DateTime?
  lastPasswordChangeAt  DateTime  @default(now())
  
  // Metadata
  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @updatedAt
  lastLoginAt           DateTime?
  
  // Relations
  sessions              Session[]
  hosts                 Host[]
  auditLogs             AuditLog[]
  notifications         Notification[]
  workspaces            Workspace[]
  
  @@index([email])
  @@map("users")
}

enum UserRole {
  OWNER
  ADMIN
  MEMBER
  READ_ONLY
}

model Session {
  id            String    @id @default(cuid())
  userId        String
  user          User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  
  deviceId      String?
  deviceName    String?
  deviceType    String?   // "desktop", "mobile", "tablet"
  ipAddress     String
  userAgent     String
  
  refreshToken  String    @unique // hashed
  
  createdAt     DateTime  @default(now())
  lastActiveAt  DateTime  @default(now())
  expiresAt     DateTime
  
  revoked       Boolean   @default(false)
  revokedAt     DateTime?
  revokedReason String?
  
  @@index([userId])
  @@index([refreshToken])
  @@map("sessions")
}

model PairingToken {
  id            String    @id @default(cuid())
  token         String    @unique
  userId        String
  hostId        String?
  agentVersion  String?
  
  createdAt     DateTime  @default(now())
  expiresAt     DateTime
  
  used          Boolean   @default(false)
  usedAt        DateTime?
  
  @@index([token])
  @@map("pairing_tokens")
}

// ============================================================================
// HOSTS
// ============================================================================

model Host {
  id                String      @id @default(cuid())
  hostId            String      @unique // from agent
  userId            String
  user              User        @relation(fields: [userId], references: [id], onDelete: Cascade)
  
  name              String?     // user-assigned name
  
  // Host Agent
  agentVersion      String
  agentApiKey       String      // hashed
  agentPublicKey    String?     // for mTLS
  
  // Connection
  status            HostStatus  @default(PAIRED)
  lastConnectedAt   DateTime?
  lastDisconnectedAt DateTime?
  ipAddress         String?
  
  // Capability Report (JSON)
  capabilities      Json?       // HostCapabilityReport
  lastDiscoveryAt   DateTime?
  
  // Metadata
  pairedAt          DateTime    @default(now())
  updatedAt         DateTime    @updatedAt
  
  // Relations
  terminalSessions  TerminalSession[]
  
  @@index([userId])
  @@index([hostId])
  @@map("hosts")
}

enum HostStatus {
  PAIRED
  CONNECTED
  DISCONNECTED
  REVOKED
}

// ============================================================================
// TERMINAL
// ============================================================================

model TerminalSession {
  id            String    @id @default(cuid())
  hostId        String
  host          Host      @relation(fields: [hostId], references: [id], onDelete: Cascade)
  userId        String
  
  // PTY info
  pid           Int?
  shell         String
  cwd           String
  
  // Window size
  rows          Int       @default(24)
  cols          Int       @default(80)
  
  // Status
  status        String    @default("active") // "active", "closed"
  
  // Lifecycle
  createdAt     DateTime  @default(now())
  closedAt      DateTime?
  exitCode      Int?
  
  @@index([hostId])
  @@index([userId])
  @@map("terminal_sessions")
}

// ============================================================================
// APPLICATIONS
// ============================================================================

model App {
  id              String    @id @default(cuid())
  appId           String    @unique // e.g., "com.aether.files"
  
  // Metadata
  name            String
  version         String
  description     String
  author          String
  icon            String
  
  // Manifest (JSON)
  manifest        Json      // full AppManifest
  
  // App Store
  category        String?
  tags            String[]
  featured        Boolean   @default(false)
  
  // Stats
  installCount    Int       @default(0)
  
  // Lifecycle
  publishedAt     DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
  
  // Relations
  installations   AppInstallation[]
  
  @@index([appId])
  @@map("apps")
}

model AppInstallation {
  id              String    @id @default(cuid())
  userId          String
  appId           String
  app             App       @relation(fields: [appId], references: [id], onDelete: Cascade)
  
  version         String
  
  // Permissions
  grantedPermissions String[]
  deniedPermissions  String[]
  
  // Status
  status          String    @default("installed") // "installing", "installed", "updating", "error"
  
  installedAt     DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
  
  @@unique([userId, appId])
  @@index([userId])
  @@map("app_installations")
}

// ============================================================================
// WORKSPACES & CLOUD STORAGE
// ============================================================================

model Workspace {
  id              String    @id @default(cuid())
  userId          String
  user            User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  
  name            String
  description     String?
  
  // Storage
  storageUsed     BigInt    @default(0) // bytes
  storageQuota    BigInt    // bytes
  
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
  
  // Relations
  files           CloudFile[]
  
  @@index([userId])
  @@map("workspaces")
}

model CloudFile {
  id              String    @id @default(cuid())
  workspaceId     String
  workspace       Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  
  // File info
  path            String    // relative to workspace
  name            String
  type            String    // "file" or "directory"
  mimeType        String?
  size            BigInt    @default(0)
  
  // Storage
  storageKey      String?   // S3 key if type=file
  checksum        String?   // SHA-256
  
  // Metadata
  createdAt       DateTime  @default(now())
  modifiedAt      DateTime  @default(now())
  
  // Versioning
  version         Int       @default(1)
  parentVersion   Int?
  
  // Sync
  syncStatus      String    @default("synced") // "pending", "syncing", "synced", "conflict"
  
  // Soft delete
  deleted         Boolean   @default(false)
  deletedAt       DateTime?
  
  @@unique([workspaceId, path])
  @@index([workspaceId])
  @@map("cloud_files")
}

// ============================================================================
// NOTIFICATIONS
// ============================================================================

model Notification {
  id              String    @id @default(cuid())
  userId          String
  user            User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  
  title           String
  body            String
  icon            String?
  
  // Action
  actionLabel     String?
  actionUrl       String?
  
  // Status
  read            Boolean   @default(false)
  readAt          DateTime?
  
  createdAt       DateTime  @default(now())
  expiresAt       DateTime?
  
  @@index([userId, read])
  @@map("notifications")
}

// ============================================================================
// AUDIT & SECURITY
// ============================================================================

model AuditLog {
  id              String    @id @default(cuid())
  timestamp       DateTime  @default(now())
  
  // Actor
  userId          String?
  user            User?     @relation(fields: [userId], references: [id], onDelete: SetNull)
  sessionId       String?
  ipAddress       String?
  userAgent       String?
  
  // Action
  action          String
  resource        String?
  resourceId      String?
  
  // Result
  success         Boolean
  errorMessage    String?
  
  // Context
  metadata        Json?
  
  // Sensitivity
  sensitive       Boolean   @default(false)
  
  @@index([userId, timestamp])
  @@index([action, timestamp])
  @@map("audit_logs")
}

// ============================================================================
// SYSTEM
// ============================================================================

model SystemSetting {
  key             String    @id
  value           Json
  
  updatedAt       DateTime  @updatedAt
  
  @@map("system_settings")
}
```

### 12.2 Database Migrations

Use Prisma Migrate for versioned schema changes.

```bash
# Create migration
npx prisma migrate dev --name init

# Apply migrations in production
npx prisma migrate deploy

# Generate Prisma Client
npx prisma generate
```

**Migration Strategy:**
1. All schema changes go through migrations (never manual ALTER)
2. Migrations are versioned and stored in git
3. Forward-only migrations (no rollback migrations)
4. Test migrations on staging before production
5. Backup database before applying migrations
6. Migrations should be idempotent where possible

### 12.3 API Architecture

RESTful API for most operations, WebSocket for realtime.

#### API Structure

```
/api
├── /auth
│   ├── POST   /register
│   ├── POST   /login
│   ├── POST   /logout
│   ├── POST   /refresh
│   ├── POST   /verify-email
│   ├── POST   /forgot-password
│   ├── POST   /reset-password
│   ├── GET    /me
│   └── PATCH  /me
│
├── /hosts
│   ├── GET    /
│   ├── POST   /pair
│   ├── GET    /:hostId
│   ├── PATCH  /:hostId
│   ├── DELETE /:hostId
│   ├── GET    /:hostId/capabilities
│   ├── POST   /:hostId/refresh-capabilities
│   │
│   ├── /filesystem
│   │   ├── GET    /:hostId/filesystem/readdir
│   │   ├── GET    /:hostId/filesystem/stat
│   │   ├── GET    /:hostId/filesystem/read
│   │   ├── POST   /:hostId/filesystem/write
│   │   ├── POST   /:hostId/filesystem/mkdir
│   │   ├── DELETE /:hostId/filesystem/delete
│   │   ├── POST   /:hostId/filesystem/rename
│   │   ├── POST   /:hostId/filesystem/copy
│   │   ├── POST   /:hostId/filesystem/upload
│   │   └── GET    /:hostId/filesystem/download
│   │
│   ├── /terminal
│   │   ├── POST   /:hostId/terminal/sessions
│   │   ├── GET    /:hostId/terminal/sessions
│   │   ├── GET    /:hostId/terminal/sessions/:sessionId
│   │   ├── POST   /:hostId/terminal/sessions/:sessionId/resize
│   │   ├── DELETE /:hostId/terminal/sessions/:sessionId
│   │   └── WS     /:hostId/terminal/sessions/:sessionId (WebSocket)
│   │
│   ├── /processes
│   │   ├── GET    /:hostId/processes
│   │   ├── GET    /:hostId/processes/:pid
│   │   └── DELETE /:hostId/processes/:pid
│   │
│   ├── /services
│   │   ├── GET    /:hostId/services
│   │   ├── GET    /:hostId/services/:name
│   │   ├── POST   /:hostId/services/:name/start
│   │   ├── POST   /:hostId/services/:name/stop
│   │   ├── POST   /:hostId/services/:name/restart
│   │   ├── POST   /:hostId/services/:name/enable
│   │   └── POST   /:hostId/services/:name/disable
│   │
│   └── /resources
│       └── GET    /:hostId/resources (realtime via WebSocket)
│
├── /apps
│   ├── GET    /
│   ├── GET    /installed
│   ├── GET    /:appId
│   ├── POST   /:appId/install
│   ├── POST   /:appId/update
│   ├── DELETE /:appId/uninstall
│   └── GET    /:appId/permissions
│
├── /workspaces
│   ├── GET    /
│   ├── POST   /
│   ├── GET    /:workspaceId
│   ├── PATCH  /:workspaceId
│   ├── DELETE /:workspaceId
│   ├── GET    /:workspaceId/files
│   ├── POST   /:workspaceId/files/upload
│   ├── GET    /:workspaceId/files/download
│   └── POST   /:workspaceId/sync
│
├── /notifications
│   ├── GET    /
│   ├── PATCH  /:notificationId/read
│   ├── POST   /mark-all-read
│   └── DELETE /:notificationId
│
├── /desktop
│   ├── GET    /state
│   ├── POST   /state
│   └── PATCH  /settings
│
└── /admin
    ├── GET    /users
    ├── GET    /users/:userId
    ├── PATCH  /users/:userId
    ├── DELETE /users/:userId
    └── GET    /audit-logs
```

#### API Response Format

```typescript
// Success response
{
  "data": {
    // response data
  },
  "meta"?: {
    "page": 1,
    "pageSize": 20,
    "total": 100
  }
}

// Error response
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Validation failed",
    "details": [
      {
        "field": "email",
        "message": "Invalid email format"
      }
    ]
  },
  "requestId": "req_abc123" // for debugging
}

// Standard error codes
enum ErrorCode {
  // Client errors (4xx)
  VALIDATION_ERROR = "VALIDATION_ERROR",
  UNAUTHORIZED = "UNAUTHORIZED",
  FORBIDDEN = "FORBIDDEN",
  NOT_FOUND = "NOT_FOUND",
  CONFLICT = "CONFLICT",
  RATE_LIMIT_EXCEEDED = "RATE_LIMIT_EXCEEDED",
  
  // Server errors (5xx)
  INTERNAL_ERROR = "INTERNAL_ERROR",
  SERVICE_UNAVAILABLE = "SERVICE_UNAVAILABLE",
  HOST_UNAVAILABLE = "HOST_UNAVAILABLE"
}
```

#### Request Validation

```typescript
import { z } from 'zod';

// Example: Filesystem readdir endpoint
const readdirSchema = z.object({
  query: z.object({
    path: z.string().min(1),
    showHidden: z.string().optional().transform(val => val === 'true')
  }),
  params: z.object({
    hostId: z.string().cuid()
  })
});

app.get('/api/hosts/:hostId/filesystem/readdir', 
  authenticate,
  requirePermission('filesystem', 'read'),
  validate(readdirSchema),
  async (req, res) => {
    const { hostId } = req.params;
    const { path, showHidden } = req.query;
    
    try {
      // Validate path
      const validation = validateFilesystemPath(path, ['/home/user']);
      if (!validation.valid) {
        return res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: validation.reason
          }
        });
      }
      
      // Forward to Host Agent
      const result = await hostAgent.fs.readdir(hostId, validation.canonicalPath, {
        showHidden
      });
      
      return res.json({ data: result });
      
    } catch (error) {
      logger.error('Readdir failed', { error, hostId, path });
      
      return res.status(500).json({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to read directory'
        },
        requestId: req.id
      });
    }
  }
);
```

### 12.4 WebSocket Protocol

Realtime communication for terminal, monitoring, and events.

#### Message Format

```typescript
interface WebSocketMessage {
  id: string; // correlation ID
  type: "request" | "response" | "event" | "error";
  timestamp: string;
  payload: any;
}

// Request
interface WSRequest extends WebSocketMessage {
  type: "request";
  method: string; // "pty.write", "resource.subscribe"
  params: Record<string, any>;
}

// Response
interface WSResponse extends WebSocketMessage {
  type: "response";
  requestId: string;
  result?: any;
  error?: {
    code: string;
    message: string;
  };
}

// Event (server-initiated)
interface WSEvent extends WebSocketMessage {
  type: "event";
  event: string; // "pty.data", "resource.update"
  data: any;
}

// Error
interface WSError extends WebSocketMessage {
  type: "error";
  error: {
    code: string;
    message: string;
  };
}
```

#### WebSocket Endpoints

```typescript
// Terminal session
wss://api.aether.io/hosts/:hostId/terminal/:sessionId

// Resource monitoring
wss://api.aether.io/hosts/:hostId/resources

// Desktop events
wss://api.aether.io/desktop/events

// Notifications
wss://api.aether.io/notifications
```

#### Connection Lifecycle

```typescript
// Client connects
ws = new WebSocket('wss://api.aether.io/hosts/host123/terminal/term456');

ws.onopen = () => {
  // Send authentication
  ws.send(JSON.stringify({
    type: 'auth',
    token: accessToken
  }));
  
  // Start heartbeat
  heartbeatInterval = setInterval(() => {
    ws.send(JSON.stringify({ type: 'ping' }));
  }, 30000);
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  
  if (msg.type === 'pong') {
    lastPongTime = Date.now();
  } else if (msg.type === 'event') {
    handleEvent(msg);
  } else if (msg.type === 'response') {
    resolveRequest(msg.requestId, msg.result);
  }
};

ws.onerror = (error) => {
  console.error('WebSocket error', error);
};

ws.onclose = (event) => {
  clearInterval(heartbeatInterval);
  
  if (!event.wasClean) {
    // Attempt reconnection with exponential backoff
    reconnectWithBackoff();
  }
};

// Reconnection logic
function reconnectWithBackoff() {
  const maxDelay = 30000; // 30 seconds
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), maxDelay);
  
  setTimeout(() => {
    reconnectAttempts++;
    connectWebSocket();
  }, delay);
}
```

### 12.5 Pagination & Filtering

```typescript
// Pagination schema
const paginationSchema = z.object({
  page: z.string().optional().transform(val => parseInt(val || '1')),
  pageSize: z.string().optional().transform(val => parseInt(val || '20')),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).optional()
});

// Implementation
async function listHosts(req: Request): Promise<PaginatedResponse<Host>> {
  const { page, pageSize, sortBy, sortOrder } = paginationSchema.parse(req.query);
  
  const skip = (page - 1) * pageSize;
  
  const [hosts, total] = await Promise.all([
    db.host.findMany({
      where: { userId: req.user.id },
      skip,
      take: pageSize,
      orderBy: sortBy ? { [sortBy]: sortOrder || 'asc' } : undefined
    }),
    db.host.count({ where: { userId: req.user.id } })
  ]);
  
  return {
    data: hosts,
    meta: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize)
    }
  };
}
```

---

## 8. CLOUD STORAGE & SYNC

### 8.1 Cloud Storage Architecture

Three-tier storage model:

```
┌─────────────────────────────────────────────────────────────┐
│  1. HOST FILESYSTEM                                          │
│     - Native filesystem on VPS/local host                   │
│     - Accessed via Host Agent                               │
│     - Persistent on host                                    │
│     - NOT automatically backed up                           │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  2. AETHER CLOUD STORAGE                                     │
│     - S3-compatible object storage                          │
│     - User workspaces with quota                            │
│     - Synced across devices                                 │
│     - Backed up                                             │
│     - Versioned                                             │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  3. BROWSER LOCAL CACHE (IndexedDB)                         │
│     - Offline file access                                   │
│     - Recently accessed files                               │
│     - Configurable cache size                               │
│     - Automatically cleared based on LRU                    │
└─────────────────────────────────────────────────────────────┘
```

**Key Distinction:**
- Host filesystem: NOT cloud storage, lives on host only
- Cloud storage: Aether-managed, synced, backed up
- User can explicitly sync between host ↔ cloud

### 8.2 Workspace Model

```typescript
interface Workspace {
  id: string;
  userId: string;
  name: string;
  description?: string;
  
  // Storage
  storageUsed: number; // bytes
  storageQuota: number; // bytes
  
  // Settings
  autoSync: boolean;
  syncHosts: string[]; // host IDs to auto-sync with
  
  // Metadata
  createdAt: string;
  updatedAt: string;
}

// User can have multiple workspaces
// Each workspace has independent quota and settings
```

### 8.3 File Sync

Sync files between host filesystem and cloud storage.

```typescript
interface SyncJob {
  id: string;
  workspaceId: string;
  hostId: string;
  
  direction: "host-to-cloud" | "cloud-to-host" | "bidirectional";
  
  // Source and destination
  sourcePath: string;
  destinationPath: string;
  
  // Conflict resolution
  conflictResolution: "skip" | "overwrite" | "rename" | "manual";
  
  // Status
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  
  // Progress
  totalFiles: number;
  processedFiles: number;
  totalBytes: number;
  processedBytes: number;
  
  // Results
  succeededFiles: number;
  failedFiles: number;
  conflicts: Array<{
    path: string;
    reason: string;
    resolution?: string;
  }>;
  
  // Lifecycle
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  
  error?: string;
}

// Sync algorithm (simplified)
async function syncHostToCloud(
  hostId: string,
  workspaceId: string,
  hostPath: string,
  cloudPath: string
): Promise<SyncJob> {
  
  // 1. List files on host
  const hostFiles = await hostAgent.fs.readdir(hostId, hostPath, { recursive: true });
  
  // 2. List files in cloud workspace
  const cloudFiles = await db.cloudFile.findMany({
    where: {
      workspaceId,
      path: { startsWith: cloudPath }
    }
  });
  
  // 3. Build sync plan
  const syncPlan = buildSyncPlan(hostFiles, cloudFiles);
  
  // 4. Execute sync
  for (const item of syncPlan) {
    if (item.action === 'upload') {
      await uploadFileToCloud(item.hostFile, workspaceId, item.cloudPath);
    } else if (item.action === 'update') {
      await updateCloudFile(item.hostFile, item.cloudFile);
    } else if (item.action === 'conflict') {
      // Handle conflict based on policy
      handleConflict(item);
    }
  }
  
  return syncJob;
}
```

### 8.4 Object Storage

Use S3-compatible object storage (AWS S3, MinIO, Cloudflare R2).

```typescript
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({
  region: process.env.S3_REGION,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY
  },
  endpoint: process.env.S3_ENDPOINT // for MinIO/R2
});

const BUCKET_NAME = 'aether-cloud-storage';

// Upload file
async function uploadFile(
  workspaceId: string,
  relativePath: string,
  content: Buffer,
  metadata: {
    mimeType: string;
    checksum: string;
  }
): Promise<{ key: string; size: number }> {
  
  const key = `workspaces/${workspaceId}/${relativePath}`;
  
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    Body: content,
    ContentType: metadata.mimeType,
    Metadata: {
      checksum: metadata.checksum,
      uploadedAt: new Date().toISOString()
    }
  }));
  
  // Update database
  await db.cloudFile.upsert({
    where: {
      workspaceId_path: {
        workspaceId,
        path: relativePath
      }
    },
    create: {
      workspaceId,
      path: relativePath,
      name: path.basename(relativePath),
      type: 'file',
      mimeType: metadata.mimeType,
      size: content.length,
      storageKey: key,
      checksum: metadata.checksum,
      syncStatus: 'synced'
    },
    update: {
      size: content.length,
      storageKey: key,
      checksum: metadata.checksum,
      modifiedAt: new Date(),
      version: { increment: 1 },
      syncStatus: 'synced'
    }
  });
  
  // Update workspace storage usage
  await db.workspace.update({
    where: { id: workspaceId },
    data: {
      storageUsed: { increment: content.length }
    }
  });
  
  return { key, size: content.length };
}

// Download file
async function downloadFile(
  workspaceId: string,
  relativePath: string
): Promise<{ content: Buffer; metadata: any }> {
  
  const file = await db.cloudFile.findUnique({
    where: {
      workspaceId_path: { workspaceId, path: relativePath }
    }
  });
  
  if (!file || !file.storageKey) {
    throw new Error("File not found");
  }
  
  const response = await s3.send(new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: file.storageKey
  }));
  
  const chunks: Buffer[] = [];
  for await (const chunk of response.Body as any) {
    chunks.push(chunk);
  }
  
  return {
    content: Buffer.concat(chunks),
    metadata: {
      mimeType: file.mimeType,
      size: file.size,
      checksum: file.checksum
    }
  };
}
```

### 8.5 Conflict Resolution

When same file is modified on host and cloud:

```typescript
enum ConflictResolution {
  KEEP_HOST = "keep_host",       // Host version wins
  KEEP_CLOUD = "keep_cloud",     // Cloud version wins
  KEEP_BOTH = "keep_both",       // Rename and keep both
  KEEP_NEWER = "keep_newer",     // Based on timestamp
  MANUAL = "manual"              // User decides
}

async function handleConflict(
  hostFile: FileEntry,
  cloudFile: CloudFile,
  resolution: ConflictResolution
): Promise<void> {
  
  if (resolution === ConflictResolution.KEEP_NEWER) {
    if (hostFile.modified > cloudFile.modifiedAt) {
      resolution = ConflictResolution.KEEP_HOST;
    } else {
      resolution = ConflictResolution.KEEP_CLOUD;
    }
  }
  
  switch (resolution) {
    case ConflictResolution.KEEP_HOST:
      await uploadFileToCloud(hostFile, cloudFile.workspaceId, cloudFile.path);
      break;
      
    case ConflictResolution.KEEP_CLOUD:
      await downloadFileToHost(cloudFile, hostFile.hostId, hostFile.path);
      break;
      
    case ConflictResolution.KEEP_BOTH:
      // Upload host file with renamed path
      const renamedPath = `${cloudFile.path}.conflict-${Date.now()}`;
      await uploadFileToCloud(hostFile, cloudFile.workspaceId, renamedPath);
      break;
      
    case ConflictResolution.MANUAL:
      // Store conflict for user review
      await db.syncConflict.create({
        data: {
          workspaceId: cloudFile.workspaceId,
          path: cloudFile.path,
          hostVersion: hostFile,
          cloudVersion: cloudFile,
          status: 'pending'
        }
      });
      break;
  }
}
```

---

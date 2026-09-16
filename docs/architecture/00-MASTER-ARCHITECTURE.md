# AETHER CLOUD OS - COMPREHENSIVE ARCHITECTURE DOCUMENT

**Version:** 1.0.0  
**Date:** 2026-09-15  
**Status:** Phase 0 - Architecture Design  
**Target Platform:** Linux VPS (Ubuntu LTS) - Primary

---

## EXECUTIVE SUMMARY

Aether Cloud OS adalah universal browser-based desktop environment yang memungkinkan pengguna
mengakses dan mengoperasikan VPS atau local host melalui interface desktop modern yang berjalan di
browser.

**Core Value Proposition:**

- VPS tanpa GUI desktop mendapatkan pengalaman desktop modern melalui browser
- Terminal asli melalui PTY, bukan simulasi
- Filesystem host nyata, bukan virtual filesystem palsu
- Window manager yang stabil dan reliable
- Application runtime yang extensible
- Multi-device access dengan security yang proper
- Cloud storage dan sync
- AI assistant dengan tool permission yang terkontrol

**Engineering Principles:**

1. **Reliability** > Security > Correctness > Maintainability > Performance > Visual polish >
   Feature quantity
2. No fake features - semua fitur harus benar-benar functional
3. Capability-based design - detect dan adapt berdasarkan host capabilities
4. Security by design - tidak ada shortcuts yang mengorbankan security
5. Honest limitations - jelaskan dengan jujur apa yang tidak bisa dilakukan

---

## TABLE OF CONTENTS

1. [System Architecture Overview](#1-system-architecture-overview)
2. [Technology Stack](#2-technology-stack)
3. [Host Agent & Host Integration](#3-host-agent--host-integration)
4. [Terminal & Filesystem](#4-terminal--filesystem)
5. [Desktop & Window Manager](#5-desktop--window-manager)
6. [Application Runtime](#6-application-runtime)
7. [Built-in Applications](#7-built-in-applications)
8. [Cloud Storage & Sync](#8-cloud-storage--sync)
9. [Authentication & Security](#9-authentication--security)
10. [AI Agent](#10-ai-agent)
11. [Reliability & Observability](#11-reliability--observability)
12. [Database & API](#12-database--api)
13. [Testing & Quality Assurance](#13-testing--quality-assurance)
14. [Deployment & Operations](#14-deployment--operations)
15. [Roadmap & Milestones](#15-roadmap--milestones)
16. [Risk Register](#16-risk-register)
17. [Decision Log](#17-decision-log)

---

## 1. SYSTEM ARCHITECTURE OVERVIEW

### 1.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         BROWSER CLIENT                           │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              Aether Desktop Frontend (React)              │  │
│  ├──────────────────────────────────────────────────────────┤  │
│  │  Window Manager  │  App Runtime  │  Desktop Shell        │  │
│  │  State Manager   │  Theme System │  Notification System  │  │
│  └──────────────────────────────────────────────────────────┘  │
│           │                    │                    │            │
│      HTTPS/WSS             HTTPS/WSS           HTTPS/WSS        │
└───────────┼────────────────────┼────────────────────┼───────────┘
            │                    │                    │
┌───────────┴────────────────────┴────────────────────┴───────────┐
│                    AETHER BACKEND SERVER (VPS)                   │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                  API Gateway (Node.js)                    │  │
│  │              Authentication & Authorization               │  │
│  ├──────────────────────────────────────────────────────────┤  │
│  │  Auth Service  │  Host Service  │  Cloud Service         │  │
│  │  App Service   │  Sync Service  │  AI Agent Service      │  │
│  └──────────────────────────────────────────────────────────┘  │
│           │                    │                    │            │
│      PostgreSQL            Redis Cache          Object Storage   │
└───────────┼────────────────────┼────────────────────┼───────────┘
            │                    │                    │
┌───────────┴────────────────────┴────────────────────┴───────────┐
│                     AETHER HOST AGENT                            │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              Host Agent Core (Node.js/Go)                 │  │
│  │          Secure Pairing │ Host Discovery                  │  │
│  ├──────────────────────────────────────────────────────────┤  │
│  │  PTY Service   │  FS Service    │  Process Service       │  │
│  │  Resource Mon  │  Package Mgmt  │  Container Mgmt        │  │
│  ├──────────────────────────────────────────────────────────┤  │
│  │                    OS ADAPTER LAYER                       │  │
│  │    Linux Adapter   │   Windows Adapter   │  macOS Adapter │  │
│  └──────────────────────────────────────────────────────────┘  │
│                              │                                   │
└──────────────────────────────┼───────────────────────────────────┘
                               │
┌──────────────────────────────┴───────────────────────────────────┐
│                        NATIVE HOST OS                             │
│  Filesystem  │  Shell/PTY  │  Processes  │  Services  │ Runtime  │
└───────────────────────────────────────────────────────────────────┘
```

### 1.2 Component Responsibilities

#### Browser Client Layer

- **Frontend Desktop**: React-based desktop environment
- **Window Manager**: Manages window lifecycle, focus, positioning, z-index
- **App Runtime**: Executes and manages applications
- **Desktop Shell**: Taskbar, launcher, system tray, notifications
- **Theme System**: Design tokens, theme switching
- **State Management**: Global state, caching, offline support

#### Backend Server Layer

- **API Gateway**: Request routing, rate limiting, logging
- **Auth Service**: User authentication, authorization, RBAC
- **Host Service**: Host management, capability detection, pairing
- **Cloud Service**: Cloud storage, file sync, backup
- **App Service**: App store, installation, updates
- **Sync Service**: Multi-device sync, conflict resolution
- **AI Agent Service**: AI assistant with tool permission control

#### Host Agent Layer

- **Host Agent Core**: Main agent process, lifecycle management
- **Secure Pairing**: Device authentication and pairing
- **Host Discovery**: Capability detection, resource monitoring
- **PTY Service**: Terminal session management
- **FS Service**: Filesystem operations with security
- **Process Service**: Process monitoring and management
- **Resource Monitor**: CPU, RAM, disk, network metrics
- **Package Management**: Integration with apt, yum, dnf, etc.
- **Container Management**: Docker/Podman integration
- **OS Adapter**: Platform-specific implementations

### 1.3 Deployment Architectures

#### VPS Deployment (Primary Target)

```
Internet → Reverse Proxy (nginx) → Aether Backend + Host Agent → Host OS
             ├─ HTTPS (443)
             └─ WebSocket (WSS)
```

#### Local Host Deployment

```
Browser → Aether Backend (localhost) → Host Agent → Local OS
```

#### Remote Host Deployment

```
Browser → Aether Backend (Cloud) → Host Agent (Remote Host) → Remote OS
             (Secure tunnel/VPN)
```

### 1.4 Communication Flow

#### Desktop Initialization Flow

```
1. User opens browser → Aether Frontend
2. Frontend requests authentication
3. User logs in → Auth token issued
4. Frontend requests host list
5. User selects host (or auto-paired)
6. Backend initiates host connection
7. Host Agent responds with capability report
8. Frontend receives capabilities
9. Desktop shell initializes with available features
10. Apps load based on capabilities
```

#### Terminal Session Flow

```
1. User opens Terminal app
2. App requests PTY session from backend
3. Backend validates permission
4. Backend requests PTY from Host Agent
5. Host Agent creates PTY with shell
6. WebSocket connection established
7. Bidirectional stream: Browser ↔ Backend ↔ Agent ↔ PTY
8. User types command → sent to PTY
9. Output from PTY → streamed back to browser
10. Session maintained with heartbeat
```

#### Filesystem Operation Flow

```
1. User browses filesystem in Aether Files
2. App requests directory listing
3. Backend validates path and permission
4. Backend requests from Host Agent
5. Agent validates path (no traversal)
6. Agent reads directory with fs adapter
7. Result returned to frontend
8. Files displayed in UI
```

---

## 2. TECHNOLOGY STACK

### 2.1 Technology Selection Criteria

1. **Reliability**: Battle-tested in production environments
2. **Security**: Active maintenance, security patches
3. **Performance**: Suitable for resource-constrained VPS
4. **Developer Experience**: Good documentation, tooling, community
5. **Operational Simplicity**: Easy to deploy, monitor, debug
6. **License**: Open source, commercially friendly

### 2.2 Frontend Stack

**DECISION REQUIRED: Frontend Framework**

#### Option A: React + TypeScript (RECOMMENDED)

**Pros:**

- Mature ecosystem dengan banyak libraries
- Excellent TypeScript support
- Virtual DOM performance untuk complex UI
- Large community, banyak resources
- React Query untuk data fetching dan caching
- Zustand/Redux untuk state management
- Component reusability

**Cons:**

- Bundle size bisa besar jika tidak dioptimasi
- Requires build tooling
- Learning curve untuk state management

**Libraries:**

- React 18+ dengan concurrent features
- TypeScript 5+ untuk type safety
- Vite untuk build tool (fast HMR)
- React Query untuk server state
- Zustand untuk client state
- TanStack Virtual untuk windowing (large lists)
- xterm.js untuk terminal emulator
- Monaco Editor atau CodeMirror untuk code editor
- Tailwind CSS untuk styling
- Radix UI atau Headless UI untuk accessible components
- Framer Motion untuk animations
- React Router untuk routing

#### Option B: Svelte + TypeScript

**Pros:**

- Smaller bundle size
- No virtual DOM overhead
- Reactive by default
- Simpler state management
- Excellent performance

**Cons:**

- Smaller ecosystem
- Fewer UI component libraries
- Less mature tooling
- Smaller community

**Recommendation: Option A (React)** karena maturity, ecosystem, dan availability of
production-ready components untuk complex desktop UI.

---

### 2.3 Backend Stack

**DECISION REQUIRED: Backend Runtime**

#### Option A: Node.js + TypeScript + Express (RECOMMENDED)

**Pros:**

- Single language dengan frontend (TypeScript)
- Excellent WebSocket support (ws, socket.io)
- node-pty untuk PTY terminal yang mature
- Large ecosystem
- Fast development velocity
- Good untuk I/O-bound workloads (typical use case)
- Easier untuk share types dengan frontend

**Cons:**

- Single-threaded (mitigated dengan cluster mode)
- Garbage collection pauses
- Memory usage bisa lebih tinggi dari Go

**Stack:**

- Node.js 20 LTS
- TypeScript 5+
- Express.js untuk HTTP API
- ws atau socket.io untuk WebSocket
- node-pty untuk PTY
- passport.js untuk authentication
- helmet untuk security headers
- express-rate-limit untuk rate limiting
- winston untuk logging
- pg (node-postgres) untuk PostgreSQL
- ioredis untuk Redis
- zod untuk runtime validation
- bull atau bullmq untuk job queues

#### Option B: Go + Fiber/Echo

**Pros:**

- Excellent performance dan memory efficiency
- Built-in concurrency
- Static binary deployment
- Lower resource usage (penting untuk VPS)
- Strong typing

**Cons:**

- Different language dari frontend
- PTY library kurang mature (go-pty)
- Smaller web ecosystem vs Node.js
- Slower development untuk rapid iteration

**Recommendation: Option A (Node.js + TypeScript)** untuk MVP karena:

- node-pty adalah library PTY paling mature dan reliable
- Type sharing dengan frontend
- Faster development velocity
- Sufficient performance untuk target use case

**Future consideration:** Migrate Host Agent ke Go untuk better performance dan lower resource usage
setelah protocol stabilized.

---

### 2.4 Database

**DECISION REQUIRED: Primary Database**

#### Option A: PostgreSQL (RECOMMENDED)

**Pros:**

- Mature, reliable, production-tested
- ACID compliance
- JSON support untuk flexible schemas
- Full-text search
- Row-level security
- Excellent backup tools
- Free dan open source

**Cons:**

- Slightly higher resource usage
- More complex administration

#### Option B: SQLite

**Pros:**

- Zero configuration
- Single file database
- Very low resource usage
- Built-in backup (file copy)

**Cons:**

- Tidak cocok untuk concurrent writes
- Limited untuk multi-user scenarios
- Tidak ada network access

**Recommendation: PostgreSQL** karena:

- Multi-user support
- Concurrent access
- Better untuk production deployment
- Scalability untuk future growth

**Storage Breakdown:**

- **PostgreSQL**: Users, hosts, sessions, apps, audit logs, metadata
- **Redis**: Session cache, real-time presence, pub/sub, rate limiting
- **Object Storage (S3-compatible)**: Cloud files, backups, app packages, media

---

### 2.5 Host Agent

**DECISION REQUIRED: Host Agent Runtime**

#### Option A: Node.js + TypeScript

**Pros:**

- Code reuse dengan backend
- node-pty untuk PTY
- Easy deployment (npm install)
- Same tooling dan debugging

**Cons:**

- Higher memory footprint
- Slower startup

#### Option B: Go

**Pros:**

- Single binary deployment
- Lower memory usage (critical pada VPS)
- Fast startup
- Better resource efficiency
- Cross-compilation untuk Windows/Mac

**Cons:**

- PTY library kurang mature
- More complex untuk rapid iteration
- No code sharing dengan backend

**Recommendation untuk MVP: Node.js**, migrate ke Go later:

**Phase 1-6 (MVP)**: Node.js Host Agent

- Faster development
- Proven PTY support
- Code sharing dengan backend
- Easier debugging

**Phase 9+ (Production Hardening)**: Go Host Agent

- Rewrite agent core di Go
- Keep protocol compatible
- Better performance
- Lower resource usage
- Single binary distribution

---

### 2.6 Realtime Communication

**WebSocket (ws library)** untuk semua realtime communication:

- Terminal I/O
- File sync events
- Notification delivery
- Resource monitoring updates
- Presence status

**Protocol:**

- JSON-based message format
- Message types: `request`, `response`, `event`, `error`
- Request/response dengan correlation ID
- Event streaming untuk monitoring data
- Heartbeat setiap 30 seconds
- Automatic reconnection dengan exponential backoff

---

### 2.7 Development Tools

**Frontend:**

- Vite untuk dev server dan build
- ESLint + Prettier untuk code quality
- Vitest untuk unit testing
- Playwright untuk E2E testing
- Storybook untuk component development

**Backend:**

- tsx untuk development (fast TypeScript execution)
- ts-node untuk scripts
- nodemon untuk hot reload
- Jest untuk testing
- Supertest untuk API testing
- Docker Compose untuk local development environment

**Infrastructure:**

- Docker untuk containerization
- nginx untuk reverse proxy
- Let's Encrypt untuk SSL
- PM2 atau systemd untuk process management
- Prometheus + Grafana untuk monitoring (optional, later phase)

---

### 2.8 Technology Stack Summary

| Layer              | Technology    | Version        | Purpose            |
| ------------------ | ------------- | -------------- | ------------------ |
| Frontend Framework | React         | 18+            | UI library         |
| Frontend Language  | TypeScript    | 5+             | Type safety        |
| Frontend Build     | Vite          | 5+             | Build tool         |
| Frontend State     | Zustand       | 4+             | Client state       |
| Frontend Data      | React Query   | 5+             | Server state       |
| Frontend Styling   | Tailwind CSS  | 3+             | Utility CSS        |
| Terminal Emulator  | xterm.js      | 5+             | Terminal UI        |
| Code Editor        | Monaco Editor | Latest         | Code editing       |
| Backend Runtime    | Node.js       | 20 LTS         | Server runtime     |
| Backend Language   | TypeScript    | 5+             | Type safety        |
| Backend Framework  | Express.js    | 4+             | HTTP server        |
| WebSocket          | ws            | 8+             | Realtime           |
| PTY                | node-pty      | 1+             | Terminal           |
| Database           | PostgreSQL    | 16+            | Primary DB         |
| Cache              | Redis         | 7+             | Caching            |
| Object Storage     | MinIO/S3      | Compatible     | File storage       |
| ORM                | Prisma        | 5+             | Database ORM       |
| Validation         | Zod           | 3+             | Schema validation  |
| Authentication     | Passport.js   | Latest         | Auth middleware    |
| Logging            | Winston       | 3+             | Structured logs    |
| Job Queue          | BullMQ        | 5+             | Background jobs    |
| Host Agent         | Node.js → Go  | 20 LTS / 1.22+ | Host integration   |
| Reverse Proxy      | nginx         | 1.24+          | Load balancer      |
| Process Manager    | systemd       | System         | Service management |

---

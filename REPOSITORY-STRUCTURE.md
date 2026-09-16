# AETHER CLOUD OS - MONOREPO STRUCTURE PROPOSAL

**Version:** 1.0.0  
**Date:** 2026-09-15  
**Status:** Proposed (Pending Review)

---

## 📁 Repository Structure

```
aether-cloud-os/
│
├── .github/                           # GitHub specific files
│   ├── workflows/                     # CI/CD pipelines
│   │   ├── ci.yml                    # Main CI pipeline
│   │   ├── deploy.yml                # Deployment pipeline
│   │   └── security.yml              # Security scanning
│   ├── ISSUE_TEMPLATE/               # Issue templates
│   ├── PULL_REQUEST_TEMPLATE.md      # PR template
│   └── dependabot.yml                # Dependency updates
│
├── docs/                              # Documentation (existing)
│   ├── architecture/                 # Architecture docs (Phase 0)
│   ├── development/                  # Development guides (new)
│   └── api/                          # API documentation (new)
│
├── packages/                          # Monorepo packages
│   │
│   ├── frontend/                     # Aether Desktop (React)
│   │   ├── src/
│   │   │   ├── app/                  # App root
│   │   │   ├── components/           # Shared components
│   │   │   │   ├── desktop/          # Desktop shell
│   │   │   │   ├── window-manager/   # Window Manager
│   │   │   │   └── ui/               # UI primitives
│   │   │   ├── apps/                 # Built-in applications
│   │   │   │   ├── files/            # Aether Files
│   │   │   │   ├── terminal/         # Aether Terminal
│   │   │   │   ├── settings/         # Aether Settings
│   │   │   │   └── ...
│   │   │   ├── hooks/                # React hooks
│   │   │   ├── services/             # API services
│   │   │   ├── store/                # State management (Zustand)
│   │   │   ├── styles/               # Global styles
│   │   │   ├── types/                # TypeScript types
│   │   │   └── utils/                # Utility functions
│   │   ├── public/                   # Static assets
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── vite.config.ts
│   │   └── index.html
│   │
│   ├── backend/                      # Backend API Server (Node.js)
│   │   ├── src/
│   │   │   ├── index.ts              # Entry point
│   │   │   ├── app.ts                # Express app
│   │   │   ├── server.ts             # HTTP + WebSocket server
│   │   │   ├── config/               # Configuration
│   │   │   ├── middleware/           # Express middleware
│   │   │   ├── routes/               # API routes
│   │   │   │   ├── auth.routes.ts
│   │   │   │   ├── hosts.routes.ts
│   │   │   │   ├── filesystem.routes.ts
│   │   │   │   ├── terminal.routes.ts
│   │   │   │   └── ...
│   │   │   ├── services/             # Business logic
│   │   │   │   ├── auth.service.ts
│   │   │   │   ├── host.service.ts
│   │   │   │   ├── agent.service.ts
│   │   │   │   └── ...
│   │   │   ├── websocket/            # WebSocket handlers
│   │   │   ├── database/             # Database client
│   │   │   │   ├── client.ts         # Prisma client
│   │   │   │   └── migrations/       # Prisma migrations
│   │   │   ├── types/                # TypeScript types
│   │   │   └── utils/                # Utility functions
│   │   ├── prisma/
│   │   │   └── schema.prisma         # Database schema
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── nodemon.json
│   │
│   ├── agent/                        # Host Agent (Node.js -> Go later)
│   │   ├── src/
│   │   │   ├── index.ts              # Entry point
│   │   │   ├── agent.ts              # Agent core
│   │   │   ├── config/               # Configuration
│   │   │   ├── services/             # Agent services
│   │   │   │   ├── discovery.service.ts    # Host discovery
│   │   │   │   ├── pty.service.ts          # PTY management
│   │   │   │   ├── filesystem.service.ts   # FS operations
│   │   │   │   ├── process.service.ts      # Process monitoring
│   │   │   │   ├── resource.service.ts     # Resource monitoring
│   │   │   │   └── ...
│   │   │   ├── adapters/             # OS-specific adapters
│   │   │   │   ├── linux.adapter.ts
│   │   │   │   ├── windows.adapter.ts (future)
│   │   │   │   └── macos.adapter.ts (future)
│   │   │   ├── security/             # Security utilities
│   │   │   ├── websocket/            # WebSocket client
│   │   │   ├── types/                # TypeScript types
│   │   │   └── utils/                # Utility functions
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── nodemon.json
│   │
│   └── shared/                       # Shared code
│       ├── src/
│       │   ├── types/                # Shared TypeScript types
│       │   │   ├── api.types.ts      # API contracts
│       │   │   ├── websocket.types.ts # WebSocket messages
│       │   │   ├── host.types.ts     # Host capability types
│       │   │   ├── auth.types.ts     # Auth types
│       │   │   └── ...
│       │   ├── contracts/            # API contracts (Zod schemas)
│       │   ├── constants/            # Shared constants
│       │   ├── utils/                # Shared utilities
│       │   │   ├── validation.ts     # Input validation
│       │   │   ├── security.ts       # Security utilities
│       │   │   └── ...
│       │   └── errors/               # Error definitions
│       ├── package.json
│       └── tsconfig.json
│
├── scripts/                           # Build and deployment scripts
│   ├── dev.sh                        # Start all services in dev
│   ├── build.sh                      # Build all packages
│   ├── test.sh                       # Run all tests
│   ├── install-backend.sh            # Backend installer (Ubuntu)
│   ├── install-agent.sh              # Agent installer
│   └── setup-dev.sh                  # Setup development environment
│
├── docker/                            # Docker configurations
│   ├── Dockerfile.backend            # Backend production image
│   ├── Dockerfile.agent              # Agent production image
│   ├── Dockerfile.frontend           # Frontend nginx image
│   └── docker-compose.dev.yml        # Development environment
│
├── config/                            # Configuration files
│   ├── nginx/                        # nginx configs
│   │   ├── development.conf
│   │   └── production.conf
│   ├── systemd/                      # systemd service files
│   │   ├── aether-backend.service
│   │   └── aether-agent.service
│   └── ...
│
├── tests/                             # Integration and E2E tests
│   ├── integration/                  # Integration tests
│   ├── e2e/                          # End-to-end tests (Playwright)
│   └── fixtures/                     # Test fixtures
│
├── prototypes/                        # Technical prototypes
│   ├── pty-prototype/                # PTY + xterm.js prototype
│   ├── websocket-prototype/          # WebSocket reconnect prototype
│   ├── path-validation-prototype/    # Path security prototype
│   └── capability-prototype/         # Linux capability detection
│
├── .vscode/                           # VS Code workspace settings
│   ├── settings.json
│   ├── extensions.json
│   └── launch.json
│
├── .env.example                       # Environment variables template
├── .gitignore                         # Git ignore rules
├── .eslintrc.js                       # ESLint configuration (root)
├── .prettierrc.js                     # Prettier configuration (root)
├── package.json                       # Root package.json (workspaces)
├── pnpm-workspace.yaml               # PNPM workspace config
├── tsconfig.base.json                # Base TypeScript config
├── turbo.json                        # Turborepo config (optional)
├── LICENSE                           # License file (pending decision)
├── README.md                         # Main README (exists)
├── CONTRIBUTING.md                   # Contribution guidelines (new)
├── DECISION-LOG.md                   # Decision tracking (new)
├── OPEN-QUESTIONS.md                 # Open questions (new)
├── ARCHITECTURE-ASSUMPTIONS.md       # Architecture assumptions (new)
└── PHASE-1-READINESS.md              # Phase 1 readiness (new)
```

---

## 🎯 Key Design Decisions

### Monorepo Tool: PNPM Workspaces

**Choice:** PNPM Workspaces  
**Status:** Proposed  
**Rationale:**

- Fast, efficient disk usage
- Excellent monorepo support
- Better than npm workspaces
- Simpler than Yarn workspaces
- Native workspace protocol support

**Alternative Considered:** Turborepo + PNPM

- Turborepo adds caching and task orchestration
- Can be added later if build times become issue
- Not needed for MVP

### Package Structure

**Three main packages:**

1. `frontend` - React application
2. `backend` - Node.js API server
3. `agent` - Host Agent

**One shared package:** 4. `shared` - Types, contracts, utilities

**Why this structure:**

- Clear separation of concerns
- Type sharing via `shared` package
- Independent versioning possible
- Can deploy separately
- Easy to understand

### TypeScript Configuration

**Strategy:** Base config + package-specific overrides

- `tsconfig.base.json` - Root configuration
- Each package extends base
- Strict mode enabled
- Path aliases for imports
- Source maps for debugging

### Testing Strategy

**Unit tests:** Co-located with source

```
src/services/auth.service.ts
src/services/auth.service.test.ts
```

**Integration tests:** `tests/integration/` **E2E tests:** `tests/e2e/`

**Tools:**

- Frontend: Vitest + React Testing Library
- Backend: Jest + Supertest
- E2E: Playwright

### Development Workflow

**Local development:**

```bash
pnpm install              # Install all dependencies
pnpm dev                  # Start all services in dev mode
pnpm test                 # Run all tests
pnpm lint                 # Lint all packages
pnpm build                # Build all packages
```

**Package-specific:**

```bash
pnpm --filter frontend dev    # Start only frontend
pnpm --filter backend dev     # Start only backend
pnpm --filter agent dev       # Start only agent
```

---

## 📦 Package Dependencies

### Frontend Dependencies (Proposed)

```json
{
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "react-router-dom": "^6.20.0",
    "@tanstack/react-query": "^5.17.0",
    "zustand": "^4.4.7",
    "xterm": "^5.3.0",
    "xterm-addon-fit": "^0.8.0",
    "@monaco-editor/react": "^4.6.0",
    "@radix-ui/react-dialog": "^1.0.5",
    "@radix-ui/react-dropdown-menu": "^2.0.6",
    "tailwindcss": "^3.4.0",
    "axios": "^1.6.5",
    "zod": "^3.22.4"
  },
  "devDependencies": {
    "@types/react": "^18.2.48",
    "@types/react-dom": "^18.2.18",
    "@vitejs/plugin-react": "^4.2.1",
    "vite": "^5.0.11",
    "vitest": "^1.2.0",
    "@testing-library/react": "^14.1.2",
    "typescript": "^5.3.3"
  }
}
```

### Backend Dependencies (Proposed)

```json
{
  "dependencies": {
    "express": "^4.18.2",
    "ws": "^8.16.0",
    "@prisma/client": "^5.8.0",
    "ioredis": "^5.3.2",
    "passport": "^0.7.0",
    "passport-jwt": "^4.0.1",
    "jsonwebtoken": "^9.0.2",
    "argon2": "^0.31.2",
    "helmet": "^7.1.0",
    "express-rate-limit": "^7.1.5",
    "winston": "^3.11.0",
    "zod": "^3.22.4",
    "node-pty": "^1.0.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/ws": "^8.5.10",
    "@types/node": "^20.11.0",
    "prisma": "^5.8.0",
    "nodemon": "^3.0.2",
    "tsx": "^4.7.0",
    "jest": "^29.7.0",
    "supertest": "^6.3.4",
    "typescript": "^5.3.3"
  }
}
```

### Agent Dependencies (Proposed)

```json
{
  "dependencies": {
    "ws": "^8.16.0",
    "node-pty": "^1.0.0",
    "chokidar": "^3.5.3",
    "winston": "^3.11.0",
    "zod": "^3.22.4"
  },
  "devDependencies": {
    "@types/ws": "^8.5.10",
    "@types/node": "^20.11.0",
    "nodemon": "^3.0.2",
    "tsx": "^4.7.0",
    "jest": "^29.7.0",
    "typescript": "^5.3.3"
  }
}
```

### Shared Dependencies (Proposed)

```json
{
  "dependencies": {
    "zod": "^3.22.4"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "typescript": "^5.3.3"
  }
}
```

---

## 🔧 Configuration Files Needed

### Root Level

- [x] `package.json` - Root workspace config
- [x] `pnpm-workspace.yaml` - PNPM workspace definition
- [x] `tsconfig.base.json` - Base TypeScript config
- [ ] `.eslintrc.js` - ESLint rules
- [ ] `.prettierrc.js` - Prettier rules
- [ ] `.env.example` - Environment template
- [ ] `.gitignore` - Git ignore
- [ ] `docker-compose.dev.yml` - Development environment

### Per Package

- [ ] `package.json` - Package dependencies
- [ ] `tsconfig.json` - TypeScript config (extends base)

---

## ⚠️ Open Questions & Decisions Needed

### DECISION PENDING #1: Multi-tenancy

**Impact on structure:**

- If multi-user: Need organization/team tables in Prisma schema
- If single-user: Simpler user model
- **Recommendation:** Start with single-user, add multi-tenancy later
- **Action:** Document assumption, make schema extensible

### DECISION PENDING #2: License

**Impact on structure:**

- Need LICENSE file in root
- Need license headers in all source files
- **Recommendation:** Apache 2.0
- **Action:** Wait for stakeholder approval

### DECISION PENDING #3: Monorepo Tool

**Options:**

- PNPM Workspaces (simple, fast)
- Turborepo + PNPM (adds caching)
- Nx (powerful but complex)
- **Recommendation:** PNPM Workspaces for MVP
- **Action:** Can add Turborepo later if needed

---

## 📋 Next Steps

1. Get approval on structure
2. Create decision tracking documents
3. Generate all configuration files
4. Set up development environment
5. Create Docker Compose
6. Write development setup guide

**Status:** Proposed (Awaiting Review)  
**Last Updated:** 2026-09-15

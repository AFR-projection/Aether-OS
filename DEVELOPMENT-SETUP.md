# Development Setup Guide

Complete guide to set up Aether Cloud OS for local development.

## Prerequisites

- **Node.js** 20.x or higher
- **pnpm** 8.x or higher
- **Docker** and Docker Compose
- **Git**

### Platform-Specific Requirements

#### Windows
- Windows 10/11
- WSL2 (recommended for better Docker performance)
- Visual Studio Build Tools (for node-pty)

#### macOS
- macOS 10.15 or higher
- Xcode Command Line Tools

#### Linux
- Ubuntu 20.04+ / Debian 11+ / Fedora 35+
- build-essential package

## Quick Start

### 1. Clone the Repository

```bash
git clone https://github.com/yourusername/aether-cloud-os.git
cd aether-cloud-os
```

### 2. Install Dependencies

```bash
# Install pnpm if not already installed
npm install -g pnpm

# Install all package dependencies
pnpm install
```

### 3. Set Up Environment Variables

```bash
# Copy environment template
cp .env.example .env

# Edit .env and fill in required values
# At minimum, generate secure secrets:
openssl rand -base64 64  # For JWT_SECRET
openssl rand -hex 32     # For ENCRYPTION_KEY
```

### 4. Start Development Services

```bash
# Start PostgreSQL and Redis with Docker
docker-compose up -d

# Wait for services to be healthy
docker-compose ps
```

### 5. Initialize Database

The database is automatically initialized on first start. To verify:

```bash
# Connect to PostgreSQL
docker exec -it aether-postgres psql -U aether -d aether_dev

# Check tables
\dt aether.*
\q
```

### 6. Start Development Servers

```bash
# Start all packages in development mode
pnpm dev

# Or start individual packages
pnpm --filter @aether/backend dev
pnpm --filter @aether/frontend dev
```

## Package-Specific Setup

### Backend (@aether/backend)

```bash
cd packages/backend
pnpm dev
```

Server runs on `http://localhost:3000`

### Frontend (@aether/frontend)

```bash
cd packages/frontend
pnpm dev
```

Frontend runs on `http://localhost:5173`

### Host Agent (@aether/host-agent)

```bash
cd packages/host-agent
pnpm dev
```

### Desktop Client (@aether/desktop-client)

```bash
cd packages/desktop-client
pnpm dev
```

## Verification

### Check Backend

```bash
curl http://localhost:3000/health
```

Expected response: `{"status":"ok"}`

### Check Frontend

Open `http://localhost:5173` in your browser.

### Check Database

```bash
docker exec -it aether-postgres psql -U aether -d aether_dev -c "SELECT version();"
```

### Check Redis

```bash
docker exec -it aether-redis redis-cli ping
```

Expected response: `PONG`

## Common Issues

### Port Already in Use

```bash
# Check what's using the port
lsof -i :3000  # macOS/Linux
netstat -ano | findstr :3000  # Windows

# Kill the process or change the port in .env
```

### Docker Services Not Starting

```bash
# Check Docker status
docker-compose ps

# View logs
docker-compose logs postgres
docker-compose logs redis

# Restart services
docker-compose restart
```

### node-pty Build Failures

**Windows:**
```bash
npm install --global windows-build-tools
```

**macOS:**
```bash
xcode-select --install
```

**Linux:**
```bash
sudo apt-get install build-essential python3
```

### Database Connection Issues

```bash
# Restart PostgreSQL
docker-compose restart postgres

# Check connection string in .env
DATABASE_URL=postgresql://aether:aether_dev_password@localhost:5432/aether_dev
```

## Development Workflow

### Running Tests

```bash
# Run all tests
pnpm test

# Run tests for specific package
pnpm --filter @aether/backend test

# Run tests with coverage
pnpm test:coverage
```

### Linting and Formatting

```bash
# Lint all packages
pnpm lint

# Fix linting issues
pnpm lint:fix

# Format code
pnpm format
```

### Type Checking

```bash
# Check types for all packages
pnpm typecheck
```

### Building

```bash
# Build all packages
pnpm build

# Build specific package
pnpm --filter @aether/backend build
```

## IDE Setup

### VS Code (Recommended)

Recommended extensions:
- ESLint
- Prettier
- TypeScript Vue Plugin (Volar)
- Tailwind CSS IntelliSense

Settings are pre-configured in `.vscode/settings.json`

### Other IDEs

Configuration files are available for:
- WebStorm/IntelliJ IDEA (.idea/)
- Vim/Neovim (via LSP)

## Database Management

### Run Migrations (Future)

```bash
pnpm --filter @aether/backend migrate
```

### Seed Development Data

```bash
pnpm --filter @aether/backend seed
```

### Reset Database

```bash
docker-compose down -v
docker-compose up -d
```

## Debugging

### Backend Debugging

VS Code launch configuration is available in `.vscode/launch.json`

Or use:
```bash
node --inspect packages/backend/dist/index.js
```

### Frontend Debugging

Use browser DevTools or VS Code debugger with the browser extension.

## Next Steps

- Read [ARCHITECTURE-ASSUMPTIONS.md](./ARCHITECTURE-ASSUMPTIONS.md)
- Review [DECISION-LOG.md](./DECISION-LOG.md)
- Check [OPEN-QUESTIONS.md](./OPEN-QUESTIONS.md)
- See [REPOSITORY-STRUCTURE.md](./REPOSITORY-STRUCTURE.md)

## Getting Help

- Check documentation in `/docs`
- Review existing issues
- Ask in team chat
- Contact maintainers

## License

[To be determined]

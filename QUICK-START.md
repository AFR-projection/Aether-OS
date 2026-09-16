# Quick Start Guide

Get Aether Cloud OS running in 5 minutes.

## Prerequisites

- Node.js 20+
- pnpm 8+
- Docker & Docker Compose

## Setup Steps

### 1. Clone and Install

```bash
# Clone repository
git clone https://github.com/yourusername/aether-cloud-os.git
cd aether-cloud-os

# Install dependencies
pnpm install
```

### 2. Configure Environment

```bash
# Copy environment template
cp .env.example .env

# Generate secrets (Linux/macOS)
echo "JWT_SECRET=$(openssl rand -base64 64)" >> .env
echo "ENCRYPTION_KEY=$(openssl rand -hex 32)" >> .env
echo "SESSION_SECRET=$(openssl rand -base64 64)" >> .env
```

**Windows (PowerShell):**

```powershell
Add-Content .env "JWT_SECRET=$(([System.Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(64))))"
Add-Content .env "ENCRYPTION_KEY=$((1..32 | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) }) -join '')"
Add-Content .env "SESSION_SECRET=$(([System.Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(64))))"
```

### 3. Start Services

```bash
# Start PostgreSQL, Redis, MinIO
docker-compose up -d

# Verify services are running
docker-compose ps
```

### 4. Start Development

```bash
# Start all packages in development mode
pnpm dev

# Or start individual packages
pnpm --filter @aether/backend dev
pnpm --filter @aether/frontend dev
```

## Access Points

- **Frontend:** http://localhost:5173
- **Backend API:** http://localhost:3000
- **MinIO Console:** http://localhost:9001 (minioadmin/minioadmin)

## Verify Installation

### Check Backend

```bash
curl http://localhost:3000/health
# Expected: {"status":"ok"}
```

### Check Database

```bash
docker exec -it aether-postgres psql -U aether -d aether_dev -c "SELECT username FROM aether.users;"
# Expected: dev user listed
```

### Check Redis

```bash
docker exec -it aether-redis redis-cli ping
# Expected: PONG
```

## Development Workflow

### Run Tests

```bash
pnpm test
```

### Lint Code

```bash
pnpm lint
pnpm lint:fix
```

### Type Check

```bash
pnpm typecheck
```

### Build for Production

```bash
pnpm build
```

## Common Commands

```bash
# Stop all services
docker-compose down

# Reset database (warning: deletes all data)
docker-compose down -v
docker-compose up -d

# View logs
docker-compose logs -f postgres
docker-compose logs -f redis

# Clean everything
pnpm clean
docker-compose down -v
```

## Troubleshooting

### Port Already in Use

```bash
# Find process using port 3000
lsof -i :3000  # macOS/Linux
netstat -ano | findstr :3000  # Windows

# Change port in .env
PORT=3001
```

### Docker Not Starting

```bash
# Restart Docker daemon
# macOS: Restart Docker Desktop
# Linux: sudo systemctl restart docker
# Windows: Restart Docker Desktop

# Check Docker status
docker ps
```

### Database Connection Failed

```bash
# Restart PostgreSQL
docker-compose restart postgres

# Check connection string in .env
# DATABASE_URL=postgresql://aether:aether_dev_password@localhost:5432/aether_dev
```

### node-pty Build Error

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

## Next Steps

1. Read [DEVELOPMENT-SETUP.md](./DEVELOPMENT-SETUP.md) for detailed setup
2. Review [CODE-STANDARDS.md](./CODE-STANDARDS.md) before coding
3. Check [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution workflow
4. Explore [ARCHITECTURE-ASSUMPTIONS.md](./ARCHITECTURE-ASSUMPTIONS.md) for design decisions

## Getting Help

- Documentation: `/docs` directory
- Issues: GitHub Issues
- Architecture: `ARCHITECTURE-ASSUMPTIONS.md`
- Questions: `OPEN-QUESTIONS.md`

---

**Ready to code!** 🚀

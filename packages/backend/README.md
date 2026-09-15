# @aether/backend

Backend API server for Aether Cloud OS.

## Features

- RESTful API with Fastify
- WebSocket support for real-time communication
- PostgreSQL database with connection pooling
- Redis caching
- JWT authentication
- Rate limiting and security headers
- Terminal session management via node-pty

## Development

```bash
# Install dependencies
pnpm install

# Start development server
pnpm dev

# Build for production
pnpm build

# Run tests
pnpm test

# Type checking
pnpm typecheck

# Lint
pnpm lint
```

## Environment Variables

See `.env.example` in the root directory.

## Architecture

- `src/index.ts` - Application entry point
- `src/server.ts` - Fastify server setup
- `src/routes/` - API route handlers
- `src/services/` - Business logic
- `src/middleware/` - Custom middleware
- `src/utils/` - Utility functions
- `src/types/` - TypeScript type definitions

## API Documentation

API documentation will be available at `/docs` when the server is running.

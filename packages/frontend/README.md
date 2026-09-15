# @aether/frontend

React frontend for Aether Cloud OS.

## Features

- Modern React 18 with TypeScript
- Vite for fast development and optimized builds
- TanStack Query for server state management
- Zustand for client state management
- React Router for routing
- xterm.js for terminal emulation
- Tailwind CSS for styling
- Responsive design

## Development

```bash
# Install dependencies
pnpm install

# Start development server
pnpm dev

# Build for production
pnpm build

# Preview production build
pnpm preview

# Run tests
pnpm test

# Type checking
pnpm typecheck

# Lint
pnpm lint
```

## Architecture

- `src/main.tsx` - Application entry point
- `src/App.tsx` - Root component
- `src/pages/` - Page components
- `src/components/` - Reusable components
- `src/features/` - Feature-specific components
- `src/hooks/` - Custom React hooks
- `src/store/` - Zustand stores
- `src/api/` - API client and queries
- `src/types/` - TypeScript type definitions
- `src/utils/` - Utility functions

## Key Components

- **Terminal** - Full-featured terminal with xterm.js
- **FileExplorer** - Tree-based file browser
- **Editor** - Code editor integration
- **Dashboard** - System overview and metrics

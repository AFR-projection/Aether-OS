# @aether/shared

Shared types, utilities, and validation schemas used across Aether Cloud OS packages.

## Features

- TypeScript type definitions
- Zod validation schemas
- Shared constants and enums
- Utility functions
- Protocol definitions for WebSocket communication

## Usage

```typescript
import { User, ValidationSchemas, ApiResponse } from '@aether/shared';

// Use shared types
const user: User = { ... };

// Use validation schemas
const result = ValidationSchemas.user.parse(data);

// Use API response wrapper
const response: ApiResponse<User> = {
  success: true,
  data: user
};
```

## Development

```bash
# Build
pnpm build

# Run tests
pnpm test

# Type checking
pnpm typecheck

# Lint
pnpm lint
```

## Structure

- `src/types/` - TypeScript type definitions
- `src/schemas/` - Zod validation schemas
- `src/constants/` - Shared constants
- `src/utils/` - Utility functions
- `src/protocols/` - WebSocket protocol definitions

## Adding New Shared Code

When adding new shared code:

1. Ensure it's truly needed by multiple packages
2. Keep it framework-agnostic
3. Export from `src/index.ts`
4. Add appropriate tests
5. Document public APIs

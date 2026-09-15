# Code Standards

Code quality and style standards for Aether Cloud OS.

## General Principles

1. **Write Clear Code** - Code should be self-documenting when possible
2. **Consistency** - Follow established patterns in the codebase
3. **Simplicity** - Prefer simple solutions over clever ones
4. **Testing** - Write tests for new features and bug fixes
5. **Documentation** - Document complex logic and public APIs

## TypeScript Standards

### Strict Mode

All packages use TypeScript strict mode with additional checks:

```json
{
  "strict": true,
  "noUnusedLocals": true,
  "noUnusedParameters": true,
  "noFallthroughCasesInSwitch": true,
  "noUncheckedIndexedAccess": true
}
```

### Type Annotations

- Explicitly type function parameters and return values for public APIs
- Let TypeScript infer types for local variables when obvious
- Use `unknown` instead of `any` when type is truly unknown
- Prefer interfaces for object shapes, types for unions/intersections

**Good:**
```typescript
export function processUser(user: User): Promise<ProcessedUser> {
  const data = transformData(user); // inferred type
  return saveToDatabase(data);
}
```

**Avoid:**
```typescript
function processUser(user: any): any { // too loose
  // ...
}
```

### Null Safety

- Use optional chaining (`?.`) and nullish coalescing (`??`)
- Avoid `!` non-null assertions unless absolutely certain
- Handle null/undefined explicitly

```typescript
// Good
const name = user?.profile?.name ?? 'Anonymous';

// Avoid
const name = user!.profile!.name; // risky
```

## Naming Conventions

### Files and Folders

- Use kebab-case for file and folder names: `user-service.ts`
- React components: PascalCase: `UserProfile.tsx`
- Test files: match source file with `.test.ts` or `.spec.ts`

### Variables and Functions

- camelCase for variables and functions: `userName`, `getUserData()`
- PascalCase for classes and types: `UserService`, `ApiResponse<T>`
- UPPER_SNAKE_CASE for constants: `MAX_RETRY_COUNT`, `API_BASE_URL`
- Prefix booleans with `is`, `has`, `should`: `isActive`, `hasPermission`
- Prefix async functions with action verbs: `fetchUser()`, `saveData()`

### React Components

```typescript
// Component files - PascalCase
UserProfile.tsx

// Component naming
export function UserProfile({ userId }: UserProfileProps) {
  // ...
}

// Props interface
interface UserProfileProps {
  userId: string;
  onUpdate?: (user: User) => void;
}
```

## Code Organization

### File Structure

Keep files focused and under 300 lines when possible:

```typescript
// 1. Imports (grouped and sorted)
import { useState } from 'react';
import { fetchUser } from '@/api';
import type { User } from '@aether/shared';

// 2. Types and interfaces
interface Props {
  // ...
}

// 3. Constants
const MAX_RETRIES = 3;

// 4. Component/function
export function MyComponent() {
  // ...
}

// 5. Helper functions (if small and component-specific)
function helperFunction() {
  // ...
}
```

### Import Order

ESLint enforces this order:

1. Built-in Node modules
2. External dependencies
3. Internal modules
4. Parent/sibling imports
5. Index imports
6. Type imports

```typescript
import fs from 'fs';
import { fastify } from 'fastify';
import { config } from '@/config';
import { getUserById } from '../users';
import type { User } from '@aether/shared';
```

## Error Handling

### Backend

Use proper error classes:

```typescript
// Define custom errors
export class ValidationError extends Error {
  constructor(message: string, public field: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

// Use try-catch with specific handling
try {
  await processUser(data);
} catch (error) {
  if (error instanceof ValidationError) {
    return reply.status(400).send({ error: error.message });
  }
  throw error; // re-throw unexpected errors
}
```

### Frontend

Handle errors at appropriate boundaries:

```typescript
// Use error boundaries for React
<ErrorBoundary fallback={<ErrorPage />}>
  <App />
</ErrorBoundary>

// Handle async errors
try {
  const user = await fetchUser(id);
  setUser(user);
} catch (error) {
  setError(error instanceof Error ? error.message : 'Unknown error');
}
```

## Async/Await

- Always use `async/await` over raw Promises
- Handle promise rejections
- Use `Promise.all()` for parallel operations
- Use `Promise.allSettled()` when some failures are acceptable

```typescript
// Good - parallel execution
const [users, posts] = await Promise.all([
  fetchUsers(),
  fetchPosts()
]);

// Avoid - sequential when parallel is possible
const users = await fetchUsers();
const posts = await fetchPosts();
```

## Comments and Documentation

### When to Comment

- Complex algorithms or business logic
- Non-obvious workarounds
- Public APIs and exported functions
- TODO/FIXME with context

```typescript
/**
 * Validates terminal command against security policies.
 * 
 * @param command - The command string to validate
 * @param context - User context with permissions
 * @returns true if command is allowed
 * @throws SecurityError if command is blocked
 */
export async function validateCommand(
  command: string,
  context: UserContext
): Promise<boolean> {
  // Check against blocklist first (performance)
  if (BLOCKED_COMMANDS.has(command)) {
    throw new SecurityError('Command not allowed');
  }
  
  // TODO: Add regex pattern matching for partial blocks
  return true;
}
```

### Avoid Obvious Comments

```typescript
// Bad - states the obvious
// Set the user name
user.name = name;

// Good - explains why
// Keep legacy format for backwards compatibility
user.name = normalizeLegacyName(name);
```

## Testing Standards

### Test Structure

```typescript
describe('UserService', () => {
  describe('getUserById', () => {
    it('should return user when found', async () => {
      // Arrange
      const userId = '123';
      const mockUser = { id: userId, name: 'Test' };
      
      // Act
      const result = await getUserById(userId);
      
      // Assert
      expect(result).toEqual(mockUser);
    });
    
    it('should throw NotFoundError when user does not exist', async () => {
      // Arrange
      const userId = 'nonexistent';
      
      // Act & Assert
      await expect(getUserById(userId)).rejects.toThrow(NotFoundError);
    });
  });
});
```

### Test Coverage

- Aim for 80%+ code coverage
- Test edge cases and error paths
- Mock external dependencies
- Test public APIs, not implementation details

## React Best Practices

### Component Design

- Keep components small and focused
- Extract reusable logic to custom hooks
- Use composition over props drilling
- Prefer function components with hooks

```typescript
// Good - focused component
export function UserAvatar({ user }: { user: User }) {
  return (
    <img 
      src={user.avatar} 
      alt={user.name}
      className="rounded-full w-10 h-10"
    />
  );
}

// Good - custom hook for logic
function useUser(userId: string) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  
  useEffect(() => {
    fetchUser(userId).then(setUser).finally(() => setLoading(false));
  }, [userId]);
  
  return { user, loading };
}
```

### State Management

- Local state with `useState` for component-specific state
- Context for app-wide theme, auth, etc.
- Zustand for complex client state
- TanStack Query for server state

```typescript
// Local state
const [count, setCount] = useState(0);

// Server state with TanStack Query
const { data: user, isLoading } = useQuery({
  queryKey: ['user', userId],
  queryFn: () => fetchUser(userId)
});

// Global client state with Zustand
const useStore = create<Store>((set) => ({
  theme: 'dark',
  setTheme: (theme) => set({ theme })
}));
```

## Performance

### Backend

- Use connection pooling for databases
- Cache frequently accessed data in Redis
- Use streaming for large responses
- Index database queries properly

### Frontend

- Lazy load routes and heavy components
- Memoize expensive computations with `useMemo`
- Debounce/throttle expensive operations
- Use virtual scrolling for long lists

```typescript
// Lazy loading
const Terminal = lazy(() => import('./Terminal'));

// Memoization
const sortedUsers = useMemo(
  () => users.sort((a, b) => a.name.localeCompare(b.name)),
  [users]
);

// Debouncing
const debouncedSearch = useDebouncedCallback(
  (value: string) => performSearch(value),
  300
);
```

## Security

### Input Validation

Always validate and sanitize user input:

```typescript
import { z } from 'zod';

const UserSchema = z.object({
  username: z.string().min(3).max(50).regex(/^[a-zA-Z0-9_]+$/),
  email: z.string().email(),
  age: z.number().int().min(13).max(120)
});

// Validate before use
const userData = UserSchema.parse(request.body);
```

### SQL Injection Prevention

Use parameterized queries:

```typescript
// Good - parameterized
const result = await db.query(
  'SELECT * FROM users WHERE id = $1',
  [userId]
);

// NEVER - string concatenation
const result = await db.query(
  `SELECT * FROM users WHERE id = '${userId}'` // DANGEROUS!
);
```

### XSS Prevention

- Sanitize HTML content
- Use Content Security Policy
- React escapes by default, but be careful with `dangerouslySetInnerHTML`

## Git Practices

### Commit Messages

Follow conventional commits:

```
type(scope): subject

body (optional)

footer (optional)
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`

Examples:
```
feat(terminal): add command history support
fix(auth): prevent token refresh race condition
docs(readme): update installation instructions
```

### Branch Names

```
feature/short-description
bugfix/issue-number-description
hotfix/critical-issue
```

Examples:
```
feature/websocket-reconnect
bugfix/123-terminal-crash
hotfix/security-vulnerability
```

## Code Review

### As Author

- Keep PRs focused and reasonably sized
- Write clear PR descriptions
- Respond to feedback constructively
- Test your changes thoroughly

### As Reviewer

- Be respectful and constructive
- Focus on code quality, not style preferences
- Ask questions rather than demanding changes
- Approve when ready, request changes when needed

## Resources

- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
- [React Documentation](https://react.dev/)
- [Fastify Documentation](https://fastify.dev/)
- [Node.js Best Practices](https://github.com/goldbergyoni/nodebestpractices)

---

**Remember:** These are guidelines, not rigid rules. Use good judgment and prioritize code that works, is maintainable, and serves users well.

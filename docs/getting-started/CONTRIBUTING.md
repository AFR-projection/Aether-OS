# Contributing to Aether Cloud OS

## Getting started

1. Read the [README](../../README.md) for the project overview.
2. Set up a development environment: [DEVELOPMENT.md](DEVELOPMENT.md).
3. Read the code standards: [CODE-STANDARDS.md](../reference/CODE-STANDARDS.md).
4. Check existing issues and PRs before starting work.

```bash
git clone https://github.com/YOUR_USERNAME/Aether-cloud-os.git
cd Aether-cloud-os
pnpm install
git checkout -b feature/your-feature-name
```

## Development workflow

1. **Branch** — `feature/description`, `bugfix/issue-123`, `hotfix/critical-fix`, `docs/topic`.
2. **Change** — focused commits, follow the code standards, add tests for new functionality.
3. **Verify** — all four must pass before you commit:

   ```bash
   pnpm typecheck
   pnpm lint
   pnpm test
   pnpm build
   ```

   `pnpm build` matters even for non-frontend changes: the frontend consumes `@aether/shared`, and a
   stale shared build produces errors that look like they come from somewhere else entirely. See
   [DEVELOPMENT.md](DEVELOPMENT.md#build-order-matters).

4. **Commit** — [Conventional Commits](https://www.conventionalcommits.org/):

   | Type       | Use for                                    |
   | ---------- | ------------------------------------------ |
   | `feat`     | New feature                                |
   | `fix`      | Bug fix                                    |
   | `docs`     | Documentation                              |
   | `style`    | Formatting only                            |
   | `refactor` | Code change that is neither fix nor feature |
   | `test`     | Tests                                      |
   | `chore`    | Maintenance, dependencies                  |
   | `perf`     | Performance                                |
   | `ci`       | CI/CD                                      |

## Pull requests

Before submitting:

- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm build` all pass
- [ ] Documentation updated where behaviour changed
- [ ] No new lint warnings
- [ ] Branch rebased on current `main`

A PR should be focused. One feature or one fix; a PR that fixes five things gets reviewed five times
as slowly.

**Security issues are never PRs and never public issues.** See
[SECURITY-MODEL.md](../security/SECURITY-MODEL.md#reporting-a-vulnerability).

## Coding guidelines

The full standard lives in [CODE-STANDARDS.md](../reference/CODE-STANDARDS.md). The rules that get
enforced in review:

- TypeScript strict mode; `unknown` over `any`.
- Zod validation on every route input.
- Parameterized SQL only — never string-concatenate a query.
- Layering: routes never contain business logic; services never touch `request`/`reply`.
- React: function components with hooks, TanStack Query for server state, Zustand for client state.
- Errors: throw typed `AppError` subclasses on the backend; the error handler classifies them.

## Testing

Required for new features, bug fixes, and anything in `packages/backend/src/services` or
`packages/shared/src/utils`.

- Unit tests beside the file they test: `foo.test.ts` next to `foo.ts`.
- Mock external dependencies (database, cache, WebSocket).
- Test the error paths, not just the happy path.

```bash
pnpm test              # everything
pnpm --filter @aether/backend test   # one package
```

## Documentation

Documentation lives in [`docs/`](../README.md) and nowhere else. If your change alters behaviour,
update the doc that describes it — `API.md` for endpoints, `CONFIGURATION.md` for env vars,
`DEPLOYMENT.md` for installer behaviour. A doc that describes yesterday's system is worse than none.

## Recognition

Contributors are credited in release notes.

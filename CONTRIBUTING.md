# Contributing to Aether Cloud OS

Thank you for your interest in contributing to Aether Cloud OS! This document provides guidelines
and instructions for contributing.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Pull Request Process](#pull-request-process)
- [Coding Guidelines](#coding-guidelines)
- [Testing Requirements](#testing-requirements)
- [Documentation](#documentation)
- [Issue Reporting](#issue-reporting)

## Code of Conduct

### Our Standards

- Be respectful and inclusive
- Welcome newcomers and help them learn
- Focus on what is best for the community
- Show empathy towards others
- Accept constructive criticism gracefully

### Unacceptable Behavior

- Harassment, discrimination, or trolling
- Publishing others' private information
- Personal or political attacks
- Any conduct that could reasonably be considered inappropriate

## Getting Started

### Prerequisites

1. Read the [README.md](./README.md) for project overview
2. Follow the [DEVELOPMENT-SETUP.md](./DEVELOPMENT-SETUP.md) guide
3. Review [CODE-STANDARDS.md](./CODE-STANDARDS.md)
4. Check existing issues and PRs to avoid duplication

### Setting Up Your Environment

```bash
# Fork the repository on GitHub
# Clone your fork
git clone https://github.com/YOUR_USERNAME/aether-cloud-os.git
cd aether-cloud-os

# Add upstream remote
git remote add upstream https://github.com/ORIGINAL_OWNER/aether-cloud-os.git

# Install dependencies
pnpm install

# Create a feature branch
git checkout -b feature/your-feature-name
```

## Development Workflow

### 1. Choose or Create an Issue

- Browse [open issues](../../issues)
- Comment on an issue to claim it
- For new features, create an issue first to discuss

### 2. Create a Branch

Branch naming convention:

```
feature/description    # New features
bugfix/issue-123      # Bug fixes
hotfix/critical-fix   # Urgent production fixes
docs/update-readme    # Documentation updates
refactor/module-name  # Code refactoring
```

```bash
git checkout -b feature/your-feature-name
```

### 3. Make Your Changes

- Write clear, focused commits
- Follow [CODE-STANDARDS.md](./CODE-STANDARDS.md)
- Add tests for new functionality
- Update documentation as needed

### 4. Test Your Changes

```bash
# Run tests
pnpm test

# Run linter
pnpm lint

# Type check
pnpm typecheck

# Test the build
pnpm build
```

### 5. Commit Your Changes

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```bash
# Format: type(scope): subject

git commit -m "feat(terminal): add command history navigation"
git commit -m "fix(auth): resolve token refresh race condition"
git commit -m "docs(api): update WebSocket protocol documentation"
```

**Commit Types:**

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, no logic change)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Maintenance tasks, dependencies
- `perf`: Performance improvements
- `ci`: CI/CD changes

### 6. Keep Your Branch Updated

```bash
# Fetch latest changes
git fetch upstream

# Rebase your branch
git rebase upstream/main

# Resolve conflicts if any
# Push to your fork
git push origin feature/your-feature-name --force-with-lease
```

## Pull Request Process

### Before Submitting

- [ ] All tests pass locally
- [ ] Code follows style guidelines
- [ ] Documentation is updated
- [ ] Commit messages follow conventions
- [ ] Branch is up to date with main
- [ ] No merge conflicts

### Creating a Pull Request

1. Push your branch to your fork
2. Go to the original repository
3. Click "New Pull Request"
4. Select your branch
5. Fill out the PR template

### PR Template

```markdown
## Description

Brief description of what this PR does.

## Type of Change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as
      expected)
- [ ] Documentation update
- [ ] Refactoring (no functional changes)

## Related Issues

Closes #123 Related to #456

## How Has This Been Tested?

Describe the tests you ran and how to reproduce them.

## Screenshots (if applicable)

Add screenshots for UI changes.

## Checklist

- [ ] My code follows the project's code standards
- [ ] I have performed a self-review of my code
- [ ] I have commented my code, particularly in hard-to-understand areas
- [ ] I have made corresponding changes to the documentation
- [ ] My changes generate no new warnings
- [ ] I have added tests that prove my fix is effective or that my feature works
- [ ] New and existing unit tests pass locally with my changes
- [ ] Any dependent changes have been merged and published
```

### Review Process

1. **Automated Checks**: CI/CD must pass
2. **Code Review**: At least one maintainer approval required
3. **Testing**: Reviewers may test your changes
4. **Feedback**: Address review comments
5. **Approval**: Once approved, a maintainer will merge

### After Your PR is Merged

```bash
# Switch to main branch
git checkout main

# Pull latest changes
git pull upstream main

# Delete your feature branch
git branch -d feature/your-feature-name
git push origin --delete feature/your-feature-name
```

## Coding Guidelines

### TypeScript

- Use TypeScript strict mode
- Avoid `any` type - use `unknown` if needed
- Explicitly type function parameters and returns for public APIs
- Let TypeScript infer types for local variables

### Code Style

- Follow ESLint and Prettier configurations
- Run `pnpm lint:fix` before committing
- Keep functions small and focused
- Use meaningful variable names
- Comment complex logic

### React Components

- Use function components with hooks
- Keep components under 300 lines
- Extract logic into custom hooks
- Use proper TypeScript types for props

### Backend Code

- Validate all inputs with Zod schemas
- Use parameterized queries (prevent SQL injection)
- Handle errors appropriately
- Log important operations

## Testing Requirements

### Unit Tests

Required for:

- New features
- Bug fixes
- Utility functions
- Business logic

```typescript
describe('MyFunction', () => {
  it('should handle valid input', () => {
    const result = myFunction('valid');
    expect(result).toBe('expected');
  });

  it('should throw error for invalid input', () => {
    expect(() => myFunction('invalid')).toThrow();
  });
});
```

### Integration Tests

Required for:

- API endpoints
- Database operations
- WebSocket communication

### Test Coverage

- Aim for 80%+ coverage
- All edge cases should be tested
- Error paths must be tested

## Documentation

### Code Documentation

- Document public APIs with JSDoc
- Add inline comments for complex logic
- Keep README files updated

```typescript
/**
 * Processes user authentication request.
 *
 * @param credentials - User login credentials
 * @returns Authentication token and user data
 * @throws AuthenticationError if credentials are invalid
 */
export async function authenticate(credentials: Credentials): Promise<AuthResult> {
  // Implementation
}
```

### Documentation Files

Update when relevant:

- `README.md` - Project overview
- `DEVELOPMENT-SETUP.md` - Setup instructions
- `CODE-STANDARDS.md` - Coding standards
- `ARCHITECTURE-ASSUMPTIONS.md` - Architecture decisions
- Package-specific READMEs

## Issue Reporting

### Bug Reports

Use the bug report template and include:

- **Description**: Clear description of the bug
- **Steps to Reproduce**: Numbered steps to reproduce
- **Expected Behavior**: What should happen
- **Actual Behavior**: What actually happens
- **Environment**: OS, Node version, browser, etc.
- **Screenshots**: If applicable
- **Additional Context**: Any other relevant information

Example:

```markdown
## Bug Description

Terminal crashes when pasting large text blocks.

## Steps to Reproduce

1. Open terminal
2. Copy >10KB of text
3. Paste into terminal
4. Terminal becomes unresponsive

## Expected Behavior

Text should be pasted and processed normally.

## Actual Behavior

Terminal freezes and must be restarted.

## Environment

- OS: Windows 11
- Browser: Chrome 120
- Aether version: 0.1.0
```

### Feature Requests

Include:

- **Feature Description**: Clear description
- **Use Case**: Why is this needed?
- **Proposed Solution**: How might it work?
- **Alternatives Considered**: Other approaches
- **Additional Context**: Mockups, examples, etc.

### Security Issues

**DO NOT** open public issues for security vulnerabilities.

Instead:

1. Email security@aether-os.io (if available)
2. Provide detailed description
3. Wait for response before disclosure

## Questions?

- Check [Documentation](./docs)
- Review [OPEN-QUESTIONS.md](./OPEN-QUESTIONS.md)
- Ask in discussions or team chat
- Contact maintainers

## Recognition

Contributors will be:

- Listed in CONTRIBUTORS.md
- Credited in release notes
- Acknowledged in project documentation

## License

By contributing, you agree that your contributions will be licensed under the same license as the
project.

---

Thank you for contributing to Aether Cloud OS! 🚀

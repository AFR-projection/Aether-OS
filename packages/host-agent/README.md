# @aether/host-agent

Host agent for Aether Cloud OS that runs on the user's local machine to provide secure access to
local resources.

## Features

- WebSocket connection to Aether backend
- Secure terminal access via node-pty
- File system operations with path validation
- System information reporting
- Auto-reconnect with exponential backoff
- Secure pairing mechanism

## Installation

```bash
# Install globally
npm install -g @aether/host-agent

# Or run directly with npx
npx @aether/host-agent
```

## Usage

```bash
# Start the agent
aether-agent start

# Pair with Aether Cloud OS
aether-agent pair

# Check status
aether-agent status

# Stop the agent
aether-agent stop
```

## Development

```bash
# Install dependencies
pnpm install

# Start development mode
pnpm dev

# Build
pnpm build

# Run tests
pnpm test

# Type checking
pnpm typecheck
```

## Security

- All connections are authenticated with API keys
- Path access is restricted to user's home directory
- Commands are sandboxed to user permissions
- TLS encryption for all WebSocket communication
- Regular security audits

## Architecture

- `src/index.ts` - Main entry point
- `src/cli.ts` - CLI commands
- `src/agent.ts` - Core agent logic
- `src/connection.ts` - WebSocket connection management
- `src/terminal.ts` - Terminal session handling
- `src/filesystem.ts` - File system operations
- `src/security.ts` - Security utilities

## Configuration

Configuration is stored in `~/.aether/agent-config.json`

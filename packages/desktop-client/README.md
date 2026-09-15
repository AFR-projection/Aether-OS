# @aether/desktop-client

Electron desktop application for Aether Cloud OS.

## Features

- Native desktop experience with Electron
- System tray integration
- Auto-updates
- Native notifications
- Deep system integration
- Offline mode support

## Development

```bash
# Install dependencies
pnpm install

# Start development mode
pnpm dev

# Build for production
pnpm build

# Preview build
pnpm preview

# Run tests
pnpm test

# Type checking
pnpm typecheck
```

## Building

```bash
# Build for current platform
pnpm build

# Build for specific platform
pnpm build:win
pnpm build:mac
pnpm build:linux
```

## Architecture

- `src/main/` - Main process code
- `src/preload/` - Preload scripts
- `src/renderer/` - Renderer process (UI)
- `resources/` - App icons and resources

## Distribution

Built applications are output to `dist/` directory.

## Platform Support

- Windows 10/11 (x64, arm64)
- macOS 10.15+ (x64, arm64)
- Linux (x64, arm64)

## Features Roadmap

- [ ] System tray with quick actions
- [ ] Global keyboard shortcuts
- [ ] Native file picker integration
- [ ] Auto-updater
- [ ] Deep linking support
- [ ] Native notifications

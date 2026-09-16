# Aether Cloud OS

**Your Cloud. Your Desktop. Anywhere.**

A universal browser-based desktop environment for VPS and local hosts. Access and operate your Linux
VPS through a modern desktop interface in your browser, with real terminal, filesystem access, and
extensible application runtime.

---

## 🎯 Vision

Aether Cloud OS transforms headless VPS into fully-featured desktop environments accessible from any
browser. No more SSH-only access—get a complete graphical interface with window management, file
explorer, terminal, and applications.

**This is not a mockup.** Aether provides:

- Real PTY terminal executing commands on your host
- Actual filesystem access (not simulated)
- Host resource monitoring (real CPU, RAM, disk data)
- Extensible application runtime
- Multi-device access with cloud sync
- AI assistant with controlled host access

---

## ✨ Features

### Core Desktop Environment

- **Window Manager** - Full-featured window management with minimize, maximize, resize, snap, and
  tile
- **Multiple Themes** - Aether Modern, Windows-inspired, and macOS-inspired themes
- **Taskbar/Dock** - Application launcher, running apps, system tray
- **Notifications** - System-wide notification center
- **Multi-device** - Access your desktop from any device with sync

### Host Integration

- **Real Terminal** - PTY-based terminal with real shell execution (bash, zsh, PowerShell)
- **Filesystem Access** - Browse, edit, upload, download files on your host
- **Process Management** - View and manage running processes
- **Resource Monitoring** - Real-time CPU, RAM, disk, and network monitoring
- **Service Management** - Start, stop, and restart system services
- **Package Management** - Install and manage packages (apt, yum, brew, winget)
- **Container Support** - Docker/Podman integration

### Built-in Applications

- **Aether Files** - Full-featured file manager
- **Aether Terminal** - Multi-tab terminal emulator
- **Aether Code Studio** - Code editor with syntax highlighting
- **Aether Settings** - Configuration center
- **Aether Task Manager** - Process and resource viewer
- **Aether System Monitor** - Real-time resource graphs
- **Aether Browser** - Web browsing capability
- **Aether App Store** - Discover and install apps

### Cloud Features

- **Cloud Storage** - S3-backed cloud storage with sync
- **Multi-device Sync** - File sync across devices
- **Offline Mode** - PWA with offline capabilities
- **Backup & Recovery** - Automatic backups

### Security

- **Secure Authentication** - JWT with 2FA support
- **Host Pairing** - Secure agent pairing with API keys
- **Permission System** - Role-based access control (RBAC)
- **Audit Logging** - Complete audit trail
- **Encrypted Storage** - Sensitive data encrypted at rest
- **TLS/WSS** - All communications encrypted

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    BROWSER (Any Device)                      │
│                     Aether Desktop UI                        │
└────────────────────────┬─────────────────────────────────────┘
                         │ HTTPS/WSS
┌────────────────────────┴─────────────────────────────────────┐
│                   Aether Backend Server                      │
│  API Gateway │ Auth │ Host Service │ Cloud Storage │ Apps   │
└────────────────────────┬─────────────────────────────────────┘
                         │ Secure WebSocket
┌────────────────────────┴─────────────────────────────────────┐
│                    Aether Host Agent                         │
│  PTY │ Filesystem │ Processes │ Resources │ Services        │
└────────────────────────┬─────────────────────────────────────┘
                         │
┌────────────────────────┴─────────────────────────────────────┐
│                    Native Host OS                            │
│         Linux │ Windows │ macOS                              │
└─────────────────────────────────────────────────────────────┘
```

**Technology Stack:**

- **Frontend:** React 18 + TypeScript + Vite + Tailwind CSS
- **Backend:** Node.js 20 + Express + TypeScript
- **Database:** PostgreSQL 16 + Redis 7
- **Storage:** S3-compatible (AWS S3, MinIO, Cloudflare R2)
- **Host Agent:** Node.js (MVP) → Go (production)
- **Terminal:** xterm.js + node-pty
- **Real-time:** WebSocket (ws library)

---

## 📋 System Requirements

### Backend Server (VPS)

**Minimum:**

- OS: Ubuntu 22.04 LTS or 24.04 LTS
- CPU: 2 vCPU cores
- RAM: 4 GB
- Storage: 20 GB SSD
- Network: 100 Mbps

**Recommended (10-50 users):**

- OS: Ubuntu 24.04 LTS
- CPU: 4 vCPU cores
- RAM: 8 GB
- Storage: 100 GB SSD
- Network: 1 Gbps

### Host Agent

- **Linux:** Ubuntu 22.04+, Debian 11+, CentOS 8+
- **Windows:** Windows 10+ (Phase 9)
- **macOS:** macOS 12+ (Phase 9)
- RAM: 512 MB (dedicated to agent)
- Storage: 200 MB

### Browser

- Chrome/Edge 90+
- Firefox 88+
- Safari 14+
- Mobile browsers supported

---

## 🚀 Quick Start

### 1. Install Aether Backend (Ubuntu VPS)

```bash
# Download and run installer
curl -fsSL https://install.aether-os.io/install.sh | sudo bash

# Follow prompts to configure
# - Database setup
# - SSL certificate (Let's Encrypt)
# - Admin user creation
```

### 2. Install Host Agent

**On the same VPS (manage itself):**

```bash
curl -fsSL https://install.aether-os.io/agent.sh | sudo bash
```

**On another Linux host:**

```bash
# Download agent
wget https://releases.aether-os.io/agent/latest/aether-agent-linux-x64.tar.gz
tar -xzf aether-agent-linux-x64.tar.gz
cd aether-agent

# Install
sudo ./install.sh

# Get pairing code
sudo aether-agent pair
```

### 3. Access Aether Desktop

1. Open browser: `https://your-domain.com` or `https://your-vps-ip`
2. Login with admin credentials
3. Add host with pairing code
4. Desktop loads with available features

---

## 📖 Documentation

Comprehensive documentation is available in `docs/`:

- **[Master Architecture](docs/architecture/00-MASTER-ARCHITECTURE.md)** - Complete system
  architecture
- **[Desktop & Window Manager](docs/architecture/05-DESKTOP-WINDOW-MANAGER.md)** - UI and window
  management
- **[Application Runtime](docs/architecture/06-APPLICATION-RUNTIME.md)** - App system and built-in
  apps
- **[Security & Auth](docs/architecture/09-SECURITY-AUTH.md)** - Authentication and security model
- **[Database & API](docs/architecture/12-DATABASE-API-STORAGE.md)** - Database schema and API specs
- **[Deployment & Operations](docs/architecture/14-DEPLOYMENT-ROADMAP.md)** - Installation and
  maintenance
- **[Risk & Decisions](docs/architecture/16-RISK-DECISIONS.md)** - Architecture decisions and risk
  management

---

## 🗺️ Roadmap

### Phase 0 - Architecture & Design ✅ (Current)

Complete technical architecture and design specifications.

### Phase 1 - Foundation (3 weeks)

Repository setup, CI/CD, authentication, basic infrastructure.

### Phase 2 - Linux Host Agent (4 weeks)

Functional Host Agent for Linux with PTY, filesystem, and monitoring.

### Phase 3 - Desktop Shell (3 weeks)

Desktop UI with window manager and core components.

### Phase 4 - Terminal & Filesystem (4 weeks)

Real PTY terminal and host filesystem integration.

### Phase 5 - Core Applications (4 weeks)

Files, Terminal, Settings, Task Manager, System Monitor apps.

### Phase 6 - Application Runtime (3 weeks)

App store, installation, and extensibility system.

### Phase 7 - Cloud Storage & Sync (4 weeks)

Cloud storage with multi-device sync and offline support.

### Phase 8 - AI Agent (3 weeks)

AI assistant with controlled tool access.

### Phase 9 - Platform Expansion (4 weeks)

Windows and macOS host agent support.

### Phase 10 - Production Hardening (6 weeks)

Security audit, load testing, documentation, monitoring.

**Total Timeline:** 6-9 months to production release

---

## 🔒 Security

Security is a first-class concern:

- **Transport Security:** TLS 1.3 for all communications
- **Authentication:** JWT with refresh tokens, optional 2FA
- **Authorization:** Role-based access control (RBAC)
- **Input Validation:** Schema validation at every layer
- **Path Security:** Path traversal prevention with allowlists
- **Command Safety:** No arbitrary command execution
- **Audit Logging:** Complete audit trail for sensitive operations
- **Secret Management:** Argon2id password hashing, encrypted storage
- **Rate Limiting:** Protection against brute force and abuse
- **Sandboxing:** Apps run with limited permissions

See [Security Documentation](docs/architecture/09-SECURITY-AUTH.md) for details.

---

## 🤝 Contributing

**Current Status:** Architecture phase - not yet accepting contributions.

Once Phase 1 begins, we'll open for contributions with:

- Contribution guidelines
- Code of conduct
- Development setup guide
- Issue templates

---

## 📄 License

[License TBD - To be determined before Phase 1]

Options under consideration:

- MIT License (permissive)
- Apache 2.0 (permissive with patent grant)
- AGPL 3.0 (copyleft, requires source disclosure)

---

## 🔗 Links

- **Website:** [aether-os.io](https://aether-os.io) (coming soon)
- **Documentation:** [docs.aether-os.io](https://docs.aether-os.io) (coming soon)
- **Community:** [community.aether-os.io](https://community.aether-os.io) (coming soon)
- **Status:** [status.aether-os.io](https://status.aether-os.io) (coming soon)

---

## ❓ FAQ

### Is this just a web app that looks like a desktop?

No. Aether provides real functionality:

- Terminal executes actual commands on your host via PTY
- File manager accesses your real host filesystem
- System Monitor shows actual CPU, RAM, disk usage
- Process Manager shows real running processes

### Can I use this in production?

Not yet. We're currently in Phase 0 (Architecture). Production-ready release is expected in 6-9
months.

### What's the difference between Aether and VNC/RDP?

- **VNC/RDP:** Streams a full desktop (high bandwidth, not browser-native)
- **Aether:** Native browser UI that integrates with host (low bandwidth, modern web UI)

### What's the difference between Aether and web-based terminals?

- **Web terminals:** Just a terminal, nothing else
- **Aether:** Full desktop environment with file manager, apps, window management, etc.

### Does Aether replace my VPS operating system?

No. Aether is a **desktop environment layer** on top of your existing OS. Your VPS still runs
Ubuntu/Linux. Aether provides a graphical interface to interact with it.

### Is my data secure?

Yes, with proper deployment:

- All traffic encrypted (HTTPS/WSS)
- Authentication required
- Permissions enforced
- Audit logging
- Regular security audits (production)

### Can I self-host everything?

Yes. Aether is designed to be fully self-hostable:

- Backend on your VPS
- Database (PostgreSQL) on your VPS
- Storage (MinIO) on your VPS or S3
- No phone-home, no telemetry by default

### What about mobile access?

Aether works on mobile browsers and can be installed as a PWA. Touch-optimized UI is planned for
later phases.

### Can I extend Aether with custom apps?

Yes. Aether has an Application Runtime that allows:

- Installing apps from App Store
- Developing custom apps with Aether API
- Extension system (planned)

---

## 🙏 Acknowledgments

Aether Cloud OS is inspired by:

- **WebOS** - Browser-based desktop concept
- **VS Code** - Modern web-based development environment
- **Docker** - Container paradigm for application isolation
- **Jupyter** - Web-based interactive computing
- **tmux/screen** - Terminal session management

Technologies we leverage:

- **xterm.js** - Terminal emulator
- **node-pty** - PTY binding
- **React** - UI framework
- **PostgreSQL** - Database
- **Prisma** - ORM

---

## 📊 Project Status

**Phase:** 0 - Architecture & Design  
**Status:** In Progress (80%)  
**Next Milestone:** Complete architecture review  
**Target:** Begin Phase 1 implementation

**Architecture Documents:** ✅ Complete  
**UI/UX Mockups:** 🚧 In Progress  
**Development Environment:** ⏳ Pending Phase 1  
**MVP Deployment:** ⏳ Target: Q2 2027

---

**Built with ❤️ for developers who love their VPS but want a better interface.**

# AETHER CLOUD OS - APPLICATION RUNTIME & BUILT-IN APPS

**Part of:** Comprehensive Architecture Document  
**Version:** 1.0.0  
**Date:** 2026-09-15

---

## 6. APPLICATION RUNTIME

### 6.1 Application Runtime Architecture

The Application Runtime provides a standardized way to develop, install, and run applications on
Aether.

```
┌─────────────────────────────────────────────────────────────┐
│                   APPLICATION RUNTIME                        │
├─────────────────────────────────────────────────────────────┤
│  App Lifecycle Manager                                       │
│  ├─ App Registration & Discovery                            │
│  ├─ App Installation & Updates                              │
│  ├─ App Launch & Termination                                │
│  └─ App State Management                                     │
├─────────────────────────────────────────────────────────────┤
│  Permission System                                           │
│  ├─ Permission Manifest Validation                          │
│  ├─ Runtime Permission Checks                               │
│  ├─ User Permission Grants/Denials                          │
│  └─ Audit Logging                                           │
├─────────────────────────────────────────────────────────────┤
│  App Sandbox                                                 │
│  ├─ Scoped Storage (per-app data directory)                 │
│  ├─ API Access Control                                      │
│  ├─ Resource Limits (memory, CPU)                           │
│  └─ Network Policy                                          │
├─────────────────────────────────────────────────────────────┤
│  App API (exposed to apps)                                  │
│  ├─ Window API (create, manage windows)                     │
│  ├─ Storage API (app data, preferences)                     │
│  ├─ Filesystem API (with permissions)                       │
│  ├─ Notification API                                        │
│  ├─ Clipboard API                                           │
│  ├─ Theme API (design tokens)                               │
│  ├─ Host Capability API (detect features)                   │
│  └─ IPC API (inter-app communication)                       │
├─────────────────────────────────────────────────────────────┤
│  App Store                                                   │
│  ├─ App Catalog & Search                                    │
│  ├─ App Metadata & Reviews                                  │
│  ├─ Installation Management                                 │
│  ├─ Update Management                                       │
│  └─ Dependency Resolution                                   │
└─────────────────────────────────────────────────────────────┘
```

### 6.2 App Manifest

Every Aether app must have a manifest defining its metadata, permissions, and requirements.

```typescript
interface AppManifest {
  // Identity
  id: string; // unique, reverse domain notation: "com.aether.files"
  name: string; // display name
  version: string; // semver: "1.0.0"
  description: string;
  author: {
    name: string;
    email?: string;
    url?: string;
  };

  // Visual
  icon: string; // path to icon (SVG or PNG)
  screenshots?: string[];

  // Technical
  type: 'web-app' | 'iframe-app' | 'native-bridge-app';
  entryPoint: string; // main HTML file or JS module

  // Window configuration
  window?: {
    defaultWidth?: number;
    defaultHeight?: number;
    minWidth?: number;
    minHeight?: number;
    maxWidth?: number;
    maxHeight?: number;
    resizable?: boolean;
    minimizable?: boolean;
    maximizable?: boolean;
    transparent?: boolean; // transparent background
  };

  // Permissions requested
  permissions: AppPermission[];

  // Capabilities required
  requiredCapabilities?: {
    terminal?: boolean;
    filesystem?: boolean;
    containers?: boolean;
    gpu?: boolean;
    [key: string]: boolean;
  };

  // Dependencies
  dependencies?: {
    apps?: string[]; // other app IDs
    runtime?: {
      node?: string; // ">= 18.0.0"
      browser?: string; // "chrome >= 90"
    };
  };

  // Lifecycle
  autoStart?: boolean; // start with desktop
  singleton?: boolean; // only one instance allowed
  background?: boolean; // run without window

  // App Store
  category?: 'productivity' | 'development' | 'utilities' | 'system' | 'media' | 'other';
  tags?: string[];
  license?: string;
  homepage?: string;
  repository?: string;

  // Internal
  manifestVersion: '1.0';
}

type AppPermission =
  | 'filesystem.read'
  | 'filesystem.write'
  | 'filesystem.delete'
  | 'terminal.create'
  | 'terminal.attach'
  | 'process.list'
  | 'process.kill'
  | 'host.resources.read'
  | 'host.services.read'
  | 'host.services.manage'
  | 'host.packages.install'
  | 'host.containers.manage'
  | 'network.fetch' // fetch from internet
  | 'storage.unlimited' // unlimited app storage
  | 'notifications.send'
  | 'clipboard.read'
  | 'clipboard.write'
  | 'camera.access'
  | 'microphone.access';
```

**Example: Aether Files Manifest**

```json
{
  "id": "com.aether.files",
  "name": "Aether Files",
  "version": "1.0.0",
  "description": "File manager for Aether Cloud OS",
  "author": {
    "name": "Aether Team",
    "url": "https://aether-os.io"
  },
  "icon": "/apps/files/icon.svg",
  "type": "web-app",
  "entryPoint": "/apps/files/index.html",
  "window": {
    "defaultWidth": 900,
    "defaultHeight": 600,
    "minWidth": 600,
    "minHeight": 400,
    "resizable": true
  },
  "permissions": [
    "filesystem.read",
    "filesystem.write",
    "filesystem.delete",
    "clipboard.read",
    "clipboard.write",
    "notifications.send"
  ],
  "requiredCapabilities": {
    "filesystem": true
  },
  "singleton": false,
  "category": "system",
  "manifestVersion": "1.0"
}
```

### 6.3 App Lifecycle

```typescript
enum AppState {
  NOT_INSTALLED = 'not_installed',
  INSTALLING = 'installing',
  INSTALLED = 'installed',
  UPDATING = 'updating',
  RUNNING = 'running',
  SUSPENDED = 'suspended',
  UNINSTALLING = 'uninstalling',
  ERROR = 'error',
}

interface AppInstance {
  appId: string;
  instanceId: string;
  state: AppState;
  windows: string[]; // window IDs
  startedAt: string;
  lastActiveAt: string;
  memoryUsage?: number;
  permissions: {
    granted: AppPermission[];
    denied: AppPermission[];
  };
}

class AppRuntime {
  private apps: Map<string, AppManifest> = new Map();
  private instances: Map<string, AppInstance> = new Map();

  // Install app
  async install(packageUrl: string): Promise<void> {
    // 1. Download package
    const pkg = await this.downloadPackage(packageUrl);

    // 2. Validate manifest
    const manifest = await this.validateManifest(pkg.manifest);

    // 3. Check dependencies
    await this.checkDependencies(manifest);

    // 4. Check capability requirements
    const caps = await this.getHostCapabilities();
    if (!this.meetsRequirements(manifest, caps)) {
      throw new Error('Host does not meet app requirements');
    }

    // 5. Extract files to app directory
    const appDir = `/apps/${manifest.id}`;
    await this.extractPackage(pkg, appDir);

    // 6. Register app
    this.apps.set(manifest.id, manifest);

    // 7. Save to database
    await api.saveApp(manifest);

    this.emit('app.installed', manifest);
  }

  // Launch app
  async launch(appId: string, args?: any): Promise<string> {
    const manifest = this.apps.get(appId);
    if (!manifest) throw new Error(`App ${appId} not installed`);

    // Check singleton
    if (manifest.singleton) {
      const existing = this.getRunningInstance(appId);
      if (existing) {
        // Focus existing window
        if (existing.windows[0]) {
          windowManager.focusWindow(existing.windows[0]);
        }
        return existing.instanceId;
      }
    }

    // Create instance
    const instanceId = `${appId}_${nanoid()}`;
    const instance: AppInstance = {
      appId,
      instanceId,
      state: AppState.RUNNING,
      windows: [],
      startedAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      permissions: {
        granted: [],
        denied: [],
      },
    };

    this.instances.set(instanceId, instance);

    // Request permissions on first launch
    const granted = await this.requestPermissions(manifest.permissions);
    instance.permissions.granted = granted;

    // Create window
    const window = windowManager.createWindow({
      appId: manifest.id,
      title: manifest.name,
      icon: manifest.icon,
      initialSize: {
        width: manifest.window?.defaultWidth || 800,
        height: manifest.window?.defaultHeight || 600,
      },
      resizable: manifest.window?.resizable ?? true,
      minimizable: manifest.window?.minimizable ?? true,
      maximizable: manifest.window?.maximizable ?? true,
    });

    instance.windows.push(window.id);

    // Load app content
    await this.loadApp(instanceId, manifest, window.id, args);

    this.emit('app.launched', { appId, instanceId });

    return instanceId;
  }

  // Terminate app
  async terminate(instanceId: string): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (!instance) return;

    // Close all windows
    for (const windowId of instance.windows) {
      windowManager.closeWindow(windowId);
    }

    // Cleanup resources
    await this.cleanupAppResources(instanceId);

    // Remove instance
    this.instances.delete(instanceId);

    this.emit('app.terminated', { instanceId, appId: instance.appId });
  }

  // Update app
  async update(appId: string): Promise<void> {
    const manifest = this.apps.get(appId);
    if (!manifest) throw new Error(`App ${appId} not installed`);

    // Check for updates
    const latest = await api.checkAppUpdate(appId, manifest.version);
    if (!latest || latest.version === manifest.version) {
      return; // already up to date
    }

    // Terminate running instances
    const running = this.getRunningInstances(appId);
    for (const instance of running) {
      await this.terminate(instance.instanceId);
    }

    // Backup current version
    await this.backupApp(appId);

    try {
      // Install new version
      await this.install(latest.packageUrl);
    } catch (error) {
      // Rollback on failure
      await this.rollbackApp(appId);
      throw error;
    }
  }

  // Uninstall app
  async uninstall(appId: string): Promise<void> {
    // Terminate running instances
    const running = this.getRunningInstances(appId);
    for (const instance of running) {
      await this.terminate(instance.instanceId);
    }

    // Remove app data (with user confirmation)
    const userConfirmed = await this.confirmDataDeletion(appId);
    if (userConfirmed) {
      await this.deleteAppData(appId);
    }

    // Remove app files
    const appDir = `/apps/${appId}`;
    await fs.rm(appDir, { recursive: true });

    // Unregister
    this.apps.delete(appId);
    await api.deleteApp(appId);

    this.emit('app.uninstalled', appId);
  }
}
```

### 6.4 App Sandbox & Storage

Each app gets isolated storage and controlled API access.

```typescript
interface AppSandbox {
  appId: string;

  // Scoped storage directories
  storage: {
    data: string; // /home/user/.aether/apps/{appId}/data
    cache: string; // /home/user/.aether/apps/{appId}/cache
    temp: string; // /tmp/aether/{appId}
    config: string; // /home/user/.aether/apps/{appId}/config
  };

  // Resource limits
  limits: {
    memory: number; // bytes
    disk: number; // bytes
    cpu: number; // percentage (0-100)
    network: number; // bytes per second
  };

  // API access control
  allowedApis: Set<string>;

  // Network policy
  network: {
    allowedDomains?: string[]; // whitelist
    blockedDomains?: string[]; // blacklist
  };
}

class AppSandboxManager {
  private sandboxes: Map<string, AppSandbox> = new Map();

  async createSandbox(appId: string, manifest: AppManifest): Promise<AppSandbox> {
    const baseDir = `/home/${user}/.aether/apps/${appId}`;

    // Create directories
    await fs.mkdir(`${baseDir}/data`, { recursive: true });
    await fs.mkdir(`${baseDir}/cache`, { recursive: true });
    await fs.mkdir(`${baseDir}/config`, { recursive: true });

    const sandbox: AppSandbox = {
      appId,
      storage: {
        data: `${baseDir}/data`,
        cache: `${baseDir}/cache`,
        temp: `/tmp/aether/${appId}`,
        config: `${baseDir}/config`,
      },
      limits: {
        memory: 512 * 1024 * 1024, // 512 MB default
        disk: manifest.permissions.includes('storage.unlimited') ? Infinity : 100 * 1024 * 1024, // 100 MB default
        cpu: 50, // 50% of one core
        network: 10 * 1024 * 1024, // 10 MB/s
      },
      allowedApis: new Set(manifest.permissions),
      network: {
        allowedDomains: manifest.permissions.includes('network.fetch')
          ? undefined // allow all if permission granted
          : [], // deny all
      },
    };

    this.sandboxes.set(appId, sandbox);
    return sandbox;
  }

  // Check if app can access API
  canAccessApi(appId: string, apiName: string): boolean {
    const sandbox = this.sandboxes.get(appId);
    if (!sandbox) return false;

    return sandbox.allowedApis.has(apiName);
  }

  // Validate filesystem path is within app sandbox
  validatePath(
    appId: string,
    path: string
  ): {
    valid: boolean;
    resolvedPath?: string;
    reason?: string;
  } {
    const sandbox = this.sandboxes.get(appId);
    if (!sandbox) {
      return { valid: false, reason: 'Sandbox not found' };
    }

    const resolved = path.resolve(path);

    // Check if within any allowed directory
    const allowedRoots = Object.values(sandbox.storage);
    const withinSandbox = allowedRoots.some((root) => resolved.startsWith(root));

    if (!withinSandbox) {
      return {
        valid: false,
        reason: 'Path outside app sandbox',
      };
    }

    return { valid: true, resolvedPath: resolved };
  }

  // Monitor resource usage
  async monitorResources(appId: string): Promise<void> {
    const sandbox = this.sandboxes.get(appId);
    if (!sandbox) return;

    // Memory monitoring
    setInterval(async () => {
      const instances = appRuntime.getRunningInstances(appId);

      for (const instance of instances) {
        const usage = await this.getMemoryUsage(instance.instanceId);

        if (usage > sandbox.limits.memory) {
          // Terminate or warn
          this.emit('app.exceeded.memory', { appId, usage, limit: sandbox.limits.memory });

          // Could auto-terminate or suspend
          // await appRuntime.terminate(instance.instanceId);
        }
      }
    }, 10000); // check every 10s
  }
}
```

### 6.5 App API

Apps interact with Aether through a standardized API exposed via window object or message passing.

```typescript
// Exposed to apps as window.AetherAPI

interface AetherAPI {
  // Window management
  window: {
    setTitle(title: string): void;
    setIcon(iconUrl: string): void;
    close(): void;
    minimize(): void;
    maximize(): void;
    restore(): void;
    resize(width: number, height: number): void;
    move(x: number, y: number): void;
    on(event: WindowEvent, callback: Function): void;
  };

  // Storage (scoped to app)
  storage: {
    get(key: string): Promise<any>;
    set(key: string, value: any): Promise<void>;
    delete(key: string): Promise<void>;
    keys(): Promise<string[]>;
    clear(): Promise<void>;
  };

  // Filesystem (requires permission)
  fs: {
    readFile(path: string): Promise<ArrayBuffer>;
    writeFile(path: string, data: ArrayBuffer | string): Promise<void>;
    readdir(path: string): Promise<FileEntry[]>;
    mkdir(path: string): Promise<void>;
    unlink(path: string): Promise<void>;
    stat(path: string): Promise<FileStats>;
    // ... other fs operations
  };

  // Notifications
  notifications: {
    send(options: {
      title: string;
      body: string;
      icon?: string;
      action?: { label: string; callback: Function };
    }): Promise<string>; // notification ID
    close(id: string): void;
  };

  // Clipboard
  clipboard: {
    read(): Promise<string>;
    write(text: string): Promise<void>;
    readImage(): Promise<Blob>;
    writeImage(blob: Blob): Promise<void>;
  };

  // Theme
  theme: {
    getTokens(): DesignTokens;
    getCurrent(): string; // theme name
    onChange(callback: (theme: string) => void): void;
  };

  // Host capabilities
  host: {
    getCapabilities(): Promise<HostCapabilityReport>;
    getResources(): Promise<ResourceInfo>;
    onResourceUpdate(callback: (resources: ResourceInfo) => void): void;
  };

  // Terminal (requires permission)
  terminal: {
    create(options: TerminalOptions): Promise<TerminalSession>;
  };

  // Inter-app communication
  ipc: {
    send(targetAppId: string, message: any): Promise<void>;
    on(callback: (message: any, sourceAppId: string) => void): void;
  };

  // App info
  app: {
    getId(): string;
    getManifest(): AppManifest;
    getVersion(): string;
  };
}

// Implementation (in runtime)
function createAppAPI(appId: string, instanceId: string): AetherAPI {
  return {
    window: {
      setTitle: (title: string) => {
        const instance = appRuntime.getInstance(instanceId);
        if (!instance) return;

        const windowId = instance.windows[0];
        if (windowId) {
          windowManager.setTitle(windowId, title);
        }
      },

      close: () => {
        appRuntime.terminate(instanceId);
      },

      // ... other window methods
    },

    storage: {
      get: async (key: string) => {
        const sandbox = sandboxManager.getSandbox(appId);
        const dataFile = `${sandbox.storage.data}/${key}.json`;

        try {
          const content = await fs.readFile(dataFile, 'utf-8');
          return JSON.parse(content);
        } catch {
          return undefined;
        }
      },

      set: async (key: string, value: any) => {
        const sandbox = sandboxManager.getSandbox(appId);
        const dataFile = `${sandbox.storage.data}/${key}.json`;

        // Check storage quota
        const usage = await sandboxManager.getStorageUsage(appId);
        if (usage > sandbox.limits.disk) {
          throw new Error('Storage quota exceeded');
        }

        await fs.writeFile(dataFile, JSON.stringify(value), 'utf-8');
      },

      // ... other storage methods
    },

    fs: {
      readFile: async (path: string) => {
        // Check permission
        if (!sandboxManager.canAccessApi(appId, 'filesystem.read')) {
          throw new Error('Permission denied: filesystem.read');
        }

        // Validate path is in workspace or sandbox
        const validation = validateFsPath(appId, path);
        if (!validation.valid) {
          throw new Error(validation.reason);
        }

        // Read file via Host Agent
        return await hostAgent.fs.readFile(validation.resolvedPath);
      },

      // ... other fs methods with permission checks
    },

    notifications: {
      send: async (options) => {
        if (!sandboxManager.canAccessApi(appId, 'notifications.send')) {
          throw new Error('Permission denied: notifications.send');
        }

        return await notificationService.send({
          ...options,
          sourceApp: appId,
        });
      },
    },

    // ... other API implementations
  };
}
```

### 6.6 App Loading

Apps are loaded in isolated contexts (iframe or web worker depending on type).

```typescript
async function loadApp(instanceId: string, manifest: AppManifest, windowId: string, args?: any) {
  const sandbox = sandboxManager.getSandbox(manifest.id);
  const api = createAppAPI(manifest.id, instanceId);

  if (manifest.type === 'web-app') {
    // Load in iframe with sandboxed context
    const iframe = document.createElement('iframe');
    iframe.sandbox = 'allow-scripts allow-same-origin';
    iframe.src = `/apps/${manifest.id}/${manifest.entryPoint}`;

    // Inject API
    iframe.onload = () => {
      iframe.contentWindow.AetherAPI = api;
      iframe.contentWindow.postMessage(
        {
          type: 'aether.init',
          args,
        },
        '*'
      );
    };

    // Mount iframe in window content area
    const windowContent = document.querySelector(`#window-${windowId} .window-content`);
    windowContent.appendChild(iframe);
  } else if (manifest.type === 'iframe-app') {
    // External URL in iframe
    const iframe = document.createElement('iframe');
    iframe.sandbox = 'allow-scripts allow-same-origin allow-forms';
    iframe.src = manifest.entryPoint; // external URL

    // Limited API for iframe apps
    // ...
  }
}
```

---

## 7. BUILT-IN APPLICATIONS

### 7.1 Application Overview

Built-in apps that come with Aether Cloud OS.

| App                   | Priority | Complexity | Dependencies             |
| --------------------- | -------- | ---------- | ------------------------ |
| Aether Files          | **MVP**  | Medium     | filesystem               |
| Aether Terminal       | **MVP**  | High       | terminal PTY             |
| Aether Settings       | **MVP**  | Medium     | -                        |
| Aether Task Manager   | **MVP**  | Low        | processes                |
| Aether System Monitor | **MVP**  | Medium     | resources                |
| Aether Code Studio    | Phase 2  | High       | filesystem, terminal     |
| Aether Browser        | Phase 3  | Very High  | remote browser or iframe |
| Aether Documents      | Phase 3  | Medium     | storage                  |
| Aether Media Player   | Phase 3  | Medium     | filesystem               |
| Aether App Store      | Phase 2  | Medium     | -                        |

### 7.2 Aether Files

Full-featured file manager.

**Features:**

- Tree view + list view + grid view
- Breadcrumb navigation
- Context menu (right-click)
- Drag and drop
- Multi-select
- Cut/copy/paste
- Upload/download
- File preview (text, images, PDF)
- Search
- Sort and filter
- Hidden files toggle
- File properties
- Permissions view (Linux)
- Keyboard shortcuts

**Implementation Notes:**

- Use virtual scrolling for large directories
- Lazy load thumbnails
- Cache directory listings
- Debounce search input
- Show progress for large operations
- Handle conflicts (file exists)

### 7.3 Aether Terminal

Real PTY terminal emulator.

**Features:**

- Multiple tabs
- Split panes (horizontal/vertical)
- Color schemes
- Font size adjustment
- Scrollback search
- Copy/paste
- Link detection
- Session reconnection
- Session history
- Custom profiles (shell, env, cwd)

**Implementation:**

- Use xterm.js with addons
- WebSocket for PTY data
- Binary data transfer
- Handle ANSI escape sequences
- Resize on window resize
- Persist open tabs (optional)

### 7.4 Aether Settings

Central configuration UI.

**Sections:**

- **Account**: Profile, password, security
- **Appearance**: Theme, wallpaper, fonts
- **Desktop**: Taskbar position, icon size, animations
- **Host**: Connected hosts, capabilities, pairing
- **Applications**: Installed apps, permissions, defaults
- **Storage**: Usage, quota, cloud sync
- **Notifications**: Preferences, do not disturb
- **Privacy**: Data collection, audit log
- **Security**: Sessions, devices, 2FA
- **Advanced**: Developer mode, experiments

### 7.5 Aether Task Manager

Process and app monitoring.

**Features:**

- Running apps list
- Process list (if permission)
- CPU usage per process
- Memory usage per process
- Kill process (with confirmation)
- Filter and search
- Auto-refresh
- Sort by usage

**Limitations:**

- Can only see processes from agent's user context
- Killing system processes requires elevation
- Some process info may be restricted

### 7.6 Aether System Monitor

Real-time resource monitoring.

**Widgets:**

- CPU usage graph (multi-core)
- Memory usage (RAM + swap)
- Disk usage per mount point
- Network I/O (if available)
- Process count
- Uptime
- Load average (Linux)

**Features:**

- Time range selector (1m, 5m, 15m, 1h)
- Export data
- Alert thresholds (optional)

### 7.7 Aether Code Studio

Code editor for developers.

**Features:**

- Syntax highlighting (major languages)
- File tree explorer
- Multiple tabs
- Search and replace
- Go to definition (LSP - later)
- Integrated terminal
- Git integration
- Run tasks
- Extension support (later)

**Technology:**

- Monaco Editor (VS Code's editor)
- Or CodeMirror 6

**Limitations:**

- Not a full IDE initially
- No debugger in MVP
- No built-in LSP (can add later)

### 7.8 Aether Browser

Web browser within Aether.

**Approach 1: Simple iframe wrapper (MVP)**

- Load external URLs in sandboxed iframe
- Basic navigation (back, forward, refresh, URL bar)
- Bookmarks
- Limitations: Same-origin restrictions, limited APIs

**Approach 2: Remote browser (Later)**

- Headless Chromium on host
- Stream rendered output to frontend
- Full browser engine capabilities
- Higher resource usage
- Requires additional service

**DECISION REQUIRED:** MVP should use Approach 1 (iframe wrapper) for external sites. Remote browser
is Phase 7+ enhancement for full browser capabilities.

### 7.9 Aether Documents

Simple document editor.

**Features:**

- Rich text editing (Markdown or WYSIWYG)
- Auto-save to cloud storage
- Document list
- Search
- Export (PDF, HTML)

**Technology:**

- Lexical (Meta's text editor framework)
- Or TipTap (ProseMirror-based)
- Or Markdown editor (simpler)

### 7.10 Aether Media Player

Audio and video playback.

**Features:**

- Play audio/video from filesystem
- Playlist support
- Controls (play, pause, seek, volume)
- Supported formats: browser-native (MP3, MP4, WebM, etc.)

**Limitations:**

- Cannot play formats browser doesn't support natively
- No transcoding in MVP
- No streaming from remote sources initially

### 7.11 Aether App Store

Discover and install apps.

**Features:**

- Browse categories
- Search apps
- App details (description, screenshots, reviews)
- Install/uninstall
- Update all apps
- Permissions review before install
- Rating and reviews (later)

**Backend:**

- App catalog database
- App package hosting (S3/CDN)
- Version management
- Dependency resolution
- Signature verification (later)

---

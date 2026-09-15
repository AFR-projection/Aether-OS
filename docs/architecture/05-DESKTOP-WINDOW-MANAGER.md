# AETHER CLOUD OS - DESKTOP & WINDOW MANAGER

**Part of:** Comprehensive Architecture Document  
**Version:** 1.0.0  
**Date:** 2026-09-15

---

## 5. DESKTOP & WINDOW MANAGER

### 5.1 Desktop Shell Architecture

The Desktop Shell is the core UI that users interact with - taskbar, launcher, system tray, notifications.

```
┌─────────────────────────────────────────────────────────────┐
│                      DESKTOP SHELL                           │
├─────────────────────────────────────────────────────────────┤
│  Components:                                                 │
│  ├─ Wallpaper Manager                                       │
│  ├─ Desktop Icons (shortcuts, files)                        │
│  ├─ Taskbar / Dock                                          │
│  │   ├─ App Launcher Button (Start Menu)                   │
│  │   ├─ Pinned Apps                                         │
│  │   ├─ Running Apps (window list)                         │
│  │   └─ System Tray                                         │
│  │       ├─ Network Status                                  │
│  │       ├─ Resource Indicator (CPU/RAM)                    │
│  │       ├─ Notifications Bell                              │
│  │       └─ Clock                                           │
│  ├─ Application Launcher (Search + Grid)                    │
│  ├─ Notification Center                                     │
│  ├─ Context Menus                                           │
│  └─ Quick Settings Panel                                    │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 Window Manager

The Window Manager handles all window lifecycle, positioning, focus, and state.

#### Window State Model

```typescript
interface AetherWindow {
  id: string; // unique window ID
  appId: string; // which app owns this window
  title: string;
  icon: string;
  
  // Position and size
  position: { x: number; y: number };
  size: { width: number; height: number };
  
  // Window state
  state: "normal" | "minimized" | "maximized" | "fullscreen";
  
  // Visual properties
  zIndex: number;
  visible: boolean;
  focused: boolean;
  
  // Capabilities
  resizable: boolean;
  minimizable: boolean;
  maximizable: boolean;
  closable: boolean;
  
  // Constraints
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  
  // Metadata
  createdAt: string;
  lastFocusedAt: string;
  
  // Persistence
  persistState: boolean; // restore on reload
}
```

#### Window Manager API

```typescript
class WindowManager {
  private windows: Map<string, AetherWindow> = new Map();
  private focusStack: string[] = []; // most recent first
  private nextZIndex: number = 1000;
  
  // Create window
  createWindow(params: {
    appId: string;
    title: string;
    icon: string;
    initialSize?: { width: number; height: number };
    initialPosition?: { x: number; y: number };
    resizable?: boolean;
    minimizable?: boolean;
    maximizable?: boolean;
  }): AetherWindow {
    const windowId = `win_${nanoid()}`;
    
    // Smart positioning: cascade or center
    const position = params.initialPosition || this.getSmartPosition();
    const size = params.initialSize || { width: 800, height: 600 };
    
    const window: AetherWindow = {
      id: windowId,
      appId: params.appId,
      title: params.title,
      icon: params.icon,
      position,
      size,
      state: "normal",
      zIndex: this.nextZIndex++,
      visible: true,
      focused: true,
      resizable: params.resizable ?? true,
      minimizable: params.minimizable ?? true,
      maximizable: params.maximizable ?? true,
      closable: true,
      createdAt: new Date().toISOString(),
      lastFocusedAt: new Date().toISOString(),
      persistState: true
    };
    
    this.windows.set(windowId, window);
    this.setFocus(windowId);
    this.emitEvent('window.created', window);
    
    return window;
  }
  
  // Focus window (bring to front)
  focusWindow(windowId: string): void {
    const window = this.windows.get(windowId);
    if (!window || !window.visible) return;
    
    // Update focus stack
    this.focusStack = this.focusStack.filter(id => id !== windowId);
    this.focusStack.unshift(windowId);
    
    // Bring to front
    window.zIndex = this.nextZIndex++;
    window.focused = true;
    window.lastFocusedAt = new Date().toISOString();
    
    // Unfocus others
    this.windows.forEach((w, id) => {
      if (id !== windowId) w.focused = false;
    });
    
    this.emitEvent('window.focused', window);
  }
  
  // Minimize window
  minimizeWindow(windowId: string): void {
    const window = this.windows.get(windowId);
    if (!window || !window.minimizable) return;
    
    window.state = "minimized";
    window.visible = false;
    window.focused = false;
    
    // Focus next window in stack
    const nextWindowId = this.focusStack.find(id => 
      id !== windowId && this.windows.get(id)?.visible
    );
    if (nextWindowId) this.focusWindow(nextWindowId);
    
    this.emitEvent('window.minimized', window);
  }
  
  // Restore minimized window
  restoreWindow(windowId: string): void {
    const window = this.windows.get(windowId);
    if (!window) return;
    
    window.state = "normal";
    window.visible = true;
    this.focusWindow(windowId);
    
    this.emitEvent('window.restored', window);
  }
  
  // Maximize window
  maximizeWindow(windowId: string): void {
    const window = this.windows.get(windowId);
    if (!window || !window.maximizable) return;
    
    // Save previous state for restore
    window.previousPosition = { ...window.position };
    window.previousSize = { ...window.size };
    
    // Set to desktop bounds (minus taskbar)
    const desktop = this.getDesktopBounds();
    window.position = { x: 0, y: 0 };
    window.size = { width: desktop.width, height: desktop.height };
    window.state = "maximized";
    
    this.emitEvent('window.maximized', window);
  }
  
  // Unmaximize window
  unmaximizeWindow(windowId: string): void {
    const window = this.windows.get(windowId);
    if (!window || window.state !== "maximized") return;
    
    // Restore previous size/position
    if (window.previousPosition) {
      window.position = window.previousPosition;
      delete window.previousPosition;
    }
    if (window.previousSize) {
      window.size = window.previousSize;
      delete window.previousSize;
    }
    
    window.state = "normal";
    this.emitEvent('window.unmaximized', window);
  }
  
  // Close window
  closeWindow(windowId: string): void {
    const window = this.windows.get(windowId);
    if (!window || !window.closable) return;
    
    // Notify app (app can cancel close)
    const cancelled = this.notifyAppClosing(window.appId, windowId);
    if (cancelled) return;
    
    // Remove from focus stack
    this.focusStack = this.focusStack.filter(id => id !== windowId);
    
    // Delete window
    this.windows.delete(windowId);
    
    // Focus next window
    if (this.focusStack.length > 0) {
      this.focusWindow(this.focusStack[0]);
    }
    
    this.emitEvent('window.closed', { windowId, appId: window.appId });
  }
  
  // Move window
  moveWindow(windowId: string, position: { x: number; y: number }): void {
    const window = this.windows.get(windowId);
    if (!window || window.state === "maximized") return;
    
    // Keep window on screen
    const constrained = this.constrainToScreen(position, window.size);
    window.position = constrained;
    
    this.emitEvent('window.moved', window);
  }
  
  // Resize window
  resizeWindow(windowId: string, size: { width: number; height: number }): void {
    const window = this.windows.get(windowId);
    if (!window || !window.resizable || window.state === "maximized") return;
    
    // Apply constraints
    const constrained = {
      width: Math.max(window.minWidth || 300, Math.min(size.width, window.maxWidth || 4096)),
      height: Math.max(window.minHeight || 200, Math.min(size.height, window.maxHeight || 2160))
    };
    
    window.size = constrained;
    
    this.emitEvent('window.resized', window);
  }
  
  // Snap window to edge (Windows-style)
  snapWindow(windowId: string, direction: "left" | "right" | "top" | "bottom"): void {
    const window = this.windows.get(windowId);
    if (!window) return;
    
    const desktop = this.getDesktopBounds();
    
    switch (direction) {
      case "left":
        window.position = { x: 0, y: 0 };
        window.size = { width: desktop.width / 2, height: desktop.height };
        break;
      case "right":
        window.position = { x: desktop.width / 2, y: 0 };
        window.size = { width: desktop.width / 2, height: desktop.height };
        break;
      // ... other directions
    }
    
    window.state = "normal"; // snapped is still "normal" state
    this.emitEvent('window.snapped', window);
  }
  
  // Tile windows (arrange multiple windows)
  tileWindows(layout: "grid" | "horizontal" | "vertical"): void {
    const visibleWindows = Array.from(this.windows.values())
      .filter(w => w.visible && w.state === "normal");
    
    if (visibleWindows.length === 0) return;
    
    const desktop = this.getDesktopBounds();
    
    if (layout === "grid") {
      const cols = Math.ceil(Math.sqrt(visibleWindows.length));
      const rows = Math.ceil(visibleWindows.length / cols);
      const windowWidth = desktop.width / cols;
      const windowHeight = desktop.height / rows;
      
      visibleWindows.forEach((window, index) => {
        const col = index % cols;
        const row = Math.floor(index / cols);
        
        window.position = { 
          x: col * windowWidth, 
          y: row * windowHeight 
        };
        window.size = { 
          width: windowWidth, 
          height: windowHeight 
        };
      });
    }
    
    this.emitEvent('windows.tiled', { layout });
  }
  
  // Persist state (save to localStorage or backend)
  persistWindowState(): void {
    const state = Array.from(this.windows.values())
      .filter(w => w.persistState)
      .map(w => ({
        appId: w.appId,
        title: w.title,
        position: w.position,
        size: w.size,
        state: w.state
      }));
    
    localStorage.setItem('aether.windowState', JSON.stringify(state));
  }
  
  // Restore state
  restoreWindowState(): void {
    const saved = localStorage.getItem('aether.windowState');
    if (!saved) return;
    
    try {
      const state = JSON.parse(saved);
      // Restore windows (app must be available)
      // Implementation depends on app runtime
    } catch (e) {
      console.error('Failed to restore window state', e);
    }
  }
}
```

### 5.3 Window Rendering

Windows rendered as absolutely positioned divs with CSS transforms for performance.

```tsx
// WindowContainer.tsx
interface WindowProps {
  window: AetherWindow;
  onFocus: () => void;
  onClose: () => void;
  onMinimize: () => void;
  onMaximize: () => void;
  onMove: (position: { x: number; y: number }) => void;
  onResize: (size: { width: number; height: number }) => void;
}

export function WindowContainer({ window, ...handlers }: WindowProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  
  return (
    <div
      className={cn(
        "absolute bg-white dark:bg-gray-900 rounded-lg shadow-2xl",
        "border border-gray-300 dark:border-gray-700",
        "flex flex-col overflow-hidden",
        window.focused && "ring-2 ring-blue-500",
        window.state === "minimized" && "hidden",
        window.state === "maximized" && "!top-0 !left-0"
      )}
      style={{
        left: window.position.x,
        top: window.position.y,
        width: window.size.width,
        height: window.size.height,
        zIndex: window.zIndex,
        display: window.visible ? 'flex' : 'none'
      }}
      onClick={handlers.onFocus}
    >
      {/* Title Bar */}
      <WindowTitleBar
        title={window.title}
        icon={window.icon}
        focused={window.focused}
        maximized={window.state === "maximized"}
        minimizable={window.minimizable}
        maximizable={window.maximizable}
        closable={window.closable}
        onDragStart={() => setIsDragging(true)}
        onDragEnd={() => setIsDragging(false)}
        onDrag={handlers.onMove}
        onMinimize={handlers.onMinimize}
        onMaximize={handlers.onMaximize}
        onClose={handlers.onClose}
      />
      
      {/* Content Area */}
      <div className="flex-1 overflow-auto">
        <AppContent appId={window.appId} windowId={window.id} />
      </div>
      
      {/* Resize Handles */}
      {window.resizable && window.state === "normal" && (
        <>
          <ResizeHandle direction="n" onResize={handlers.onResize} />
          <ResizeHandle direction="ne" onResize={handlers.onResize} />
          <ResizeHandle direction="e" onResize={handlers.onResize} />
          <ResizeHandle direction="se" onResize={handlers.onResize} />
          <ResizeHandle direction="s" onResize={handlers.onResize} />
          <ResizeHandle direction="sw" onResize={handlers.onResize} />
          <ResizeHandle direction="w" onResize={handlers.onResize} />
          <ResizeHandle direction="nw" onResize={handlers.onResize} />
        </>
      )}
    </div>
  );
}
```

### 5.4 Theme System

Three visual themes sharing same Window Manager core.

#### Design Token Structure

```typescript
interface DesignTokens {
  colors: {
    primary: string;
    secondary: string;
    accent: string;
    background: {
      desktop: string;
      window: string;
      panel: string;
    };
    text: {
      primary: string;
      secondary: string;
      muted: string;
    };
    border: string;
    shadow: string;
  };
  
  typography: {
    fontFamily: {
      sans: string;
      mono: string;
    };
    fontSize: {
      xs: string;
      sm: string;
      base: string;
      lg: string;
      xl: string;
    };
  };
  
  spacing: {
    xs: number;
    sm: number;
    md: number;
    lg: number;
    xl: number;
  };
  
  borderRadius: {
    sm: number;
    md: number;
    lg: number;
  };
  
  elevation: {
    sm: string; // box-shadow
    md: string;
    lg: string;
    xl: string;
  };
  
  animation: {
    duration: {
      fast: string;
      normal: string;
      slow: string;
    };
    easing: {
      standard: string;
      accelerate: string;
      decelerate: string;
    };
  };
  
  components: {
    taskbar: {
      height: number;
      position: "top" | "bottom" | "left" | "right";
      alignment: "start" | "center" | "end";
    };
    window: {
      titleBarHeight: number;
      borderWidth: number;
      defaultWidth: number;
      defaultHeight: number;
    };
  };
}
```

#### Theme Implementations

**1. Aether Modern (Default)**

```typescript
const aetherModernTheme: DesignTokens = {
  colors: {
    primary: "#3b82f6", // blue-500
    secondary: "#8b5cf6", // violet-500
    accent: "#06b6d4", // cyan-500
    background: {
      desktop: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
      window: "#ffffff",
      panel: "#f9fafb"
    },
    text: {
      primary: "#111827",
      secondary: "#6b7280",
      muted: "#9ca3af"
    },
    border: "#e5e7eb",
    shadow: "rgba(0, 0, 0, 0.1)"
  },
  // ... rest of tokens
  components: {
    taskbar: {
      height: 48,
      position: "bottom",
      alignment: "center"
    },
    window: {
      titleBarHeight: 40,
      borderWidth: 1,
      defaultWidth: 800,
      defaultHeight: 600
    }
  }
};
```

**2. Windows-Inspired**

```typescript
const windowsInspiredTheme: DesignTokens = {
  colors: {
    primary: "#0078d4", // Windows blue
    secondary: "#00bcf2",
    accent: "#00b7c3",
    background: {
      desktop: "#0078d4", // solid blue
      window: "#ffffff",
      panel: "#f3f3f3"
    },
    // ...
  },
  components: {
    taskbar: {
      height: 40,
      position: "bottom",
      alignment: "start" // Windows-style left-aligned
    },
    window: {
      titleBarHeight: 32,
      borderWidth: 1,
      defaultWidth: 800,
      defaultHeight: 600
    }
  }
};

// Additional UI changes:
// - Start Menu instead of App Launcher
// - Task View button
// - System tray on right
// - Window snap zones on drag
```

**3. macOS-Inspired**

```typescript
const macOSInspiredTheme: DesignTokens = {
  colors: {
    primary: "#007aff", // macOS blue
    secondary: "#5856d6", // macOS purple
    accent: "#ff9500", // macOS orange
    background: {
      desktop: "url('/wallpapers/macos-big-sur.jpg')",
      window: "#ffffff",
      panel: "rgba(255, 255, 255, 0.8)" // frosted glass
    },
    // ...
  },
  components: {
    taskbar: {
      height: 60,
      position: "bottom",
      alignment: "center" // Dock style
    },
    window: {
      titleBarHeight: 52, // taller title bar
      borderWidth: 1,
      defaultWidth: 800,
      defaultHeight: 600
    }
  }
};

// Additional UI changes:
// - Dock with magnification effect
// - Menu bar at top (global menu)
// - Traffic light window controls (left side)
// - Mission Control / Exposé
// - Spotlight search
```

### 5.5 Desktop Components

#### Taskbar / Dock

```tsx
export function Taskbar() {
  const theme = useTheme();
  const windows = useWindowManager();
  const apps = useAppRuntime();
  
  return (
    <div className={cn(
      "fixed bg-white/90 dark:bg-gray-900/90 backdrop-blur-lg",
      "border-t border-gray-200 dark:border-gray-700",
      "flex items-center px-4 gap-2",
      theme.name === "macos" ? "rounded-2xl mx-auto bottom-4" : "bottom-0 left-0 right-0"
    )}
    style={{ height: theme.components.taskbar.height }}>
      
      {/* App Launcher / Start Menu */}
      <button onClick={() => openLauncher()}>
        <AetherIcon className="w-6 h-6" />
      </button>
      
      <Separator orientation="vertical" />
      
      {/* Pinned Apps */}
      {apps.pinnedApps.map(app => (
        <TaskbarApp
          key={app.id}
          app={app}
          isRunning={apps.isRunning(app.id)}
          windows={windows.getByAppId(app.id)}
          onClick={() => apps.launch(app.id)}
        />
      ))}
      
      <Separator orientation="vertical" />
      
      {/* Running Apps (not pinned) */}
      {apps.runningApps
        .filter(app => !apps.isPinned(app.id))
        .map(app => (
          <TaskbarApp
            key={app.id}
            app={app}
            isRunning={true}
            windows={windows.getByAppId(app.id)}
          />
        ))}
      
      <div className="flex-1" />
      
      {/* System Tray */}
      <SystemTray />
      
      {/* Clock */}
      <Clock format="HH:mm" />
    </div>
  );
}
```

#### Application Launcher

```tsx
export function AppLauncher() {
  const [query, setQuery] = useState("");
  const apps = useAppRuntime();
  const filtered = apps.search(query);
  
  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogContent className="max-w-3xl">
        
        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-3 w-5 h-5 text-gray-400" />
          <input
            type="text"
            placeholder="Search apps, files, settings..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-3 text-lg"
            autoFocus
          />
        </div>
        
        {/* Results */}
        {query ? (
          // Search results
          <SearchResults results={filtered} onSelect={launch} />
        ) : (
          // App grid
          <div className="grid grid-cols-6 gap-4 p-4">
            {apps.installed.map(app => (
              <button
                key={app.id}
                onClick={() => launch(app)}
                className="flex flex-col items-center gap-2 p-3 rounded-lg hover:bg-gray-100"
              >
                <img src={app.icon} className="w-12 h-12" />
                <span className="text-sm text-center">{app.name}</span>
              </button>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
```

#### Notification Center

```tsx
export function NotificationCenter() {
  const notifications = useNotifications();
  
  return (
    <Sheet>
      <SheetTrigger>
        <Bell className="w-5 h-5" />
        {notifications.unread > 0 && (
          <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">
            {notifications.unread}
          </span>
        )}
      </SheetTrigger>
      
      <SheetContent side="right" className="w-96">
        <SheetHeader>
          <SheetTitle>Notifications</SheetTitle>
        </SheetHeader>
        
        <ScrollArea className="h-full">
          {notifications.items.map(notif => (
            <NotificationItem
              key={notif.id}
              notification={notif}
              onDismiss={() => notifications.dismiss(notif.id)}
              onClick={() => notifications.handleClick(notif)}
            />
          ))}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
```

### 5.6 Desktop State Persistence

Desktop state should survive browser refresh and reconnection.

**Persisted State:**
- Window positions and sizes
- Window minimized/maximized state
- Running applications
- Pinned applications
- Theme selection
- Wallpaper
- Taskbar configuration

**Storage Strategy:**
- Critical state: Backend database (synced across devices)
- UI preferences: localStorage (per-device)
- Session state: sessionStorage (lost on tab close)

```typescript
interface DesktopState {
  version: string;
  theme: string;
  wallpaper: string;
  pinnedApps: string[];
  
  windows: Array<{
    appId: string;
    title: string;
    position: { x: number; y: number };
    size: { width: number; height: number };
    state: "normal" | "minimized" | "maximized";
  }>;
  
  lastSaved: string;
}

// Save periodically and on unload
function saveDesktopState() {
  const state: DesktopState = {
    version: "1.0",
    theme: currentTheme,
    wallpaper: currentWallpaper,
    pinnedApps: appRuntime.getPinnedAppIds(),
    windows: windowManager.getAll()
      .filter(w => w.persistState)
      .map(w => ({
        appId: w.appId,
        title: w.title,
        position: w.position,
        size: w.size,
        state: w.state
      })),
    lastSaved: new Date().toISOString()
  };
  
  // Save to backend
  await api.saveDesktopState(hostId, state);
  
  // Also cache locally
  localStorage.setItem('aether.desktop.state', JSON.stringify(state));
}

// Restore on load
async function restoreDesktopState() {
  // Try backend first
  let state = await api.getDesktopState(hostId);
  
  // Fallback to localStorage
  if (!state) {
    const cached = localStorage.getItem('aether.desktop.state');
    if (cached) state = JSON.parse(cached);
  }
  
  if (!state) return;
  
  // Restore theme
  setTheme(state.theme);
  
  // Restore wallpaper
  setWallpaper(state.wallpaper);
  
  // Restore pinned apps
  appRuntime.setPinnedApps(state.pinnedApps);
  
  // Restore windows (apps must be available)
  for (const windowState of state.windows) {
    if (appRuntime.isInstalled(windowState.appId)) {
      const app = await appRuntime.launch(windowState.appId);
      
      // Wait for window creation
      await nextTick();
      
      const window = windowManager.getByAppId(windowState.appId)[0];
      if (window) {
        windowManager.moveWindow(window.id, windowState.position);
        windowManager.resizeWindow(window.id, windowState.size);
        
        if (windowState.state === "minimized") {
          windowManager.minimizeWindow(window.id);
        } else if (windowState.state === "maximized") {
          windowManager.maximizeWindow(window.id);
        }
      }
    }
  }
}
```

---

import {
  Boxes,
  FolderClosed,
  Gauge,
  Image as ImageIcon,
  LineChart,
  Network,
  ShieldCheck,
  SlidersHorizontal,
  SquareTerminal,
  SquareCode,
  type LucideIcon,
} from 'lucide-react';

import { AppCatalogApp } from './app-catalog/AppCatalogApp.js';
import { CodeStudioApp } from './code-studio/CodeStudioApp.js';
import { FilesApp } from './files/FilesApp.js';
import { MediaViewerApp } from './media-viewer/MediaViewerApp.js';
import { PortPreviewApp } from './port-preview/PortPreviewApp.js';
import { PortsApp } from './ports/PortsApp.js';
import { SecurityCenterApp } from './security-center/SecurityCenterApp.js';
import { SettingsApp } from './settings/SettingsApp.js';
import { SystemMonitorApp } from './system-monitor/SystemMonitorApp.js';
import { TaskManagerApp } from './task-manager/TaskManagerApp.js';
import { TerminalApp } from './terminal/TerminalApp.js';

import type { Permission } from '@aether/shared';
import type { ComponentType } from 'react';

/** Props every app component receives from the window manager. */
export interface AppProps {
  /** Id of the window hosting this instance; use it to update the title. */
  windowId: string;
  /** Data the window was opened with, e.g. `{ path: 'docs' }`. */
  props: Record<string, unknown>;
}

export interface AppDefinition {
  id: string;
  name: string;
  /** One line, shown in the launcher and the app catalog. */
  description: string;
  /** The app's icon, a line icon from lucide-react. */
  icon: LucideIcon;
  defaultSize: { width: number; height: number };
  /** Only one window of this app may exist at a time. */
  singleton: boolean;
  /**
   * Permission the user must hold for the app to be usable. The launcher hides
   * apps the user cannot use, but the server enforces the same permission on
   * every request — hiding the icon is convenience, not access control.
   */
  requiredPermission?: Permission;
  /**
   * Registered but never offered.
   *
   * Some window types are not apps anyone launches: a port preview is opened by
   * the Ports app with the address it is showing, and would be an empty window
   * if it appeared in the launcher. It still needs a registry entry, because
   * that is what the window manager resolves an id to.
   */
  hidden?: boolean;
  component: ComponentType<AppProps>;
}

export const APP_REGISTRY: readonly AppDefinition[] = [
  {
    id: 'files',
    name: 'Files',
    description: 'Browse, edit, upload, and download files in the workspace.',
    icon: FolderClosed,
    defaultSize: { width: 940, height: 620 },
    singleton: false,
    requiredPermission: 'files:read',
    component: FilesApp,
  },
  {
    id: 'terminal',
    name: 'Terminal',
    description: 'A real shell on the host, streamed over a WebSocket.',
    icon: SquareTerminal,
    defaultSize: { width: 860, height: 540 },
    singleton: false,
    requiredPermission: 'terminal:create',
    component: TerminalApp,
  },
  {
    id: 'code-studio',
    name: 'Code Studio',
    description: 'A full code editor with a file tree, tabs, and syntax highlighting.',
    icon: SquareCode,
    defaultSize: { width: 1000, height: 660 },
    singleton: false,
    requiredPermission: 'files:read',
    component: CodeStudioApp,
  },
  {
    id: 'media-viewer',
    name: 'Media Viewer',
    description: 'Images, video, audio, and PDFs, with seeking and zoom.',
    icon: ImageIcon,
    defaultSize: { width: 900, height: 640 },
    singleton: false,
    requiredPermission: 'files:read',
    component: MediaViewerApp,
  },
  {
    id: 'task-manager',
    name: 'Task Manager',
    description: 'Running processes, their memory use, and a search filter.',
    icon: Gauge,
    defaultSize: { width: 900, height: 600 },
    singleton: true,
    requiredPermission: 'process:read',
    component: TaskManagerApp,
  },
  {
    id: 'ports',
    name: 'Ports',
    description: 'Servers listening on the host, opened as windows in the desktop.',
    icon: Network,
    defaultSize: { width: 940, height: 560 },
    singleton: true,
    requiredPermission: 'ports:read',
    component: PortsApp,
  },
  {
    // Opened by the Ports app, one window per previewed port. Registered so the
    // window manager can resolve the id, hidden so it is never offered as an app
    // to launch — it has nothing to show without the address it was opened for.
    id: 'port-preview',
    name: 'Port Preview',
    description: 'A server running on the host, shown inside the desktop.',
    icon: Network,
    defaultSize: { width: 1024, height: 700 },
    singleton: false,
    hidden: true,
    requiredPermission: 'ports:read',
    component: PortPreviewApp,
  },
  {
    id: 'system-monitor',
    name: 'System Monitor',
    description: 'CPU, memory, disk, and network for this host.',
    icon: LineChart,
    defaultSize: { width: 880, height: 620 },
    singleton: true,
    requiredPermission: 'system:read',
    component: SystemMonitorApp,
  },
  {
    id: 'settings',
    name: 'Settings',
    description: 'Account, sessions, users, appearance, and instance information.',
    icon: SlidersHorizontal,
    defaultSize: { width: 920, height: 640 },
    singleton: true,
    component: SettingsApp,
  },
  {
    id: 'security-center',
    name: 'Security Center',
    description: 'The audit log: who did what, from where, and whether it worked.',
    icon: ShieldCheck,
    defaultSize: { width: 980, height: 620 },
    singleton: true,
    requiredPermission: 'audit:read',
    component: SecurityCenterApp,
  },
  {
    id: 'app-catalog',
    name: 'App Catalog',
    description: 'Choose which apps appear on the desktop and in the launcher.',
    icon: Boxes,
    defaultSize: { width: 820, height: 580 },
    singleton: true,
    component: AppCatalogApp,
  },
];

export function findApp(appId: string): AppDefinition | undefined {
  return APP_REGISTRY.find((app) => app.id === appId);
}

/** Apps the given permission set may use, excluding the ones never offered. */
export function availableApps(permissions: readonly Permission[]): AppDefinition[] {
  return APP_REGISTRY.filter(
    (app) =>
      app.hidden !== true &&
      (app.requiredPermission === undefined || permissions.includes(app.requiredPermission))
  );
}

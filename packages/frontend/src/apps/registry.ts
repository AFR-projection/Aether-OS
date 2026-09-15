
import { AppCatalogApp } from './app-catalog/AppCatalogApp.js';
import { CodeStudioApp } from './code-studio/CodeStudioApp.js';
import { FilesApp } from './files/FilesApp.js';
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
  /** A single glyph. Emoji keeps the bundle free of an icon dependency. */
  icon: string;
  defaultSize: { width: number; height: number };
  /** Only one window of this app may exist at a time. */
  singleton: boolean;
  /**
   * Permission the user must hold for the app to be usable. The launcher hides
   * apps the user cannot use, but the server enforces the same permission on
   * every request — hiding the icon is convenience, not access control.
   */
  requiredPermission?: Permission;
  component: ComponentType<AppProps>;
}

export const APP_REGISTRY: readonly AppDefinition[] = [
  {
    id: 'files',
    name: 'Files',
    description: 'Browse, edit, upload, and download files in the workspace.',
    icon: '📁',
    defaultSize: { width: 940, height: 620 },
    singleton: false,
    requiredPermission: 'files:read',
    component: FilesApp,
  },
  {
    id: 'terminal',
    name: 'Terminal',
    description: 'A real shell on the host, streamed over a WebSocket.',
    icon: '⌨️',
    defaultSize: { width: 860, height: 540 },
    singleton: false,
    requiredPermission: 'terminal:create',
    component: TerminalApp,
  },
  {
    id: 'code-studio',
    name: 'Code Studio',
    description: 'Open and edit text files, with line numbers and save.',
    icon: '🧩',
    defaultSize: { width: 1000, height: 660 },
    singleton: false,
    requiredPermission: 'files:read',
    component: CodeStudioApp,
  },
  {
    id: 'task-manager',
    name: 'Task Manager',
    description: 'Running processes, their memory use, and a search filter.',
    icon: '📊',
    defaultSize: { width: 900, height: 600 },
    singleton: true,
    requiredPermission: 'process:read',
    component: TaskManagerApp,
  },
  {
    id: 'system-monitor',
    name: 'System Monitor',
    description: 'CPU, memory, disk, and network for this host.',
    icon: '📈',
    defaultSize: { width: 880, height: 620 },
    singleton: true,
    requiredPermission: 'system:read',
    component: SystemMonitorApp,
  },
  {
    id: 'settings',
    name: 'Settings',
    description: 'Account, sessions, users, and instance information.',
    icon: '⚙️',
    defaultSize: { width: 920, height: 640 },
    singleton: true,
    component: SettingsApp,
  },
  {
    id: 'security-center',
    name: 'Security Center',
    description: 'The audit log: who did what, from where, and whether it worked.',
    icon: '🛡️',
    defaultSize: { width: 980, height: 620 },
    singleton: true,
    requiredPermission: 'audit:read',
    component: SecurityCenterApp,
  },
  {
    id: 'app-catalog',
    name: 'App Catalog',
    description: 'Choose which apps appear on the desktop and in the launcher.',
    icon: '🧰',
    defaultSize: { width: 820, height: 580 },
    singleton: true,
    component: AppCatalogApp,
  },
];

export function findApp(appId: string): AppDefinition | undefined {
  return APP_REGISTRY.find((app) => app.id === appId);
}

/** Apps the given permission set may use. */
export function availableApps(permissions: readonly Permission[]): AppDefinition[] {
  return APP_REGISTRY.filter(
    (app) => app.requiredPermission === undefined || permissions.includes(app.requiredPermission)
  );
}

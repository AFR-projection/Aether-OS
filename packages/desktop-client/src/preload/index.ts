import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('aetherDesktop', {
  platform: process.platform,
});

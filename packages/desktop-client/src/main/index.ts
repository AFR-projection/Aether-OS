import { app, BrowserWindow } from 'electron';

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void window.loadFile('dist/index.html');
  }
}

app.whenReady().then(
  () => {
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  },
  (error: unknown) => {
    console.error('Electron failed to become ready', error);
  }
);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

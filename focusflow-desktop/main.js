const { app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');

// Optional: Configure logging for autoUpdater
autoUpdater.logger = require("electron-log");
autoUpdater.logger.transports.file.level = "info";

app.setAppUserModelId("FocusFlow");

let mainWindow;
let floatWindow;
let tray = null;
let isQuitting = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    icon: path.join(__dirname, 'Copilot_20260619_192035.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
    },
    autoHideMenuBar: true,
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Toggle fullscreen with F11
  mainWindow.on('focus', () => {
    globalShortcut.register('F11', () => {
      if (mainWindow) {
        mainWindow.setFullScreen(!mainWindow.isFullScreen());
      }
    });
  });

  mainWindow.on('blur', () => {
    globalShortcut.unregister('F11');
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (floatWindow && !floatWindow.isDestroyed()) {
      floatWindow.close();
    }
  });
}

function createFloatWindow() {
  if (floatWindow && !floatWindow.isDestroyed()) return;

  floatWindow = new BrowserWindow({
    width: 140,
    height: 50,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  floatWindow.setAlwaysOnTop(true, 'screen-saver');
  floatWindow.loadFile(path.join(__dirname, 'float.html'));

  floatWindow.on('closed', () => {
    floatWindow = null;
    // Notify renderer that float was closed
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('float-closed');
    }
  });
}

// IPC: open/close floating window
ipcMain.on('open-float', () => {
  createFloatWindow();
});

ipcMain.on('close-float', () => {
  if (floatWindow && !floatWindow.isDestroyed()) {
    floatWindow.close();
  }
  floatWindow = null;
});

// IPC: push timer state to floating window
ipcMain.on('float-update', (_event, data) => {
  if (floatWindow && !floatWindow.isDestroyed()) {
    floatWindow.webContents.send('timer-update', data);
  }
});

// IPC: relay toggle/reset clicks from float window back to main renderer
ipcMain.on('float-action', (_event, action) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('float-action', action);
  }
});

function createTray() {
  const iconPath = path.join(__dirname, 'Copilot_20260619_192035.png');
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  icon.setTemplateImage(false);

  tray = new Tray(icon);
  tray.setToolTip('FocusFlow');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show App', click: () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    }},
    { type: 'separator' },
    { label: 'Quit', click: () => {
      isQuitting = true;
      if (floatWindow && !floatWindow.isDestroyed()) floatWindow.destroy();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
      app.quit();
    }},
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.focus() : mainWindow.show();
    }
  });
}

app.whenReady().then(() => {
  createWindow();
  createTray();

  // Check for updates quietly in the background
  autoUpdater.checkForUpdatesAndNotify();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

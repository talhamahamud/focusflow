const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('path');
const WebSocket = require('ws');

let mainWindow;
let wss;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 120,
    height: 40,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  // Stays on top of everything, including full-screen apps
  mainWindow.setAlwaysOnTop(true, 'screen-saver');

  // Load the dedicated minimal widget page (not the full app)
  mainWindow.loadFile(path.join(__dirname, 'overlay', 'widget.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Right-click → context menu with Close option
  mainWindow.webContents.on('context-menu', () => {
    const menu = Menu.buildFromTemplate([
      { label: 'Close Widget', click: () => app.quit() }
    ]);
    menu.popup(mainWindow);
  });
}

function startWebSocketServer() {
  wss = new WebSocket.Server({ port: 49000 });
  console.log('[FocusFlow Widget] WebSocket server started on port 49000');

  wss.on('connection', (ws) => {
    console.log('[FocusFlow Widget] Web browser connected');

    // Forward sync messages from browser → Electron renderer widget
    ws.on('message', (raw) => {
      try {
        const data = JSON.parse(raw);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('ws-message', data);
        }
      } catch (e) {
        console.error('[FocusFlow Widget] Bad message:', e);
      }
    });

    // Forward commands from widget click → browser
    // Remove any old listener first to avoid duplicates on reconnect
    ipcMain.removeAllListeners('send-to-web');
    ipcMain.on('send-to-web', (_event, data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
      }
    });

    ws.on('close', () => {
      console.log('[FocusFlow Widget] Web browser disconnected');
    });
  });
}

app.whenReady().then(() => {
  startWebSocketServer();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

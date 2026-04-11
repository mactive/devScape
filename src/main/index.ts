import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { parseClaudeSessions, parseSessionDetail } from './claude-parser'
import { readdirSync, existsSync } from 'fs'
import { homedir } from 'os'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1200,
    minHeight: 800,
    frame: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0a0a',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// IPC Handlers
ipcMain.handle('get-sessions', async () => {
  try {
    const { sessions, projects } = parseClaudeSessions()
    // Strip messages from session list for performance
    const sessionsWithoutMessages = sessions.map(({ messages: _m, ...s }) => s)
    return { sessions: sessionsWithoutMessages, projects }
  } catch (err) {
    console.error('Error parsing sessions:', err)
    return { sessions: [], projects: [] }
  }
})

ipcMain.handle('get-session-detail', async (_, sessionId: string) => {
  try {
    // Trae session IDs are resolved directly by parser without Claude project lookup.
    const directMessages = parseSessionDetail(sessionId)
    if (directMessages.length > 0) {
      return { messages: directMessages }
    }

    const claudeDir = join(homedir(), '.claude', 'projects')
    if (!existsSync(claudeDir)) return null

    const projectDirs = readdirSync(claudeDir)
    for (const dir of projectDirs) {
      const sessionFile = join(claudeDir, dir, `${sessionId}.jsonl`)
      if (existsSync(sessionFile)) {
        const messages = parseSessionDetail(sessionId, dir)
        return { messages }
      }
    }
    return null
  } catch (err) {
    console.error('Error loading session detail:', err)
    return null
  }
})

ipcMain.handle('window-minimize', () => {
  BrowserWindow.getFocusedWindow()?.minimize()
})

ipcMain.handle('window-maximize', () => {
  const win = BrowserWindow.getFocusedWindow()
  if (win?.isMaximized()) {
    win.unmaximize()
  } else {
    win?.maximize()
  }
})

ipcMain.handle('window-close', () => {
  BrowserWindow.getFocusedWindow()?.close()
})

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.devscape')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

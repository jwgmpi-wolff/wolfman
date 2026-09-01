const { app, BrowserWindow, shell } = require('electron')
const path = require('node:path')
const { spawn } = require('node:child_process')
const fs = require('node:fs')

let ollamaProcess = null

function findOllamaExecutable() {
  if (process.platform === 'win32') {
    const candidate = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe')
    if (fs.existsSync(candidate)) return candidate
  }
  return 'ollama'
}

async function isOllamaRunning() {
  try {
    const response = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(1500) })
    return response.ok
  } catch {
    return false
  }
}

// Wolfman's local-reasoning agent needs Ollama; start it with this app and stop it when this app quits
// (but never kill an instance we didn't start ourselves, e.g. one the user is running independently).
async function startOllama() {
  if (await isOllamaRunning()) return
  try {
    ollamaProcess = spawn(findOllamaExecutable(), ['serve'], {
      env: { ...process.env, OLLAMA_ORIGINS: '*' },
      detached: false,
      stdio: 'ignore',
    })
    ollamaProcess.on('error', () => { ollamaProcess = null })
  } catch {
    ollamaProcess = null
  }
}

function stopOllama() {
  if (ollamaProcess && !ollamaProcess.killed) ollamaProcess.kill()
  ollamaProcess = null
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Wolfman',
    icon: path.join(__dirname, `../public/wolfman-icon${process.platform === 'win32' ? '.ico' : '-512.png'}`),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  // External links open in the OS browser, never inside the app window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  window.loadFile(path.join(__dirname, '../dist/index.html'))
}

app.whenReady().then(() => {
  void startOllama()
  createWindow()
})

app.on('before-quit', stopOllama)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

const { app, BrowserWindow, ipcMain, shell } = require('electron')
const path = require('node:path')
const { spawn } = require('node:child_process')
const fs = require('node:fs')

let ollamaProcess = null
const MAX_MEDIA_BYTES = 250 * 1024 * 1024
const OLLAMA_URL = 'http://localhost:11434'

ipcMain.handle('wolfman:ollama-available', () => isOllamaRunning())

ipcMain.handle('wolfman:ollama-chat', async (_event, body) => {
  if (!body || typeof body !== 'object' || typeof body.model !== 'string' || !Array.isArray(body.messages)) {
    throw new Error('Invalid local model request.')
  }
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  })
  if (!response.ok) throw new Error(`Local model request failed (${response.status}).`)
  return response.json()
})

ipcMain.handle('wolfman:fetch-media', async (_event, value) => {
  const url = new URL(String(value))
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) media links are supported.')
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw new Error(`Media URL returned HTTP ${response.status}.`)
  const contentType = response.headers.get('content-type')?.split(';')[0] ?? ''
  if (!contentType.startsWith('image/') && !contentType.startsWith('video/')) throw new Error('The link did not return an image or video.')
  const declaredSize = Number(response.headers.get('content-length') ?? 0)
  if (declaredSize > MAX_MEDIA_BYTES) throw new Error('The linked media is larger than 250 MB.')
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > MAX_MEDIA_BYTES) throw new Error('The linked media is larger than 250 MB.')
  return { base64: bytes.toString('base64'), contentType }
})

function findOllamaExecutable() {
  if (process.platform === 'win32') {
    const candidate = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe')
    if (fs.existsSync(candidate)) return candidate
  }
  return 'ollama'
}

async function isOllamaRunning() {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(1500) })
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
      preload: path.join(__dirname, 'preload.cjs'),
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

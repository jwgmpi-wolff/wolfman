const { app, BrowserWindow, shell } = require('electron')
const path = require('node:path')

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Wolfman',
    icon: path.join(__dirname, '../public/wolfman-icon.svg'),
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

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

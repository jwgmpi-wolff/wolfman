const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('wolfmanDesktop', {
  fetchMedia: (url) => ipcRenderer.invoke('wolfman:fetch-media', url),
  ollamaAvailable: () => ipcRenderer.invoke('wolfman:ollama-available'),
  ollamaChat: (body) => ipcRenderer.invoke('wolfman:ollama-chat', body),
})
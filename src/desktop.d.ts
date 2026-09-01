export {}

declare global {
  interface Window {
    wolfmanDesktop?: {
      fetchMedia: (url: string) => Promise<{ base64: string; contentType: string }>
      ollamaAvailable: () => Promise<boolean>
      ollamaChat: (body: unknown) => Promise<unknown>
    }
  }
}
export type MediaDraft = {
  id: string
  kind: 'image' | 'video'
  name: string
  previewUrl: string
  file: File
}

export type PreparedMedia = {
  images: string[]
  note: string
}

const imageExtensions = /\.(avif|gif|jpe?g|png|webp)(?:[?#].*)?$/i
const videoExtensions = /\.(m4v|mov|mp4|mpeg|ogv|webm)(?:[?#].*)?$/i
const urlPattern = /https?:\/\/[^\s<>()]+/gi
const MAX_IMAGE_DIMENSION = 1600
const MAX_LINKED_MEDIA_BYTES = 250 * 1024 * 1024

function findUrls(text: string) {
  return (text.match(urlPattern) ?? []).map((url) => url.replace(/[.,;!?]+$/, ''))
}

export function findMediaUrls(text: string) {
  return findUrls(text)
    .filter((url) => imageExtensions.test(url) || videoExtensions.test(url) || youtubeVideoId(url))
}

export function createMediaDrafts(files: File[]) {
  return files.filter((file) => file.type.startsWith('image/') || file.type.startsWith('video/')).map((file): MediaDraft => ({
    id: crypto.randomUUID(),
    kind: file.type.startsWith('video/') ? 'video' : 'image',
    name: file.name || (file.type.startsWith('video/') ? 'Pasted video' : 'Pasted image'),
    previewUrl: URL.createObjectURL(file),
    file,
  }))
}

function youtubeVideoId(url: string) {
  try {
    const parsed = new URL(url)
    if (parsed.hostname === 'youtu.be') return parsed.pathname.split('/').filter(Boolean)[0] ?? null
    if (parsed.hostname === 'youtube.com' || parsed.hostname.endsWith('.youtube.com')) {
      if (parsed.pathname === '/watch') return parsed.searchParams.get('v')
      const parts = parsed.pathname.split('/').filter(Boolean)
      if (['embed', 'shorts', 'live'].includes(parts[0])) return parts[1] ?? null
    }
  } catch {
    return null
  }
  return null
}

function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('The media could not be read.'))
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.readAsDataURL(blob)
  })
}

async function imageToBase64(blob: Blob) {
  try {
    const bitmap = await createImageBitmap(blob)
    const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Image resizing is unavailable on this device.')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    return canvas.toDataURL('image/jpeg', 0.86).split(',')[1] ?? ''
  } catch {
    return blobToBase64(blob)
  }
}

function mediaKind(blob: Blob, url: string): 'image' | 'video' | null {
  if (blob.type.startsWith('image/') || imageExtensions.test(url)) return 'image'
  if (blob.type.startsWith('video/') || videoExtensions.test(url)) return 'video'
  return null
}

async function fetchBlob(url: string) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) })
    if (!response.ok) throw new Error(`Media URL returned HTTP ${response.status}.`)
    const blob = await response.blob()
    if (blob.size > MAX_LINKED_MEDIA_BYTES) throw new Error('The linked media is larger than 250 MB.')
    return blob
  } catch (error) {
    if (!window.wolfmanDesktop) throw error
    const result = await window.wolfmanDesktop.fetchMedia(url)
    const bytes = Uint8Array.from(atob(result.base64), (character) => character.charCodeAt(0))
    return new Blob([bytes], { type: result.contentType })
  }
}

function waitForMedia(video: HTMLVideoElement, event: 'loadeddata' | 'seeked') {
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error('The video took too long to load.')), 20000)
    const done = () => { window.clearTimeout(timeout); resolve() }
    const failed = () => { window.clearTimeout(timeout); reject(new Error('The video could not be loaded. Use a direct MP4, WebM, or MOV link.')) }
    video.addEventListener(event, done, { once: true })
    video.addEventListener('error', failed, { once: true })
  })
}

async function sampleVideo(source: string) {
  const video = document.createElement('video')
  video.crossOrigin = 'anonymous'
  video.muted = true
  video.preload = 'auto'
  video.src = source
  await waitForMedia(video, 'loadeddata')
  if (!video.videoWidth || !video.videoHeight) throw new Error('The video has no readable frames.')

  const canvas = document.createElement('canvas')
  const scale = Math.min(1, 1280 / video.videoWidth)
  canvas.width = Math.round(video.videoWidth * scale)
  canvas.height = Math.round(video.videoHeight * scale)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Video frame extraction is unavailable on this device.')

  const duration = Number.isFinite(video.duration) ? video.duration : 0
  const timestamps = duration > 1 ? [0, duration * 0.25, duration * 0.5, duration * 0.75] : [0]
  const frames: string[] = []
  for (const timestamp of timestamps) {
    if (timestamp > 0) {
      video.currentTime = Math.min(timestamp, Math.max(0, duration - 0.1))
      await waitForMedia(video, 'seeked')
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height)
    frames.push(canvas.toDataURL('image/jpeg', 0.82).split(',')[1] ?? '')
  }
  video.removeAttribute('src')
  video.load()
  return frames.filter(Boolean)
}

export async function prepareMediaForAgent(text: string, drafts: MediaDraft[]): Promise<PreparedMedia> {
  const images: string[] = []
  const notes: string[] = []

  for (const draft of drafts) {
    if (draft.kind === 'image') images.push(await imageToBase64(draft.file))
    else images.push(...await sampleVideo(draft.previewUrl))
    notes.push(`${draft.kind} attachment: ${draft.name}`)
  }

  for (const url of findUrls(text)) {
    const youtubeId = youtubeVideoId(url)
    if (youtubeId) {
      images.push(await imageToBase64(await fetchBlob(`https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`)))
      notes.push(`YouTube link (representative thumbnail only): ${url}`)
    } else {
      try {
        const blob = await fetchBlob(url)
        const kind = mediaKind(blob, url)
        if (kind === 'image') {
          images.push(await imageToBase64(blob))
          notes.push(`image URL: ${url}`)
        } else if (kind === 'video') {
          const blobUrl = URL.createObjectURL(blob)
          try { images.push(...await sampleVideo(blobUrl)) } finally { URL.revokeObjectURL(blobUrl) }
          notes.push(`video URL sampled at ${url}`)
        }
      } catch (error) {
        if (findMediaUrls(url).length) throw error
      }
    }
  }

  return { images: images.filter(Boolean).slice(0, 8), note: notes.join('\n') }
}
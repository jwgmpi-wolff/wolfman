import { describe, expect, it } from 'vitest'
import { findMediaUrls } from './media'

describe('findMediaUrls', () => {
  it('finds direct image and video links', () => {
    expect(findMediaUrls('Review https://example.com/chart.png and https://cdn.example.com/demo.mp4?download=1.')).toEqual([
      'https://example.com/chart.png',
      'https://cdn.example.com/demo.mp4?download=1',
    ])
  })

  it('recognizes common YouTube link forms and ignores ordinary pages', () => {
    expect(findMediaUrls('Compare https://youtu.be/abc123 with https://www.youtube.com/watch?v=xyz789 and https://example.com/page')).toEqual([
      'https://youtu.be/abc123',
      'https://www.youtube.com/watch?v=xyz789',
    ])
  })
})
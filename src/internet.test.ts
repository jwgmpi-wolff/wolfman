import { describe, it, expect } from 'vitest'
import { extractPlaceQuery } from './internet'

describe('extractPlaceQuery', () => {
  it('strips a phone-number lookup phrase down to the business name', () => {
    expect(extractPlaceQuery('phone number to the local costco')).toBe('costco')
  })

  it('strips "the local" out of a phrase with additional context', () => {
    expect(extractPlaceQuery('phone number to local costco in 98203 area')).toBe('costco in 98203 area')
  })

  it('strips "near me" and leading question phrasing', () => {
    expect(extractPlaceQuery('where can I find thai food near me')).toBe('find thai food')
  })

  it('falls back to the original input when nothing matches', () => {
    expect(extractPlaceQuery('costco')).toBe('costco')
  })
})

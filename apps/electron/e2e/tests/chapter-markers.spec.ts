/**
 * Phase 3.73 — chapter markers → YouTube format.
 *
 * Layer A — pure `markersToChapters` formatter.
 *
 * @phase-3-73-chapter-markers
 */
import { expect, test } from '@playwright/test'
import { markersToChapters } from '../../src/renderer/src/lib/markerExport'

test.describe('@phase-3-73-chapter-markers markersToChapters', () => {
  test('A-1 empty input → empty string', () => {
    expect(markersToChapters([])).toBe('')
  })

  test('A-2 single marker at 0 → one line, no extra Intro inserted', () => {
    const out = markersToChapters([
      { id: 'a', atMs: 0, label: 'Open' }
    ])
    expect(out).toBe('00:00 Open')
  })

  test('A-3 first marker past 100ms → YouTube format prepends Intro at 00:00', () => {
    const out = markersToChapters([
      { id: 'a', atMs: 5000, label: 'Topic' }
    ])
    const lines = out.split('\n')
    expect(lines[0]).toBe('00:00 Intro')
    expect(lines[1]).toBe('00:05 Topic')
  })

  test('A-4 simple format does NOT prepend Intro', () => {
    const out = markersToChapters(
      [{ id: 'a', atMs: 5000, label: 'Topic' }],
      'simple'
    )
    expect(out).toBe('00:05 Topic')
  })

  test('A-5 sort ascending + missing label → "Chapter N" fallback', () => {
    const out = markersToChapters([
      { id: 'b', atMs: 10000 },
      { id: 'a', atMs: 3000, label: 'First' },
      { id: 'c', atMs: 60000, label: '' }
    ])
    const lines = out.split('\n')
    expect(lines[0]).toBe('00:00 Intro')
    expect(lines[1]).toBe('00:03 First')
    expect(lines[2]).toMatch(/^00:10 Chapter \d+$/)
    expect(lines[3]).toMatch(/^01:00 Chapter \d+$/)
  })

  test('A-6 last marker ≥ 1h → all lines switch to HH:MM:SS', () => {
    const out = markersToChapters([
      { id: 'a', atMs: 0, label: 'Open' },
      { id: 'b', atMs: 3600 * 1000 + 5000, label: 'Late' }
    ])
    const lines = out.split('\n')
    expect(lines[0]).toBe('00:00:00 Open')
    expect(lines[1]).toBe('01:00:05 Late')
  })
})

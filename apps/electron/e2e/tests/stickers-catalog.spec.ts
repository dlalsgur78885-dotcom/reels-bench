/**
 * Phase 3.67 — sticker library expansion (~48 → ~170 emoji + 16 SVG).
 *
 * Catalog growth + id integrity + new categories present + per-category
 * size sanity. The render / persistence pipeline is unchanged — adding
 * library entries is pure data.
 *
 * @phase-3-67-stickers
 */
import { expect, test } from '@playwright/test'
import {
  EMOJI_LIBRARY,
  STICKER_CATEGORY_LABELS,
  type StickerCategory
} from '../../src/shared/bundledStickers'

test.describe('@phase-3-67-stickers sticker catalog expansion', () => {
  test('A-1 emoji count grew from 48 baseline to >= 150', () => {
    expect(EMOJI_LIBRARY.length).toBeGreaterThanOrEqual(150)
  })

  test('A-2 four new categories present: animals / food / nature / symbols', () => {
    expect(STICKER_CATEGORY_LABELS.animals).toBeTruthy()
    expect(STICKER_CATEGORY_LABELS.food).toBeTruthy()
    expect(STICKER_CATEGORY_LABELS.nature).toBeTruthy()
    expect(STICKER_CATEGORY_LABELS.symbols).toBeTruthy()
  })

  test('A-3 each of the 8 emoji categories has at least 10 entries', () => {
    const counts = new Map<StickerCategory, number>()
    for (const e of EMOJI_LIBRARY) {
      counts.set(e.category, (counts.get(e.category) ?? 0) + 1)
    }
    const cats: StickerCategory[] = [
      'faces',
      'reactions',
      'gestures',
      'objects',
      'animals',
      'food',
      'nature',
      'symbols'
    ]
    for (const c of cats) {
      expect(counts.get(c) ?? 0, `category ${c}`).toBeGreaterThanOrEqual(10)
    }
  })

  test('A-4 every emoji id is unique kebab-case + has char + label', () => {
    const seen = new Set<string>()
    for (const e of EMOJI_LIBRARY) {
      expect(/^[a-z0-9][a-z0-9-]*$/.test(e.id), `bad id ${e.id}`).toBe(true)
      expect(seen.has(e.id), `duplicate id ${e.id}`).toBe(false)
      seen.add(e.id)
      expect(e.char.length).toBeGreaterThan(0)
      expect(e.label.length).toBeGreaterThan(0)
    }
  })
})

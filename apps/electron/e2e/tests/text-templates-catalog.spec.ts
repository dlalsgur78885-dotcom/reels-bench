/**
 * Phase 3.62 — text-template library expansion (10 → 35).
 *
 * Catalog-level invariants only (the existing text-templates apply / insert
 * flow is covered by other specs; here we just guard the catalog growth +
 * id/label/category integrity so future additions stay disciplined).
 *
 * @phase-3-62-text-templates
 */
import { expect, test } from '@playwright/test'
import {
  TEXT_TEMPLATES,
  TEXT_TEMPLATE_CATEGORY_LABELS,
  type TextTemplateCategory
} from '../../src/shared/textTemplates'

test.describe('@phase-3-62-text-templates text template catalog', () => {
  test('A-1 grew from the 10-item baseline to >= 30 templates', () => {
    expect(TEXT_TEMPLATES.length).toBeGreaterThanOrEqual(30)
  })

  test('A-2 every category has at least 5 templates after the expansion', () => {
    const counts = new Map<TextTemplateCategory, number>()
    for (const t of TEXT_TEMPLATES) {
      counts.set(t.category, (counts.get(t.category) ?? 0) + 1)
    }
    for (const cat of Object.keys(
      TEXT_TEMPLATE_CATEGORY_LABELS
    ) as TextTemplateCategory[]) {
      expect(counts.get(cat) ?? 0, `category ${cat}`).toBeGreaterThanOrEqual(5)
    }
  })

  test('A-3 ids are unique kebab-case + every template has a label and ≥ 1 span', () => {
    const seen = new Set<string>()
    for (const t of TEXT_TEMPLATES) {
      expect(/^[a-z0-9][a-z0-9-]*$/.test(t.id), `id ${t.id}`).toBe(true)
      expect(seen.has(t.id), `duplicate id ${t.id}`).toBe(false)
      seen.add(t.id)
      expect(t.label.length).toBeGreaterThan(0)
      expect(t.spans.length).toBeGreaterThan(0)
      // durationMs in plausible range — guards against accidental 0 / NaN.
      expect(t.durationMs).toBeGreaterThan(0)
      expect(t.durationMs).toBeLessThanOrEqual(15000)
    }
  })

  test('A-4 every template references a known category', () => {
    const known = new Set(Object.keys(TEXT_TEMPLATE_CATEGORY_LABELS))
    for (const t of TEXT_TEMPLATES) {
      expect(known.has(t.category), `category ${t.category} on ${t.id}`).toBe(
        true
      )
    }
  })
})

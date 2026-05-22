// Brand Kit store (Phase — 브랜드 키트).
//
// An app-level Zustand store, INDEPENDENT of `useProjectStore`: it has no
// zundo temporal middleware and is never written into the project file, so
// editing a brand color / font / logo NEVER touches the project undo stack.
//
// Persistence is handled by the main process via `window.electron.brandKit`
// (userData/brand-kit.json). Color/font edits are written back debounced
// (~400ms) so a flurry of swatch edits collapses into one disk write.
import { create } from 'zustand'
import type {
  BrandKit,
  BrandLogo,
  BrandLogoVariant
} from '../../../shared/ipc'

/** Cap on stored brand colors (mirrors the contract in ipc.ts). */
export const MAX_BRAND_COLORS = 24

/** Empty kit used before the first `load()` resolves. */
const EMPTY_KIT: BrandKit = { version: 1, logos: [], colors: [] }

/**
 * Normalize a user-supplied hex string:
 *   - trims, lowercases, ensures a leading `#`
 *   - expands the `#rgb` short form to `#rrggbb`
 *   - returns `null` for anything that isn't a valid 3/6-digit hex
 */
export function normalizeHex(input: string): string | null {
  if (typeof input !== 'string') return null
  let s = input.trim().toLowerCase()
  if (!s) return null
  if (!s.startsWith('#')) s = `#${s}`
  if (/^#[0-9a-f]{3}$/.test(s)) {
    // #rgb -> #rrggbb
    return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`
  }
  if (/^#[0-9a-f]{6}$/.test(s)) return s
  return null
}

interface BrandKitStore {
  /** In-memory brand kit (mirrors disk; updated optimistically). */
  kit: BrandKit
  /** True once `load()` has resolved at least once. */
  loaded: boolean
  /** Last error surfaced by an IPC call (null when healthy). */
  error: string | null

  /** Read the kit from disk; caches into `kit`. Idempotent. */
  load(): Promise<void>
  /** Add a normalized hex color (deduped, capped at MAX_BRAND_COLORS). */
  addColor(hex: string): void
  /** Remove a color by exact (normalized) hex. */
  removeColor(hex: string): void
  /** Replace the whole color list. */
  setColors(colors: string[]): void
  /** Set the brand font family name (empty string clears it). */
  setFontFamily(name: string): void
  /** Pick an image file and import it as the variant's logo. */
  importLogo(variant: BrandLogoVariant): Promise<void>
  /** Remove a logo variant. */
  removeLogo(variant: BrandLogoVariant): Promise<void>
}

// --- Debounced write -------------------------------------------------------
// A single shared timer collapses rapid color/font edits into one disk write.
let writeTimer: ReturnType<typeof setTimeout> | null = null

function scheduleWrite(getKit: () => BrandKit, onError: (e: string) => void) {
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = setTimeout(() => {
    writeTimer = null
    const kit = getKit()
    void window.electron.brandKit
      .write({ colors: kit.colors, fontFamily: kit.fontFamily })
      .catch((e: unknown) => {
        onError(e instanceof Error ? e.message : String(e))
      })
  }, 400)
}

export const useBrandKit = create<BrandKitStore>((set, get) => ({
  kit: EMPTY_KIT,
  loaded: false,
  error: null,

  async load(): Promise<void> {
    try {
      const kit = await window.electron.brandKit.read()
      set({ kit, loaded: true, error: null })
    } catch (e) {
      set({
        loaded: true,
        error: e instanceof Error ? e.message : String(e)
      })
    }
  },

  addColor(hex: string): void {
    const norm = normalizeHex(hex)
    if (!norm) {
      set({ error: `잘못된 색상 코드: ${hex}` })
      return
    }
    const cur = get().kit
    if (cur.colors.includes(norm)) return
    if (cur.colors.length >= MAX_BRAND_COLORS) {
      set({ error: `브랜드 컬러는 최대 ${MAX_BRAND_COLORS}개까지 저장돼요` })
      return
    }
    const next: BrandKit = { ...cur, colors: [...cur.colors, norm] }
    set({ kit: next, error: null })
    scheduleWrite(() => get().kit, (e) => set({ error: e }))
  },

  removeColor(hex: string): void {
    const cur = get().kit
    const target = normalizeHex(hex) ?? hex
    if (!cur.colors.includes(target)) return
    const next: BrandKit = {
      ...cur,
      colors: cur.colors.filter((c) => c !== target)
    }
    set({ kit: next })
    scheduleWrite(() => get().kit, (e) => set({ error: e }))
  },

  setColors(colors: string[]): void {
    const seen = new Set<string>()
    const clean: string[] = []
    for (const c of colors) {
      const norm = normalizeHex(c)
      if (!norm || seen.has(norm)) continue
      seen.add(norm)
      clean.push(norm)
      if (clean.length >= MAX_BRAND_COLORS) break
    }
    const next: BrandKit = { ...get().kit, colors: clean }
    set({ kit: next })
    scheduleWrite(() => get().kit, (e) => set({ error: e }))
  },

  setFontFamily(name: string): void {
    const trimmed = name.trim()
    const cur = get().kit
    const next: BrandKit = { ...cur }
    if (trimmed) next.fontFamily = trimmed
    else delete next.fontFamily
    set({ kit: next })
    scheduleWrite(() => get().kit, (e) => set({ error: e }))
  },

  async importLogo(variant: BrandLogoVariant): Promise<void> {
    try {
      if (!window.electron?.fs?.pickFiles) {
        set({ error: '파일 선택을 사용할 수 없습니다' })
        return
      }
      const picked = await window.electron.fs.pickFiles({
        filters: [
          { name: '이미지', extensions: ['png', 'jpg', 'jpeg', 'webp'] }
        ]
      })
      if (!picked || picked.length === 0) return
      const result = await window.electron.brandKit.importLogo(
        variant,
        picked[0]
      )
      if (!result.ok) {
        set({ error: `로고 추가 실패: ${result.error}` })
        return
      }
      // Merge the returned logo, replacing any existing logo of the variant.
      const logo: BrandLogo = result.logo
      const cur = get().kit
      const logos = [
        ...cur.logos.filter((l) => l.variant !== logo.variant),
        logo
      ]
      set({ kit: { ...cur, logos }, error: null })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
    }
  },

  async removeLogo(variant: BrandLogoVariant): Promise<void> {
    try {
      const kit = await window.electron.brandKit.removeLogo(variant)
      set({ kit, error: null })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
    }
  }
}))

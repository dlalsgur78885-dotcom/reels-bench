/**
 * Phase 4-WebAudio — preview audio routing graph.
 *
 * Replaces the legacy "one <audio> element with el.volume mutation" preview
 * with an AudioContext-based mixer so that:
 *
 *   - Multiple audio clips (across tracks) can play SIMULTANEOUSLY in
 *     preview (e.g. BGM track + voice track) instead of last-write-wins on a
 *     shared <audio> element.
 *   - Mute / solo / ducking apply via per-track GainNodes, which support
 *     `linearRampToValueAtTime` for click-free transitions.
 *   - The whole preview can be attenuated by a single master GainNode
 *     (future master-volume UI slider — infra only; no UI yet).
 *
 * Architecture
 * ------------
 *
 *   <video> / <audio> el  →  MediaElementAudioSourceNode  →  trackGain
 *                                                              ↓
 *                                                          masterGain
 *                                                              ↓
 *                                                          destination
 *
 * Invariants
 * ----------
 *
 * 1. WRAP-ONCE: `ctx.createMediaElementSource(el)` throws InvalidStateError
 *    if called twice for the same element. We cache the source node by a
 *    stable string id (set on the element via `data-audio-graph-id`) and
 *    early-return the cached node on subsequent attach() calls.
 *
 * 2. After wrapping, the element's audio is routed exclusively via WebAudio.
 *    We force `el.volume = 1` and `el.muted = false` once and never touch
 *    them again — all attenuation goes through the per-track GainNode.
 *    (If both were applied, gains would compound and ducking math would
 *    silently double-attenuate.)
 *
 * 3. Lazy AudioContext: created on the first attach(). Browser autoplay
 *    policy may put it in 'suspended' state until a user gesture; callers
 *    should invoke resume() from a click/keydown handler.
 *
 * 4. Graceful fallback: if AudioContext construction or
 *    createMediaElementSource fails (very rare on modern Chromium, but can
 *    happen if a media element is cross-origin without CORS headers), the
 *    methods are no-ops and the element falls back to plain HTMLMediaElement
 *    playback. PreviewCanvas's track-mute / clip-gain still works via the
 *    `setElementFallbackGain` escape hatch.
 */

/** Convert decibels → linear gain. -60dB → 0.001, 0dB → 1.0, +12dB → 3.98. */
export function dbToLinear(db: number): number {
  if (!Number.isFinite(db)) return 0
  if (db <= -120) return 0
  return Math.pow(10, db / 20)
}

/** Detect if WebAudio is usable in this environment. */
function isWebAudioAvailable(): boolean {
  if (typeof window === 'undefined') return false
  return typeof window.AudioContext !== 'undefined'
}

type GraphState = 'idle' | 'ready' | 'failed'

/**
 * Stable element-id property. Set lazily on first attach() so the same
 * HTMLMediaElement is recognized across rerenders.
 */
const ELEMENT_ID_PROP = '__reelsAudioGraphId'

interface TaggedElement extends HTMLMediaElement {
  [ELEMENT_ID_PROP]?: string
}

let _nextElId = 1
function getOrAssignElementId(el: HTMLMediaElement): string {
  const tagged = el as TaggedElement
  if (!tagged[ELEMENT_ID_PROP]) {
    tagged[ELEMENT_ID_PROP] = `el${_nextElId++}`
  }
  return tagged[ELEMENT_ID_PROP] as string
}

export class PreviewAudioGraph {
  private state: GraphState = 'idle'
  private ctx: AudioContext | null = null
  private masterGain: GainNode | null = null
  /**
   * Phase 3.58 — master output analyser. Tapped AFTER masterGain so the
   * meter reflects what the user actually hears (including ducking + master
   * attenuation). Null until the context is ready.
   */
  private masterAnalyser: AnalyserNode | null = null
  /**
   * Reusable Float32Array buffer for `getFloatTimeDomainData`. Avoids
   * allocating per frame in the UI poll loop. Sized to the analyser's
   * fftSize.
   */
  private analyserBuf: Float32Array | null = null
  /** Per-track output gain. Created lazily on first setTrackGain or attach. */
  private trackGains: Map<string, GainNode> = new Map()
  /**
   * Most-recently-requested target gain per track. We track this separately
   * because reading `GainNode.gain.value` after a `linearRampToValueAtTime`
   * is unreliable across Chromium versions — some implementations return
   * the underlying `value` property (which we never explicitly mutate) and
   * not the time-evolving automation result. Tests rely on this map to
   * verify intent, decoupled from the audio clock.
   */
  private trackTargetGains: Map<string, number> = new Map()
  private masterTargetGain = 1
  /** Cached source nodes keyed by element id (see WRAP-ONCE invariant). */
  private sources: Map<string, MediaElementAudioSourceNode> = new Map()
  /** Track id assigned to each cached source — used by detach() and re-attach. */
  private sourceTracks: Map<string, string> = new Map()

  /**
   * Lazily construct the AudioContext + masterGain. No-op if already built
   * or if WebAudio is unavailable.
   */
  private ensureContext(): boolean {
    if (this.state === 'ready') return true
    if (this.state === 'failed') return false
    if (!isWebAudioAvailable()) {
      this.state = 'failed'
      return false
    }
    try {
      const Ctor = window.AudioContext
      this.ctx = new Ctor()
      this.masterGain = this.ctx.createGain()
      this.masterGain.gain.value = 1
      // Phase 3.58 — insert master AnalyserNode between masterGain and
      // destination so the meter sees the post-master signal:
      //   masterGain → masterAnalyser → destination
      this.masterAnalyser = this.ctx.createAnalyser()
      this.masterAnalyser.fftSize = 2048
      this.masterAnalyser.smoothingTimeConstant = 0
      this.analyserBuf = new Float32Array(this.masterAnalyser.fftSize)
      this.masterGain.connect(this.masterAnalyser)
      this.masterAnalyser.connect(this.ctx.destination)
      this.state = 'ready'
      return true
    } catch {
      this.state = 'failed'
      this.ctx = null
      this.masterGain = null
      this.masterAnalyser = null
      this.analyserBuf = null
      return false
    }
  }

  /**
   * Phase 3.58 — read instantaneous master meter levels.
   *
   * Returns peak (max abs sample) and RMS (root-mean-square) of the most
   * recent fftSize-sample window, both in dBFS (negative; 0 dBFS = full
   * scale; silence → -Infinity).
   *
   * Graceful: when WebAudio isn't ready (suspended context before user
   * gesture / failed graph), returns `{ peak: -Infinity, rms: -Infinity }`.
   * The UI meter renders an empty bar from those values.
   */
  getMasterLevels(): { peak: number; rms: number } {
    if (
      this.state !== 'ready' ||
      !this.masterAnalyser ||
      !this.analyserBuf
    ) {
      return { peak: -Infinity, rms: -Infinity }
    }
    const buf = this.analyserBuf
    // The Web Audio API's TS signature wants Float32Array<ArrayBuffer>; our
    // `new Float32Array(n)` produces Float32Array<ArrayBufferLike>. Cast —
    // the runtime call is identical.
    this.masterAnalyser.getFloatTimeDomainData(
      buf as unknown as Float32Array<ArrayBuffer>
    )
    let peak = 0
    let sumSq = 0
    for (let i = 0; i < buf.length; i++) {
      const s = buf[i]
      const a = s < 0 ? -s : s
      if (a > peak) peak = a
      sumSq += s * s
    }
    const rmsLinear = Math.sqrt(sumSq / buf.length)
    const peakDb = peak > 0 ? 20 * Math.log10(peak) : -Infinity
    const rmsDb = rmsLinear > 0 ? 20 * Math.log10(rmsLinear) : -Infinity
    return { peak: peakDb, rms: rmsDb }
  }

  /** Get-or-create the GainNode for a track. */
  private getTrackGain(trackId: string): GainNode | null {
    if (!this.ensureContext() || !this.ctx || !this.masterGain) return null
    const cached = this.trackGains.get(trackId)
    if (cached) return cached
    const g = this.ctx.createGain()
    g.gain.value = 1
    g.connect(this.masterGain)
    this.trackGains.set(trackId, g)
    return g
  }

  /**
   * Wire a media element through `source → trackGain → masterGain →
   * destination`. WRAP-ONCE: subsequent calls for the same element are
   * idempotent. If the element is later re-attached under a different
   * trackId, we rewire the cached source to the new track gain.
   *
   * Returns true if the element is now routed through WebAudio, false on
   * failure (caller should fall back to HTMLMediaElement.volume control).
   */
  attach(el: HTMLMediaElement, trackId: string): boolean {
    if (!this.ensureContext() || !this.ctx) return false
    const trackGain = this.getTrackGain(trackId)
    if (!trackGain) return false

    const id = getOrAssignElementId(el)
    let source = this.sources.get(id)

    if (!source) {
      try {
        source = this.ctx.createMediaElementSource(el)
        this.sources.set(id, source)
      } catch {
        // InvalidStateError or NotSupportedError — most commonly:
        //   1) the element was already wrapped (e.g. detach() ran between
        //      ref-callback bounces and we lost the cache, but the DOM
        //      element still carries the "already connected" mark in
        //      Chromium), or
        //   2) the source can't be created for security reasons.
        // Either way, fall back to plain HTML5 playback; the renderer will
        // use `el.volume`/`el.muted` directly.
        return false
      }
      // After wrapping, ALL attenuation flows through the GainNode. Force
      // the element to "unity passthrough" so we don't double-attenuate.
      try {
        el.volume = 1
        el.muted = false
      } catch {
        /* read-only on some sandboxed iframes — ignore */
      }
    }

    // If the element was previously attached to a different track, rewire.
    const prevTrack = this.sourceTracks.get(id)
    if (prevTrack && prevTrack !== trackId) {
      try {
        source.disconnect()
      } catch {
        /* idempotent */
      }
      source.connect(trackGain)
    } else if (!prevTrack) {
      source.connect(trackGain)
    }
    this.sourceTracks.set(id, trackId)
    return true
  }

  /**
   * Disconnect and drop the cached source for an element. Called on element
   * unmount. NOTE: per the WebAudio spec, once createMediaElementSource has
   * been called for an element, the element can NEVER be re-wrapped (even
   * after disconnect). So in practice we keep the cache entry alive — the
   * element should be the same React-managed <audio> across rerenders.
   *
   * If the element really is going away (e.g. track removed), we still
   * disconnect to free graph resources.
   */
  detach(el: HTMLMediaElement): void {
    const tagged = el as TaggedElement
    const id = tagged[ELEMENT_ID_PROP]
    if (!id) return
    const source = this.sources.get(id)
    if (source) {
      try {
        source.disconnect()
      } catch {
        /* idempotent */
      }
      this.sources.delete(id)
    }
    this.sourceTracks.delete(id)
  }

  /**
   * Set the GainNode for a track using a click-free linear ramp.
   *
   * @param trackId  Track identifier (Track.id from the project model).
   * @param gainLinear  Target linear gain (0..N). Use dbToLinear() to convert.
   * @param rampMs  Ramp duration in ms. Default 20ms — fast enough that
   *   ducking feels instantaneous to the ear but slow enough to avoid the
   *   audible click of an instantaneous value change.
   */
  setTrackGain(trackId: string, gainLinear: number, rampMs = 20): void {
    const g = this.getTrackGain(trackId)
    if (!g || !this.ctx) return
    const target = Math.max(0, Math.min(4, gainLinear))
    const ramp = Math.max(0, rampMs) / 1000
    const now = this.ctx.currentTime
    // Record the requested target — readTrackGains() will surface this
    // regardless of where the audio clock is in any in-flight ramp.
    this.trackTargetGains.set(trackId, target)
    try {
      // cancelScheduledValues clears any in-flight ramp so back-to-back
      // setTrackGain calls don't queue up and drift behind the playhead.
      g.gain.cancelScheduledValues(now)
      g.gain.setValueAtTime(g.gain.value, now)
      if (ramp <= 0) {
        g.gain.setValueAtTime(target, now)
      } else {
        g.gain.linearRampToValueAtTime(target, now + ramp)
      }
    } catch {
      // Fallback to instant assignment on AudioParam errors.
      g.gain.value = target
    }
  }

  /** Set the master gain (future global volume slider). */
  setMasterGain(gainLinear: number, rampMs = 20): void {
    if (!this.ensureContext() || !this.masterGain || !this.ctx) return
    const target = Math.max(0, Math.min(4, gainLinear))
    const ramp = Math.max(0, rampMs) / 1000
    const now = this.ctx.currentTime
    this.masterTargetGain = target
    try {
      this.masterGain.gain.cancelScheduledValues(now)
      this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now)
      if (ramp <= 0) this.masterGain.gain.setValueAtTime(target, now)
      else this.masterGain.gain.linearRampToValueAtTime(target, now + ramp)
    } catch {
      this.masterGain.gain.value = target
    }
  }

  /**
   * Resume a suspended AudioContext (browser autoplay policy). Must be
   * called from within a user-gesture handler — otherwise the promise
   * rejects silently.
   */
  async resume(): Promise<void> {
    if (!this.ensureContext() || !this.ctx) return
    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume()
      } catch {
        /* user gesture not yet granted; will retry on next call */
      }
    }
  }

  /** AudioContext state — 'suspended' | 'running' | 'closed' | 'unavailable'. */
  getState(): AudioContextState | 'unavailable' {
    if (this.state === 'failed') return 'unavailable'
    if (!this.ctx) return 'unavailable'
    return this.ctx.state
  }

  /** True if WebAudio routing is operational. */
  isReady(): boolean {
    return this.state === 'ready'
  }

  // -------------------------------------------------------------------------
  // Test bridge introspection.
  // -------------------------------------------------------------------------
  /**
   * Read-only snapshot of target track gains (the most recent value passed
   * to `setTrackGain()`). We expose this instead of the live
   * `node.gain.value` because Chromium's AudioParam getter is inconsistent
   * about reporting time-evolving automation curves. The target gain map
   * answers "what does the renderer want this track to be?", which is
   * exactly what tests need.
   */
  readTrackGains(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [tid, target] of this.trackTargetGains.entries()) {
      out[tid] = target
    }
    return out
  }

  /** Live `gain.value` per track — useful for inspecting ramp progress. */
  readLiveTrackGains(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [tid, node] of this.trackGains.entries()) {
      out[tid] = node.gain.value
    }
    return out
  }

  /** Count of attached source nodes (== number of WebAudio-routed elements). */
  readSourceCount(): number {
    return this.sources.size
  }
}

// ---------------------------------------------------------------------------
// Singleton-per-page. Survives Editor remounts so AudioContext state and
// scheduled ramps don't reset.
// ---------------------------------------------------------------------------
let _singleton: PreviewAudioGraph | null = null
export function getPreviewAudioGraph(): PreviewAudioGraph {
  if (!_singleton) _singleton = new PreviewAudioGraph()
  return _singleton
}

/**
 * Install a one-shot listener that resumes the AudioContext on the first
 * user gesture anywhere on the page. Returns the unsubscribe function.
 *
 * Called from Editor on mount. Cheap — just two `once: true` listeners.
 */
export function installAutoResume(): () => void {
  const graph = getPreviewAudioGraph()
  const handler = (): void => {
    void graph.resume()
  }
  const opts: AddEventListenerOptions = { once: true, capture: true }
  // pointerdown is the most reliable across mouse + touch + pen.
  window.addEventListener('pointerdown', handler, opts)
  window.addEventListener('keydown', handler, opts)
  return () => {
    window.removeEventListener('pointerdown', handler, opts)
    window.removeEventListener('keydown', handler, opts)
  }
}

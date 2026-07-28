/**
 * The Spotify connection: polling, playhead, and palette extraction.
 *
 * Owns everything that talks to Spotify and pushes results into the bus. The
 * bus, and therefore every mode, has no idea this exists — it only ever sees a
 * palette, a track and a playhead, exactly as it does without Spotify.
 *
 * **Do not add `/v1/audio-features` or `/v1/audio-analysis` calls here.** They
 * return 403 for any app registered after November 2024. All rhythmic
 * information comes from the microphone; this supplies colour and identity.
 */
import type { SignalBus } from '../signal/bus'
import type { TrackInfo } from '../signal/types'
import { paletteFromArtwork } from './albumPalette'
import { Playhead } from './playhead'
import { clearToken, loadToken, needsRefresh, refreshToken } from './auth'
import type { StoredToken } from './auth'

/** Spotify's guidance is not to poll faster than this. Rate limits are real. */
const POLL_INTERVAL_MS = 4000
/** Back off hard on 429 rather than hammering a rate-limited endpoint. */
const RATE_LIMIT_BACKOFF_MS = 30_000

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface SpotifyStatus {
  state: ConnectionState
  track: TrackInfo | null
  /** Human-readable, for the settings panel only. Never shown on the canvas. */
  message: string | null
}

export class SpotifyClient {
  private token: StoredToken | null = null
  private timer: number | null = null
  private frameTimer: number | null = null
  private playhead = new Playhead(performance.now())
  private currentTrackId: string | null = null
  private disposed = false
  private backoffUntil = 0

  private status: SpotifyStatus = { state: 'disconnected', track: null, message: null }

  constructor(
    private clientId: string,
    private bus: SignalBus,
    private onStatus: (status: SpotifyStatus) => void,
  ) {}

  start(token: StoredToken): void {
    this.token = token
    this.setStatus({ state: 'connecting', track: null, message: null })
    void this.poll()
    this.timer = window.setInterval(() => void this.poll(), POLL_INTERVAL_MS)
    // Advancing the playhead on its own timer rather than in the render loop
    // keeps the bus free of any Spotify awareness.
    this.frameTimer = window.setInterval(() => {
      this.playhead.advance(performance.now())
      this.bus.setPlayhead(this.playhead.fraction)
    }, 100)
  }

  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer)
    if (this.frameTimer !== null) window.clearInterval(this.frameTimer)
    this.timer = null
    this.frameTimer = null
    this.bus.setTrack(null)
    this.bus.setPlayhead(null)
    this.currentTrackId = null
    this.setStatus({ state: 'disconnected', track: null, message: null })
  }

  dispose(): void {
    this.disposed = true
    this.stop()
  }

  private setStatus(status: SpotifyStatus): void {
    this.status = status
    this.onStatus(status)
  }

  private async authorisedFetch(url: string): Promise<Response | null> {
    if (!this.token) return null

    if (needsRefresh(this.token)) {
      const renewed = await refreshToken(this.clientId, this.token)
      if (!renewed) {
        // Refresh failed: the app was revoked, or the refresh token expired.
        // Degrade silently — never an error wall.
        this.token = null
        clearToken()
        this.stop()
        return null
      }
      this.token = renewed
    }

    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.token.accessToken}` },
      })

      if (response.status === 401) {
        // Token rejected despite not looking expired. One refresh attempt,
        // then give up rather than looping.
        const renewed = await refreshToken(this.clientId, this.token)
        if (!renewed) {
          this.token = null
          clearToken()
          this.stop()
          return null
        }
        this.token = renewed
        return fetch(url, {
          headers: { Authorization: `Bearer ${renewed.accessToken}` },
        })
      }

      if (response.status === 429) {
        const retryAfter = Number(response.headers.get('Retry-After') ?? '0')
        this.backoffUntil =
          Date.now() + (retryAfter > 0 ? retryAfter * 1000 : RATE_LIMIT_BACKOFF_MS)
        return null
      }

      return response
    } catch {
      // Offline, DNS failure, blocked. Keep the last known palette.
      return null
    }
  }

  private async poll(): Promise<void> {
    if (this.disposed || Date.now() < this.backoffUntil) return

    const response = await this.authorisedFetch(
      'https://api.spotify.com/v1/me/player/currently-playing',
    )
    if (!response) return

    // 204: authenticated fine, nothing playing. Not an error.
    if (response.status === 204) {
      this.bus.setTrack(null)
      this.bus.setPlayhead(null)
      this.currentTrackId = null
      this.setStatus({ state: 'connected', track: null, message: 'Nothing playing' })
      return
    }

    if (!response.ok) return

    let data: any
    try {
      data = await response.json()
    } catch {
      return
    }

    const item = data?.item
    if (!item) {
      // Playing something that is not a track — a podcast or a local file.
      this.bus.setTrack(null)
      this.bus.setPlayhead(null)
      this.setStatus({ state: 'connected', track: null, message: 'Nothing playing' })
      return
    }

    const artwork: string | null = item.album?.images?.[0]?.url ?? null
    const track: TrackInfo = {
      id: item.id ?? item.uri ?? 'unknown',
      title: item.name ?? '',
      artist: (item.artists ?? []).map((a: any) => a.name).filter(Boolean).join(', '),
      album: item.album?.name ?? '',
      artworkUrl: artwork,
      durationMs: item.duration_ms ?? 0,
    }

    const sample = {
      progressMs: data.progress_ms ?? 0,
      durationMs: track.durationMs,
      isPlaying: Boolean(data.is_playing),
    }

    const changed = track.id !== this.currentTrackId
    if (changed) {
      this.currentTrackId = track.id
      this.playhead.reset(sample, performance.now())
      this.bus.setTrack(track)
      this.setStatus({ state: 'connected', track, message: null })
      // Fire and forget: the palette arriving a moment later just means the
      // crossfade starts a moment later, which nobody can perceive.
      void this.applyPalette(track)
    } else {
      this.playhead.sync(sample, performance.now())
      if (this.status.track?.id !== track.id) {
        this.setStatus({ state: 'connected', track, message: null })
      }
    }

    this.bus.setPlayhead(this.playhead.fraction)
  }

  private async applyPalette(track: TrackInfo): Promise<void> {
    if (!track.artworkUrl) return
    const palette = await paletteFromArtwork(track.artworkUrl, track.id)
    if (this.disposed || !palette) return
    // Guard against a slow extraction landing after the user has skipped on.
    if (this.currentTrackId !== track.id) return
    // Not immediate: the bus crossfades over ~2s. Colour never hard-cuts.
    this.bus.setPalette(palette)
  }
}

export { loadToken }

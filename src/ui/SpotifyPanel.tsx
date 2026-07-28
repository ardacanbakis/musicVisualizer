/**
 * Spotify controls, settings-panel only.
 *
 * Nothing here ever reaches the canvas. A connection failure, an expired
 * token, a missing client id — all of it is reported in this panel and nowhere
 * else, because the visualiser has to keep running and looking finished
 * whatever Spotify is doing.
 *
 * The client id lives here rather than in a build constant so anyone can point
 * their own deployment at their own Spotify app without rebuilding. It is not
 * a secret; it appears in the authorize URL of every Spotify web app.
 */
import { useState } from 'react'
import type { SpotifyStatus } from '../spotify/client'
import { redirectUri } from '../spotify/auth'

interface SpotifyPanelProps {
  clientId: string
  onClientId: (id: string) => void
  status: SpotifyStatus
  onConnect: () => void
  onDisconnect: () => void
  showNowPlaying: boolean
  onShowNowPlaying: (on: boolean) => void
}

const PALETTE_TEXT: Record<string, string> = {
  pending: 'Reading album colours…',
  applied: 'Palette is following the album art',
  unavailable: 'Using the built-in palette',
  off: 'Album colours off',
}

export function SpotifyPanel({
  clientId,
  onClientId,
  status,
  onConnect,
  onDisconnect,
  showNowPlaying,
  onShowNowPlaying,
}: SpotifyPanelProps) {
  const [showSetup, setShowSetup] = useState(false)
  const [draft, setDraft] = useState(clientId)

  const connected = status.state === 'connected'

  return (
    <div className="flex flex-col gap-2">
      {connected && status.track ? (
        <div className="flex flex-col gap-0.5">
          <span className="truncate text-xs text-white/90" title={status.track.title}>
            {status.track.title}
          </span>
          <span className="truncate text-[11px] text-white/45" title={status.track.artist}>
            {status.track.artist}
          </span>
          {/* What actually happened to the palette. Without this the whole
              connection looks like it does nothing whenever extraction fails,
              which it can for perfectly ordinary reasons. */}
          <span
            className={`mt-1 text-[10px] ${
              status.palette === 'applied' ? 'text-emerald-200/50' : 'text-white/30'
            }`}
          >
            {PALETTE_TEXT[status.palette ?? ''] ?? ''}
            {status.paletteDetail ? ` — ${status.paletteDetail}` : ''}
          </span>
        </div>
      ) : (
        <p className="text-[11px] leading-snug text-white/40">
          {status.message ??
            'Optional. Supplies the colour palette and track name; all rhythm still comes from the microphone.'}
        </p>
      )}

      {connected ? (
        <button
          onClick={onDisconnect}
          className="rounded-lg border border-white/15 px-3 py-1.5 text-left text-xs transition hover:bg-white/10"
        >
          Disconnect Spotify
        </button>
      ) : (
        <button
          onClick={onConnect}
          disabled={!clientId || status.state === 'connecting'}
          className="rounded-lg border border-emerald-400/25 bg-emerald-400/10 px-3 py-1.5 text-left text-xs text-emerald-100/90 transition hover:bg-emerald-400/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {status.state === 'connecting' ? 'Connecting…' : 'Connect Spotify'}
        </button>
      )}

      {!clientId && (
        <p className="text-[10px] leading-snug text-amber-200/50">
          Needs a Spotify client id first.
        </p>
      )}

      {connected && (
        <label className="flex cursor-pointer items-center justify-between gap-2">
          <span className="text-xs text-white/70">Now Playing card</span>
          <input
            type="checkbox"
            checked={showNowPlaying}
            onChange={(e) => onShowNowPlaying(e.target.checked)}
            className="h-3.5 w-3.5 accent-white/80"
          />
        </label>
      )}

      <button
        onClick={() => setShowSetup((s) => !s)}
        className="self-start text-[10px] text-white/35 underline underline-offset-2 hover:text-white/70"
      >
        {showSetup ? 'Hide setup' : 'Setup'}
      </button>

      {showSetup && (
        <div className="flex flex-col gap-2 rounded-md border border-white/10 bg-black/40 p-2">
          <ol className="list-decimal space-y-1 pl-4 text-[10px] leading-snug text-white/40">
            <li>
              Create an app at{' '}
              <a
                href="https://developer.spotify.com/dashboard"
                target="_blank"
                rel="noopener noreferrer"
                className="text-white/60 underline underline-offset-2"
              >
                developer.spotify.com
              </a>
              .
            </li>
            <li>
              Add this exact redirect URI:
              <code className="mt-0.5 block break-all rounded bg-black/60 px-1 py-0.5 text-[9px] text-emerald-200/70">
                {redirectUri()}
              </code>
            </li>
            <li>Paste the client id below.</li>
          </ol>
          <div className="flex gap-1">
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value.trim())}
              placeholder="Client ID"
              spellCheck={false}
              className="min-w-0 flex-1 rounded border border-white/15 bg-black/60 px-2 py-1 font-mono text-[10px] text-white/80 placeholder:text-white/25"
            />
            <button
              onClick={() => onClientId(draft)}
              className="rounded border border-white/15 px-2 py-1 text-[10px] text-white/70 transition hover:bg-white/10"
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

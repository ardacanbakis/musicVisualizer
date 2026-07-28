/**
 * Now Playing card — album art, title, artist, progress.
 *
 * Sits in the bottom corner opposite the settings panel, so the two never
 * collide whichever side the panel is docked to.
 *
 * Two rules it inherits from the rest of the app:
 *
 * - **Dim.** This is on a wall in a dark room next to a visual that is
 *   deliberately dark. A bright card would be the brightest thing in the room
 *   and would pull the eye away from the piece it is annotating.
 * - **Never an error.** If the art will not load, the card shows the track
 *   without it. Anything worse than that and the card simply is not rendered;
 *   diagnostics live in the settings panel.
 *
 * The progress bar is driven by the interpolated playhead, so it moves
 * smoothly rather than stepping every four seconds.
 */
import { useEffect, useState } from 'react'
import type { TrackInfo } from '../signal/types'

interface NowPlayingProps {
  track: TrackInfo
  /** 0..1, or null. Read from the bus so it is the interpolated value. */
  progress: number | null
  side: 'left' | 'right'
}

export function NowPlaying({ track, progress, side }: NowPlayingProps) {
  const [artFailed, setArtFailed] = useState(false)

  // A new track gets a fresh chance at its artwork; without this the card
  // stays art-less for the rest of the session after one failed image.
  useEffect(() => {
    setArtFailed(false)
  }, [track.id])

  return (
    <div
      className={`pointer-events-auto flex w-64 items-center gap-3 rounded-xl border border-white/10 bg-black/55 p-2.5 backdrop-blur-md transition-opacity ${
        side === 'right' ? 'ml-auto' : ''
      }`}
    >
      {track.artworkUrl && !artFailed ? (
        <img
          src={track.artworkUrl}
          alt=""
          onError={() => setArtFailed(true)}
          className="h-12 w-12 shrink-0 rounded-md object-cover"
        />
      ) : (
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-white/5 text-white/20">
          <NoteIcon />
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-xs text-white/85" title={track.title}>
          {track.title || 'Unknown track'}
        </span>
        <span className="truncate text-[11px] text-white/40" title={track.artist}>
          {track.artist}
        </span>
        <div className="mt-0.5 h-0.5 w-full overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full bg-white/45"
            // No CSS transition: the value already updates ten times a second
            // from the interpolated playhead, and a transition on top of that
            // makes it lag visibly behind the music.
            style={{ width: `${Math.round((progress ?? 0) * 100)}%` }}
          />
        </div>
      </div>
    </div>
  )
}

function NoteIcon() {
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  )
}

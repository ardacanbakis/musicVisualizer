/**
 * Site footer. Hidden whenever the chrome is meant to be out of the way —
 * fullscreen, or the settings panel closed — because both of those are the
 * user asking for a bare screen.
 *
 * Kept dim on purpose. This sits on a wall in a dark room for hours, and a
 * bright row of links at the bottom would be the brightest thing in it.
 */
import {
  GithubIcon,
  GlobeIcon,
  InstagramIcon,
  LinkedinIcon,
  SpotifyIcon,
  YoutubeIcon,
} from './socialIcons'

const SOCIAL_LINKS = [
  { href: 'https://ardacanbakis.com', icon: <GlobeIcon />, label: 'Website' },
  { href: 'https://github.com/ardacanbakis', icon: <GithubIcon />, label: 'GitHub' },
  {
    href: 'https://www.instagram.com/arda.canbakiss/',
    icon: <InstagramIcon />,
    label: 'Instagram',
  },
  { href: 'https://www.youtube.com/@arda.canbakis', icon: <YoutubeIcon />, label: 'YouTube' },
  {
    href: 'https://open.spotify.com/user/11146430303',
    icon: <SpotifyIcon />,
    label: 'Spotify',
  },
  { href: 'http://linkedin.com/in/ardacanbakis', icon: <LinkedinIcon />, label: 'LinkedIn' },
]

export function Footer() {
  return (
    <div className="pointer-events-auto">
      <div className="mb-2 flex items-center justify-center gap-1">
        {SOCIAL_LINKS.map((link) => (
          <a
            key={link.label}
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            title={link.label}
            aria-label={link.label}
            className="rounded-full p-2 text-white/25 transition-colors hover:bg-white/10 hover:text-white/90"
          >
            {link.icon}
          </a>
        ))}
      </div>
      <p className="text-center text-xs text-white/25">
        Created with{' '}
        <svg className="-mt-0.5 inline h-3 w-3" viewBox="0 0 24 24" fill="#ef4444">
          <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
        </svg>{' '}
        by{' '}
        <a
          href="https://ardacanbakis.com"
          target="_blank"
          rel="noopener noreferrer"
          className="text-white/35 transition-colors hover:text-amber-400"
        >
          Arda Canbakis
        </a>{' '}
        &copy; 2026
      </p>
    </div>
  )
}

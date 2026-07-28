/**
 * Spotify OAuth, Authorization Code with PKCE.
 *
 * PKCE because this deploys as a static site to GitHub Pages: there is no
 * server, so there is nowhere to keep a client secret, and the implicit grant
 * Spotify used to offer for this case is deprecated and returns no refresh
 * token. PKCE gives a public client both an access token and a refresh token
 * with nothing secret in the bundle.
 *
 * The client id is a runtime setting rather than a build-time constant. It is
 * not a secret — it is visible in the authorize URL of every Spotify web app —
 * but it *is* per-deployment, and baking it in would mean nobody could run
 * their own copy without rebuilding.
 *
 * Everything here fails silently. An expired token, a revoked app, a user who
 * declined: all degrade to the no-Spotify state. This thing lives on a wall
 * and must never show an error.
 */

const AUTH_ENDPOINT = 'https://accounts.spotify.com/authorize'
const TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token'

/** Only what the visualiser actually reads. Asking for more would be rude. */
const SCOPES = ['user-read-currently-playing', 'user-read-playback-state']

const VERIFIER_KEY = 'amb-spotify-verifier'
const TOKEN_KEY = 'amb-spotify-token'

export interface StoredToken {
  accessToken: string
  refreshToken: string | null
  /** Epoch ms. */
  expiresAt: number
}

/**
 * The redirect URI must match what is registered in the Spotify dashboard
 * exactly, including the trailing slash. Derived from the deployed base path
 * so dev (localhost:5173/) and production (/musicVisualizer/) each work
 * without a code change — both must be registered.
 */
export function redirectUri(): string {
  const base = import.meta.env.BASE_URL || '/'
  return `${window.location.origin}${base}`
}

function base64Url(bytes: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes))
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomVerifier(): string {
  const bytes = new Uint8Array(64)
  crypto.getRandomValues(bytes)
  return base64Url(bytes.buffer).slice(0, 96)
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64Url(digest)
}

// ---------------------------------------------------------------------------
// Token storage
// ---------------------------------------------------------------------------

export function loadToken(): StoredToken | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredToken
    if (typeof parsed.accessToken !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

export function saveToken(token: StoredToken): void {
  try {
    localStorage.setItem(TOKEN_KEY, JSON.stringify(token))
  } catch {
    /* storage full or blocked; the session still works until reload */
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

/** Send the user to Spotify. Returns only if something went wrong first. */
export async function beginLogin(clientId: string): Promise<void> {
  const verifier = randomVerifier()
  const challenge = await challengeFor(verifier)
  // sessionStorage, not localStorage: the verifier is single-use and scoped to
  // this tab's login attempt.
  sessionStorage.setItem(VERIFIER_KEY, verifier)

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    code_challenge_method: 'S256',
    code_challenge: challenge,
    scope: SCOPES.join(' '),
  })
  window.location.href = `${AUTH_ENDPOINT}?${params.toString()}`
}

/**
 * Complete the flow if this page load is a redirect back from Spotify.
 *
 * Always strips the query string afterwards, success or failure, so a reload
 * does not retry a code that has already been spent (Spotify rejects reuse)
 * and so the URL on a wall display is not carrying an auth code around.
 */
export async function completeLoginFromRedirect(
  clientId: string,
): Promise<StoredToken | null> {
  const url = new URL(window.location.href)
  const code = url.searchParams.get('code')
  const error = url.searchParams.get('error')
  if (!code && !error) return null

  const verifier = sessionStorage.getItem(VERIFIER_KEY)
  sessionStorage.removeItem(VERIFIER_KEY)

  url.searchParams.delete('code')
  url.searchParams.delete('error')
  url.searchParams.delete('state')
  window.history.replaceState({}, '', url.toString())

  // The user declined, or we have no verifier to prove this request is ours.
  if (error || !code || !verifier) return null

  try {
    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri(),
        code_verifier: verifier,
      }),
    })
    if (!response.ok) return null
    const data = await response.json()
    const token: StoredToken = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? null,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    }
    saveToken(token)
    return token
  } catch {
    return null
  }
}

/**
 * Exchange the refresh token for a new access token.
 *
 * Spotify may or may not return a new refresh token; when it does not, the old
 * one stays valid and must be kept. Dropping it here would silently log the
 * user out an hour later.
 */
export async function refreshToken(
  clientId: string,
  token: StoredToken,
): Promise<StoredToken | null> {
  if (!token.refreshToken) return null
  try {
    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: token.refreshToken,
      }),
    })
    if (!response.ok) return null
    const data = await response.json()
    const next: StoredToken = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? token.refreshToken,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    }
    saveToken(next)
    return next
  } catch {
    return null
  }
}

/** True when the token is gone or close enough to expiry to be worth renewing. */
export function needsRefresh(token: StoredToken): boolean {
  // A minute of slack, so a request never goes out with a token that expires
  // while it is in flight.
  return Date.now() > token.expiresAt - 60_000
}

/**
 * Authentication Middleware
 *
 * This middleware verifies JWT tokens from cookies and attaches user information
 * to the request context for protected routes.
 */

import { Context, Next } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { generateJWT, verifyJWT, validateJWTSecret, JWTPayload } from '../utils/jwt'
import { findActiveSession, type ActiveSession } from '../utils/session-auth'

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60
const SESSION_REFRESH_THRESHOLD_SECONDS = 24 * 60 * 60

async function refreshSessionIfNeeded(
  c: Context,
  payload: JWTPayload,
  activeSession: ActiveSession,
): Promise<JWTPayload> {
  const now = Math.floor(Date.now() / 1000)
  if (payload.exp - now >= SESSION_REFRESH_THRESHOLD_SECONDS) {
    return payload
  }

  const sessionId = activeSession.id

  const refreshedToken = await generateJWT(
    {
      id: payload.user_id,
      email: payload.email,
      display_name: payload.display_name,
      avatar_url: payload.avatar_url,
      oauth_provider: payload.oauth_provider
    },
    c.env.JWT_SECRET,
    SESSION_TTL_SECONDS,
    sessionId
  )
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString()
  const update = await c.env.DB.prepare(
    `UPDATE sessions
     SET token = ?, expires_at = ?, last_activity_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ?`
  ).bind(refreshedToken, expiresAt, sessionId, payload.user_id).run()

  if (!update.meta.changes) {
    return payload
  }

  setCookie(c, 'session', refreshedToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    maxAge: SESSION_TTL_SECONDS,
    path: '/'
  })

  return {
    ...payload,
    session_id: sessionId,
    iat: now,
    exp: now + SESSION_TTL_SECONDS
  }
}

/**
 * Authentication middleware for protected routes
 * Verifies JWT token from cookie and attaches user to context
 *
 * Usage:
 *   app.use('/api/trees/*', authMiddleware)
 *   app.use('/api/nodes/*', authMiddleware)
 *
 * @param c - Hono context
 * @param next - Next middleware function
 * @returns 401 if unauthorized, otherwise proceeds to next middleware
 */
export async function authMiddleware(c: Context, next: Next) {
  // Get token from cookie
  const token = getCookie(c, 'session')

  if (!token) {
    return c.json(
      {
        success: false,
        error: 'Unauthorized: No session token found'
      },
      401
    )
  }

  // Verify token
  const jwtSecret = c.env.JWT_SECRET
  if (!validateJWTSecret(jwtSecret)) {
    console.error('JWT_SECRET environment variable is not set')
    return c.json(
      {
        success: false,
        error: 'Server configuration error'
      },
      500
    )
  }

  let payload = await verifyJWT(token, jwtSecret)

  if (!payload) {
    return c.json(
      {
        success: false,
        error: 'Unauthorized: Invalid or expired token'
      },
      401
    )
  }

  const activeSession = await findActiveSession(c.env.DB, token, payload)
  if (!activeSession) {
    return c.json(
      {
        success: false,
        error: 'Unauthorized: Session is no longer active'
      },
      401
    )
  }

  payload = await refreshSessionIfNeeded(c, payload, activeSession)

  // Attach user to context for use in route handlers
  c.set('user', payload)

  await next()
}

/**
 * Optional authentication middleware
 * Attaches user to context if token exists, but doesn't require it
 *
 * Usage:
 *   app.use('/api/public/*', optionalAuthMiddleware)
 *
 * @param c - Hono context
 * @param next - Next middleware function
 */
export async function optionalAuthMiddleware(c: Context, next: Next) {
  const token = getCookie(c, 'session')

  if (token) {
    const jwtSecret = c.env.JWT_SECRET
    if (validateJWTSecret(jwtSecret)) {
      let payload = await verifyJWT(token, jwtSecret)
      if (payload) {
        const activeSession = await findActiveSession(c.env.DB, token, payload)
        if (activeSession) {
          payload = await refreshSessionIfNeeded(c, payload, activeSession)
          c.set('user', payload)
        }
      }
    }
  }

  await next()
}

/**
 * Get current user from context
 * Throws error if user is not authenticated
 *
 * @param c - Hono context
 * @returns JWT payload with user information
 * @throws Error if user is not authenticated
 */
export function getCurrentUser(c: Context): JWTPayload {
  const user = c.get('user') as JWTPayload | undefined

  if (!user) {
    throw new Error('User not authenticated')
  }

  return user
}

/**
 * Check if user is authenticated (optional check)
 * Returns null if not authenticated instead of throwing
 *
 * @param c - Hono context
 * @returns JWT payload or null
 */
export function getOptionalUser(c: Context): JWTPayload | null {
  return c.get('user') as JWTPayload | null
}

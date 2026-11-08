/**
 * Database Helper Functions
 *
 * This file provides utility functions for database operations,
 * especially for user and authentication-related queries.
 */

import { OAuthUserInfo } from '../config/oauth'
import { createUserWithHelloTree } from './signup-tree'

export interface User {
  id: number
  oauth_provider: string
  oauth_provider_id: string
  email: string
  display_name: string | null
  avatar_url: string | null
  created_at: string
  updated_at: string
  last_login_at: string | null
}

/**
 * Find user by OAuth provider and provider ID
 * @param db - D1 Database instance
 * @param provider - OAuth provider ('google' or 'github')
 * @param providerId - OAuth provider's user ID
 * @returns User if found, null otherwise
 */
export async function findUserByOAuth(
  db: D1Database,
  provider: string,
  providerId: string
): Promise<User | null> {
  const result = await db
    .prepare('SELECT * FROM users WHERE oauth_provider = ? AND oauth_provider_id = ?')
    .bind(provider, providerId)
    .first()

  return result as User | null
}

/**
 * Find user by ID
 * @param db - D1 Database instance
 * @param userId - User ID
 * @returns User if found, null otherwise
 */
export async function findUserById(db: D1Database, userId: number): Promise<User | null> {
  const result = await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first()

  return result as User | null
}

/**
 * Find user by email
 * @param db - D1 Database instance
 * @param email - User email
 * @returns User if found, null otherwise
 */
export async function findUserByEmail(db: D1Database, email: string): Promise<User | null> {
  const result = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first()

  return result as User | null
}

/**
 * Create or update user from OAuth information
 * If user exists, updates last_login_at, display_name, and avatar_url
 * If user doesn't exist, creates new user
 *
 * @param db - D1 Database instance
 * @param oauthUser - OAuth user information
 * @returns User record (created or updated)
 */
export async function upsertOAuthUser(db: D1Database, oauthUser: OAuthUserInfo | (Omit<OAuthUserInfo, 'provider'> & { provider: 'test' })): Promise<User> {
  // Check if user exists
  const existingUser = await findUserByOAuth(db, oauthUser.provider, oauthUser.id)

  if (existingUser) {
    // Update existing user
    await db
      .prepare(
        `UPDATE users
         SET display_name = ?,
             avatar_url = ?,
             last_login_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
      .bind(oauthUser.name, oauthUser.picture || null, existingUser.id)
      .run()

    // Fetch updated user
    const updatedUser = await findUserById(db, existingUser.id)
    if (!updatedUser) {
      throw new Error('Failed to fetch updated user')
    }

    return updatedUser
  } else {
    // The account and the sample tree are committed together.
    try {
      await createUserWithHelloTree(db, oauthUser)
    } catch (error) {
      // Another simultaneous login may have completed the same signup.
      if (!String(error).includes('UNIQUE constraint failed: users.oauth_provider, users.oauth_provider_id')) throw error
    }
    const result = await findUserByOAuth(db, oauthUser.provider, oauthUser.id)
    if (!result) {
      throw new Error('Failed to create user')
    }
    return result
  }
}

/**
 * Update user profile
 * @param db - D1 Database instance
 * @param userId - User ID
 * @param updates - Fields to update
 * @returns Updated user
 */
export async function updateUserProfile(
  db: D1Database,
  userId: number,
  updates: { display_name?: string }
): Promise<User> {
  const setClauses: string[] = []
  const values: any[] = []

  if (updates.display_name !== undefined) {
    setClauses.push('display_name = ?')
    values.push(updates.display_name)
  }

  setClauses.push('updated_at = CURRENT_TIMESTAMP')

  if (setClauses.length === 0) {
    throw new Error('No fields to update')
  }

  values.push(userId)

  await db
    .prepare(`UPDATE users SET ${setClauses.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run()

  const updatedUser = await findUserById(db, userId)
  if (!updatedUser) {
    throw new Error('Failed to fetch updated user')
  }

  return updatedUser
}

/**
 * Create a session record in the database
 * @param db - D1 Database instance
 * @param userId - User ID
 * @param token - JWT token
 * @param expiresInSeconds - Session expiration time in seconds
 * @returns Session ID
 */
export async function createSession(
  db: D1Database,
  userId: number,
  token: string,
  expiresInSeconds: number,
  sessionId: string = crypto.randomUUID()
): Promise<string> {
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString()

  await db
    .prepare(
      `INSERT INTO sessions (id, user_id, token, expires_at)
       VALUES (?, ?, ?, ?)`
    )
    .bind(sessionId, userId, token, expiresAt)
    .run()

  return sessionId
}

/**
 * Delete a session record
 * @param db - D1 Database instance
 * @param token - JWT token
 */
export async function deleteSession(db: D1Database, token: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run()
}

/**
 * Clean up expired sessions (should be run periodically)
 * @param db - D1 Database instance
 * @returns Number of deleted sessions
 */
export async function cleanupExpiredSessions(db: D1Database): Promise<number> {
  const result = await db.prepare('DELETE FROM sessions WHERE expires_at < CURRENT_TIMESTAMP').run()

  return result.meta.changes
}

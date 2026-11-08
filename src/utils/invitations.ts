/**
 * Invitation Management Utilities
 *
 * This module provides functions for managing tree invitations:
 * - Generating secure invitation tokens
 * - Creating and retrieving invitations
 * - Accepting invitations
 * - Managing invitation lifecycle
 */

/**
 * Generate a secure random invitation token
 * Uses crypto.randomUUID() for cryptographically secure randomness
 */
export function generateInvitationToken(): string {
  // Generate a URL-safe random token
  // Using crypto.randomUUID() which provides a v4 UUID
  return crypto.randomUUID().replace(/-/g, '')
}

/**
 * Create a new invitation
 */
export async function createInvitation(
  db: D1Database,
  treeId: number,
  inviterUserId: number,
  inviteeEmail: string,
  role: 'editor' | 'viewer',
  expiresInDays: number = 7
): Promise<{ id: number; token: string }> {
  const token = generateInvitationToken()
  const expiresAt = new Date()
  expiresAt.setDate(expiresAt.getDate() + expiresInDays)

  const result = await db
    .prepare(
      `INSERT INTO invitations (tree_id, inviter_user_id, invitee_email, role, token, status, expires_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`
    )
    .bind(treeId, inviterUserId, inviteeEmail, role, token, expiresAt.toISOString())
    .run()

  if (!result.success) {
    throw new Error('Failed to create invitation')
  }

  return {
    id: result.meta.last_row_id as number,
    token
  }
}

/**
 * Get invitation by token
 */
export async function getInvitationByToken(
  db: D1Database,
  token: string
): Promise<{
  id: number
  tree_id: number
  tree_name: string
  inviter_user_id: number
  inviter_name: string
  invitee_email: string
  role: string
  status: string
  expires_at: string
  created_at: string
} | null> {
  const result = await db
    .prepare(
      `SELECT
        i.id,
        i.tree_id,
        t.name as tree_name,
        i.inviter_user_id,
        u.display_name as inviter_name,
        i.invitee_email,
        i.role,
        i.status,
        i.expires_at,
        i.created_at
       FROM invitations i
       JOIN trees t ON i.tree_id = t.id
       JOIN users u ON i.inviter_user_id = u.id
       WHERE i.token = ?`
    )
    .bind(token)
    .first()

  return result as any
}

/**
 * Accept an invitation
 * - Marks invitation as accepted
 * - Adds user to tree_members
 * - Returns the tree_id
 */
export async function acceptInvitation(
  db: D1Database,
  token: string,
  userId: number
): Promise<{ treeId: number; role: string }> {
  const invitation = await getInvitationByToken(db, token)

  if (!invitation) {
    throw new Error('Invitation not found')
  }

  if (invitation.status !== 'pending') {
    throw new Error('Invitation has already been used or cancelled')
  }

  // Check if invitation has expired
  const now = new Date()
  const expiresAt = new Date(invitation.expires_at)
  if (now > expiresAt) {
    throw new Error('Invitation has expired')
  }

  // Check if user is already a member
  const existingMember = await db
    .prepare(`SELECT id FROM tree_members WHERE tree_id = ? AND user_id = ?`)
    .bind(invitation.tree_id, userId)
    .first()

  if (existingMember) {
    throw new Error('You are already a member of this tree')
  }

  // Add user to tree_members
  await db
    .prepare(
      `INSERT INTO tree_members (tree_id, user_id, role, added_by_user_id)
       VALUES (?, ?, ?, ?)`
    )
    .bind(invitation.tree_id, userId, invitation.role, invitation.inviter_user_id)
    .run()

  // Mark invitation as accepted
  await db
    .prepare(
      `UPDATE invitations
       SET status = 'accepted', accepted_at = CURRENT_TIMESTAMP
       WHERE token = ?`
    )
    .bind(token)
    .run()

  return {
    treeId: invitation.tree_id,
    role: invitation.role
  }
}

/**
 * Get all pending invitations for a tree
 */
export async function getTreeInvitations(
  db: D1Database,
  treeId: number
): Promise<Array<{
  id: number
  invitee_email: string
  role: string
  status: string
  expires_at: string
  created_at: string
}>> {
  const result = await db
    .prepare(
      `SELECT id, invitee_email, role, status, expires_at, created_at
       FROM invitations
       WHERE tree_id = ?
       ORDER BY created_at DESC`
    )
    .bind(treeId)
    .all()

  return result.results as any[]
}

/**
 * Cancel an invitation using an existing terminal state
 */
export async function cancelInvitation(
  db: D1Database,
  invitationId: number
): Promise<void> {
  await db
    .prepare(`UPDATE invitations SET status = 'declined' WHERE id = ?`)
    .bind(invitationId)
    .run()
}

/**
 * Delete expired invitations (cleanup job)
 */
export async function deleteExpiredInvitations(db: D1Database): Promise<number> {
  const result = await db
    .prepare(
      `DELETE FROM invitations
       WHERE status = 'pending' AND expires_at < CURRENT_TIMESTAMP`
    )
    .run()

  return result.meta.changes
}

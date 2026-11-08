/**
 * Permission Helper Functions
 *
 * This file provides utility functions for checking user permissions on trees.
 * Permissions are based on the tree_members table with three roles:
 * - owner: Full access, can manage members and delete tree
 * - editor: Can edit tree and nodes, can invite other members
 * - viewer: Read-only access
 */

export type Role = 'owner' | 'editor' | 'viewer'

export interface TreeMember {
  id: number
  tree_id: number
  user_id: number
  role: Role
  added_by_user_id: number | null
  created_at: string
}

/**
 * Get user's role in a tree
 * @param db - D1 Database instance
 * @param treeId - Tree ID
 * @param userId - User ID
 * @returns User's role or null if not a member
 */
export async function getUserRole(
  db: D1Database,
  treeId: number,
  userId: number
): Promise<Role | null> {
  const member = await db
    .prepare('SELECT role FROM tree_members WHERE tree_id = ? AND user_id = ?')
    .bind(treeId, userId)
    .first<{ role: Role }>()

  return member ? member.role : null
}

/**
 * Check if user has access to a tree (any role)
 * @param db - D1 Database instance
 * @param treeId - Tree ID
 * @param userId - User ID
 * @returns true if user has any access to the tree
 */
export async function hasTreeAccess(
  db: D1Database,
  treeId: number,
  userId: number
): Promise<boolean> {
  const role = await getUserRole(db, treeId, userId)
  return role !== null
}

/**
 * Check if user can view a tree
 * @param db - D1 Database instance
 * @param treeId - Tree ID
 * @param userId - User ID
 * @returns true if user can view (owner, editor, or viewer)
 */
export async function canViewTree(
  db: D1Database,
  treeId: number,
  userId: number
): Promise<boolean> {
  return await hasTreeAccess(db, treeId, userId)
}

/**
 * Check if user can edit a tree and its nodes
 * @param db - D1 Database instance
 * @param treeId - Tree ID
 * @param userId - User ID
 * @returns true if user can edit (owner or editor)
 */
export async function canEditTree(
  db: D1Database,
  treeId: number,
  userId: number
): Promise<boolean> {
  const role = await getUserRole(db, treeId, userId)
  return role === 'owner' || role === 'editor'
}

/**
 * Check if user is the owner of a tree
 * @param db - D1 Database instance
 * @param treeId - Tree ID
 * @param userId - User ID
 * @returns true if user is the owner
 */
export async function isTreeOwner(
  db: D1Database,
  treeId: number,
  userId: number
): Promise<boolean> {
  const role = await getUserRole(db, treeId, userId)
  return role === 'owner'
}

/**
 * Check if user can manage members (invite, remove, change roles)
 * Only owners can manage members
 * @param db - D1 Database instance
 * @param treeId - Tree ID
 * @param userId - User ID
 * @returns true if user can manage members
 */
export async function canManageMembers(
  db: D1Database,
  treeId: number,
  userId: number
): Promise<boolean> {
  const role = await getUserRole(db, treeId, userId)
  return role === 'owner'
}

/**
 * Check if user can delete a tree
 * @param db - D1 Database instance
 * @param treeId - Tree ID
 * @param userId - User ID
 * @returns true if user is the owner (only owners can delete)
 */
export async function canDeleteTree(
  db: D1Database,
  treeId: number,
  userId: number
): Promise<boolean> {
  return await isTreeOwner(db, treeId, userId)
}

/**
 * Check if user can change tree metadata (name, description)
 * @param db - D1 Database instance
 * @param treeId - Tree ID
 * @param userId - User ID
 * @returns true if user can update tree metadata (owner only)
 */
export async function canUpdateTreeMetadata(
  db: D1Database,
  treeId: number,
  userId: number
): Promise<boolean> {
  return await isTreeOwner(db, treeId, userId)
}

/**
 * Get all tree members with their details
 * @param db - D1 Database instance
 * @param treeId - Tree ID
 * @returns Array of tree members with user information
 */
export async function getTreeMembers(db: D1Database, treeId: number) {
  const members = await db
    .prepare(
      `SELECT
        tm.id,
        tm.tree_id,
        tm.user_id,
        tm.role,
        tm.added_by_user_id,
        tm.created_at,
        u.email,
        u.display_name,
        u.avatar_url
      FROM tree_members tm
      JOIN users u ON tm.user_id = u.id
      WHERE tm.tree_id = ?
      ORDER BY
        CASE tm.role
          WHEN 'owner' THEN 1
          WHEN 'editor' THEN 2
          WHEN 'viewer' THEN 3
        END,
        tm.created_at ASC`
    )
    .bind(treeId)
    .all()

  return members.results
}

/**
 * Add a member to a tree
 * @param db - D1 Database instance
 * @param treeId - Tree ID
 * @param userId - User ID to add
 * @param role - Role to assign
 * @param addedByUserId - User ID of the person adding the member
 */
export async function addTreeMember(
  db: D1Database,
  treeId: number,
  userId: number,
  role: Role,
  addedByUserId: number
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tree_members (tree_id, user_id, role, added_by_user_id)
       VALUES (?, ?, ?, ?)`
    )
    .bind(treeId, userId, role, addedByUserId)
    .run()
}

/**
 * Remove a member from a tree
 * @param db - D1 Database instance
 * @param treeId - Tree ID
 * @param userId - User ID to remove
 */
export async function removeTreeMember(
  db: D1Database,
  treeId: number,
  userId: number
): Promise<void> {
  await db
    .prepare('DELETE FROM tree_members WHERE tree_id = ? AND user_id = ?')
    .bind(treeId, userId)
    .run()
}

/**
 * Update a member's role in a tree
 * @param db - D1 Database instance
 * @param treeId - Tree ID
 * @param userId - User ID whose role to update
 * @param newRole - New role to assign
 */
export async function updateMemberRole(
  db: D1Database,
  treeId: number,
  userId: number,
  newRole: Role
): Promise<void> {
  await db
    .prepare('UPDATE tree_members SET role = ? WHERE tree_id = ? AND user_id = ?')
    .bind(newRole, treeId, userId)
    .run()
}

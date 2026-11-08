/**
 * Tree Management Helper Functions
 *
 * This file provides utility functions for tree CRUD operations.
 */

import { withPublicIdRetry } from './public-id'
import { MAX_TREES_PER_USER, QuotaExceededError } from './request-safety'

export interface Tree {
  id: number
  name: string
  description: string | null
  icon: string | null
  color: string | null
  owner_user_id: number
  root_node_id: number
  trash_root_node_id: number | null
  created_at: string
  updated_at: string
  node_count?: number
}

export interface TreeWithRole extends Tree {
  role: 'owner' | 'editor' | 'viewer'
  owner_email?: string
  owner_display_name?: string
  member_count?: number
  node_count?: number
}

/**
 * Get all trees accessible by a user (owned + shared)
 * @param db - D1 Database instance
 * @param userId - User ID
 * @returns Array of trees with user's role
 */
export async function getUserTrees(db: D1Database, userId: number): Promise<TreeWithRole[]> {
  const trees = await db
    .prepare(
      `SELECT
        t.id,
        t.name,
        t.description,
        t.icon,
        t.color,
        t.owner_user_id,
        t.root_node_id,
        t.trash_root_node_id,
        t.created_at,
        t.updated_at,
        tm.role,
        u.email as owner_email,
        u.display_name as owner_display_name,
        (SELECT COUNT(*) FROM tree_members WHERE tree_id = t.id) as member_count,
        MAX(0, t.node_count - 2) as node_count
      FROM trees t
      JOIN tree_members tm ON t.id = tm.tree_id
      LEFT JOIN users u ON t.owner_user_id = u.id
      WHERE tm.user_id = ? AND (t.is_deleted = 0 OR t.is_deleted IS NULL)
      ORDER BY t.updated_at DESC`
    )
    .bind(userId)
    .all()

  return trees.results as TreeWithRole[]
}

/**
 * Get a single tree by ID
 * @param db - D1 Database instance
 * @param treeId - Tree ID
 * @returns Tree or null if not found
 */
export async function getTreeById(db: D1Database, treeId: number): Promise<Tree | null> {
  const tree = await db.prepare('SELECT * FROM trees WHERE id = ? AND (is_deleted = 0 OR is_deleted IS NULL)').bind(treeId).first()

  return tree as Tree | null
}

/**
 * Create a new tree
 * @param db - D1 Database instance
 * @param name - Tree name
 * @param description - Tree description
 * @param ownerUserId - Owner user ID
 * @returns Created tree
 */
export async function createTree(
  db: D1Database,
  name: string,
  description: string | null,
  ownerUserId: number
): Promise<Tree> {
  const ownedTreeCount = await db.prepare(
    'SELECT COUNT(*) AS count FROM trees WHERE owner_user_id = ? AND (is_deleted = 0 OR is_deleted IS NULL)'
  ).bind(ownerUserId).first<{ count: number }>()
  if (Number(ownedTreeCount?.count || 0) >= MAX_TREES_PER_USER) {
    throw new QuotaExceededError('Tree quota exceeded')
  }
  // RT1: Create tree
  const tree = await db
    .prepare(
      `INSERT INTO trees (name, description, owner_user_id, node_count)
       VALUES (?, ?, ?, 3)
       RETURNING *`
    )
    .bind(name, description, ownerUserId)
    .first<Tree>()

  if (!tree) {
    throw new Error('Failed to create tree')
  }

  // RT2: Add owner as member
  await db.batch([
    db.prepare(
      `INSERT INTO tree_members (tree_id, user_id, role, added_by_user_id)
       VALUES (?, ?, 'owner', ?)`
    ).bind(tree.id, ownerUserId, ownerUserId),
  ])

  // RT2: Create root/trash nodes with public_id
  const rootNode = await withPublicIdRetry((publicId) =>
    db.prepare(
      `INSERT INTO nodes (tree_id, title, content, version, public_id)
       VALUES (?, 'root', '', 1, ?)
       RETURNING *`
    ).bind(tree.id, publicId).first<{ id: number }>()
  )
  const trashRootNode = await withPublicIdRetry((publicId) =>
    db.prepare(
      `INSERT INTO nodes (tree_id, title, content, version, public_id)
       VALUES (?, '(trash)', '', 1, ?)
       RETURNING *`
    ).bind(tree.id, publicId).first<{ id: number }>()
  )
  if (!rootNode) {
    throw new Error('Failed to create root node')
  }
  if (!trashRootNode) {
    throw new Error('Failed to create trash root node')
  }

  // RT3: Create "(new)" child node with public_id + update tree root/trash root IDs
  const newNode = await withPublicIdRetry((publicId) =>
    db.prepare(
      `INSERT INTO nodes (tree_id, title, content, author_user_id, created_by_user_id, updated_by_user_id, version, public_id)
       VALUES (?, '(new)', '', ?, ?, ?, 1, ?)
       RETURNING *`
    ).bind(tree.id, ownerUserId, ownerUserId, ownerUserId, publicId).first<{ id: number }>()
  )
  if (!newNode) {
    throw new Error('Failed to create initial child node')
  }

  await db.prepare(
    `UPDATE trees SET root_node_id = ?, trash_root_node_id = ? WHERE id = ?`
  ).bind(rootNode.id, trashRootNode.id, tree.id).run()


  // RT4: Create relation (root → "(new)")
  await db.prepare(
    `INSERT INTO node_relations (parent_node_id, child_node_id, position)
     VALUES (?, ?, 0)`
  ).bind(rootNode.id, newNode.id).run()

  return { ...tree, root_node_id: rootNode.id, trash_root_node_id: trashRootNode.id }
}

/**
 * Update tree metadata (name, description)
 * @param db - D1 Database instance
 * @param treeId - Tree ID
 * @param updates - Fields to update
 * @returns Updated tree
 */
export async function updateTree(
  db: D1Database,
  treeId: number,
  updates: { name?: string; description?: string | null; icon?: string | null; color?: string | null }
): Promise<Tree> {
  const setClauses: string[] = []
  const values: any[] = []

  if (updates.name !== undefined) {
    setClauses.push('name = ?')
    values.push(updates.name)
  }

  if (updates.description !== undefined) {
    setClauses.push('description = ?')
    values.push(updates.description)
  }

  if (updates.icon !== undefined) {
    setClauses.push('icon = ?')
    values.push(updates.icon)
  }

  if (updates.color !== undefined) {
    setClauses.push('color = ?')
    values.push(updates.color)
  }

  setClauses.push('updated_at = CURRENT_TIMESTAMP')

  if (setClauses.length === 1) {
    // Only updated_at, nothing to update
    const tree = await getTreeById(db, treeId)
    if (!tree) {
      throw new Error('Tree not found')
    }
    return tree
  }

  values.push(treeId)

  await db
    .prepare(`UPDATE trees SET ${setClauses.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run()

  const updatedTree = await getTreeById(db, treeId)
  if (!updatedTree) {
    throw new Error('Failed to fetch updated tree')
  }

  return updatedTree
}

/**
 * Soft delete a tree (set is_deleted flag)
 * @param db - D1 Database instance
 * @param treeId - Tree ID
 */
export async function deleteTree(db: D1Database, treeId: number): Promise<void> {
  // Soft delete: set is_deleted flag instead of actually deleting
  await db.prepare('UPDATE trees SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(treeId).run()
}

/**
 * Get tree statistics
 * @param db - D1 Database instance
 * @param treeId - Tree ID
 * @returns Tree statistics
 */
export async function getTreeStats(
  db: D1Database,
  treeId: number
): Promise<{
  node_count: number
  member_count: number
}> {
  const nodeCount = await db
    .prepare('SELECT COUNT(*) as count FROM nodes WHERE tree_id = ?')
    .bind(treeId)
    .first<{ count: number }>()

  const memberCount = await db
    .prepare('SELECT COUNT(*) as count FROM tree_members WHERE tree_id = ?')
    .bind(treeId)
    .first<{ count: number }>()

  return {
    node_count: nodeCount?.count || 0,
    member_count: memberCount?.count || 0
  }
}

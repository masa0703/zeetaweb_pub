import { generatePublicNodeId } from './public-id'
import template from '../data/hello-template.json'
import type { OAuthUserInfo } from '../config/oauth'

type TemplateNode = { id: string; title: string; content: string; sortMode: string; sortDirection: string }
type TemplateEdge = { parent: string; child: string; relation: string; position: number }

/** Create the account and its complete sample tree in one D1 transaction. */
export async function createUserWithHelloTree(db: D1Database, user: OAuthUserInfo | (Omit<OAuthUserInfo, 'provider'> & { provider: 'test' })): Promise<void> {
  const nodes = template.nodes as TemplateNode[]
  const edges = template.edges as TemplateEdge[]
  for (let attempt = 0; attempt < 5; attempt++) {
    const ids = new Map<string, string>()
    for (const node of nodes) ids.set(node.id, generatePublicNodeId())
    ids.set('$root', generatePublicNodeId())
    ids.set('$trash', generatePublicNodeId())
    const userId = '(SELECT id FROM users WHERE oauth_provider = ? AND oauth_provider_id = ?)'
    const treeId = `(SELECT id FROM trees WHERE owner_user_id = ${userId} AND name = 'Hello')`
    const identity = [user.provider, user.id]
    const allNodes = [
      { id: '$root', title: 'root', content: '', sortMode: 'manual', sortDirection: 'asc' },
      { id: '$trash', title: '(trash)', content: '', sortMode: 'manual', sortDirection: 'asc' },
      ...nodes,
    ]
    const statements = [
      db.prepare('INSERT INTO users (oauth_provider, oauth_provider_id, email, display_name, avatar_url, last_login_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)')
        .bind(user.provider, user.id, user.email, user.name, user.picture || null),
      db.prepare(`INSERT INTO trees (name, owner_user_id) VALUES ('Hello', ${userId})`).bind(...identity),
      db.prepare(`INSERT INTO tree_members (tree_id, user_id, role, added_by_user_id) VALUES (${treeId}, ${userId}, 'owner', ${userId})`).bind(...identity, ...identity, ...identity),
    ]
    for (const node of allNodes) {
      const content = node.content.replace(/\(id:([1-9A-HJ-NP-Za-km-z]{6})\)/g, (match, id) => ids.has(id) ? `(id:${ids.get(id)})` : match)
      statements.push(db.prepare(`INSERT INTO nodes (tree_id, title, content, author_user_id, created_by_user_id, updated_by_user_id, public_id, child_sort_mode, child_sort_direction)
        VALUES (${treeId}, ?, ?, ${userId}, ${userId}, ${userId}, ?, ?, ?)`)
        .bind(...identity, node.title, content, ...identity, ...identity, ...identity, ids.get(node.id), node.sortMode, node.sortDirection))
    }
    statements.push(db.prepare(`UPDATE trees SET root_node_id = (SELECT id FROM nodes WHERE public_id = ?), trash_root_node_id = (SELECT id FROM nodes WHERE public_id = ?) WHERE id = ${treeId}`)
      .bind(ids.get('$root'), ids.get('$trash'), ...identity))
    for (const edge of edges) {
      statements.push(db.prepare(`INSERT INTO node_relations (parent_node_id, child_node_id, relation_type_id, position)
        VALUES ((SELECT id FROM nodes WHERE public_id = ?), (SELECT id FROM nodes WHERE public_id = ?), ?, ?)`)
        .bind(ids.get(edge.parent), ids.get(edge.child), edge.relation === 'REFERENCE' ? 3 : 1, edge.position))
    }
    try {
      await db.batch(statements)
      try {
        await db.prepare(`UPDATE trees SET node_count = ? WHERE id = ${treeId}`).bind(allNodes.length, ...identity).run()
      } catch (updateError) {
        // Unit-test databases may use the pre-quota schema; the migration adds this column in deployed databases.
        if (!String(updateError).includes('node_count')) throw updateError
      }
      return
    } catch (error) {
      // D1 batch is atomic. Retry only public ID collisions; all other errors surface.
      if (!String(error).includes('UNIQUE constraint failed: nodes.public_id') || attempt === 4) throw error
    }
  }
}

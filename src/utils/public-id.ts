/**
 * Public ID utilities for nodes.
 *
 * Exposes an opaque, random base58 public identifier for nodes while keeping
 * the internal integer primary key unchanged.
 */

const PUBLIC_ID_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const PUBLIC_ID_LENGTH = 6

/**
 * Generate a random base58 public node ID.
 * Uses rejection sampling to eliminate modulo bias.
 */
export function generatePublicNodeId(): string {
  const alphabetSize = PUBLIC_ID_ALPHABET.length
  let result = ''
  while (result.length < PUBLIC_ID_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(PUBLIC_ID_LENGTH - result.length))
    for (const byte of bytes) {
      // Reject bytes that would introduce modulo bias.
      if (byte >= 256 - (256 % alphabetSize)) {
        continue
      }
      result += PUBLIC_ID_ALPHABET[byte % alphabetSize]
      if (result.length === PUBLIC_ID_LENGTH) {
        break
      }
    }
  }
  return result
}

/**
 * Validate that a value is a valid public node ID.
 */
export function isValidPublicNodeId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{6}$/.test(value)
}

/**
 * Detect a D1/SQLite UNIQUE constraint violation.
 */
function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('UNIQUE constraint failed')
}

/**
 * Execute an insert function with a fresh public_id, retrying on collisions.
 * Does not pre-check for collisions; relies on the database UNIQUE index.
 */
export async function withPublicIdRetry<T>(
  insertFn: (publicId: string) => Promise<T>,
  maxTries = 5
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < maxTries; attempt++) {
    const publicId = generatePublicNodeId()
    try {
      return await insertFn(publicId)
    } catch (error) {
      lastError = error
      if (!isUniqueConstraintError(error)) {
        throw error
      }
    }
  }
  throw new Error(`Failed to generate unique public_id after ${maxTries} attempts: ${lastError}`)
}

/**
 * Resolve a public node ID to an internal node ID within a specific tree.
 */
export async function resolvePublicNodeId(
  db: D1Database,
  treeId: number,
  publicId: string
): Promise<number | null> {
  const row = await db
    .prepare('SELECT id FROM nodes WHERE public_id = ? AND tree_id = ?')
    .bind(publicId, treeId)
    .first<{ id: number }>()
  return row ? row.id : null
}

// D1 は1クエリあたりのバインド変数が最大100個。IN 句をこの単位で分割する
// （他のバインド変数と合算されるため余裕を持たせる）。
export const D1_IN_CLAUSE_BATCH = 90

/**
 * Resolve multiple public node IDs to internal node IDs within a specific tree.
 * IN 句は D1 のバインド変数上限を超えないよう内部でバッチ分割する。
 */
export async function resolvePublicNodeIds(
  db: D1Database,
  treeId: number,
  publicIds: string[]
): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  for (let i = 0; i < publicIds.length; i += D1_IN_CLAUSE_BATCH) {
    const slice = publicIds.slice(i, i + D1_IN_CLAUSE_BATCH)
    const placeholders = slice.map(() => '?').join(', ')
    const rows = await db
      .prepare(`SELECT id, public_id FROM nodes WHERE tree_id = ? AND public_id IN (${placeholders})`)
      .bind(treeId, ...slice)
      .all<{ id: number; public_id: string }>()
    for (const row of rows.results ?? []) {
      map.set(row.public_id, row.id)
    }
  }
  return map
}

/**
 * Encode internal node IDs to public IDs in bulk.
 * IN 句は D1 のバインド変数上限を超えないよう内部でバッチ分割する。
 */
export async function encodeNodeIds(
  db: D1Database,
  ids: number[]
): Promise<Map<number, string>> {
  const map = new Map<number, string>()
  for (let i = 0; i < ids.length; i += D1_IN_CLAUSE_BATCH) {
    const slice = ids.slice(i, i + D1_IN_CLAUSE_BATCH)
    const placeholders = slice.map(() => '?').join(', ')
    const rows = await db
      .prepare(`SELECT id, public_id FROM nodes WHERE id IN (${placeholders})`)
      .bind(...slice)
      .all<{ id: number; public_id: string }>()
    for (const row of rows.results ?? []) {
      map.set(row.id, row.public_id)
    }
  }
  return map
}

/**
 * Resolve a public node ID without tree scoping.
 * Callers must verify accessibility separately (e.g. via accessibleSet.has(id)).
 */
export async function resolvePublicNodeIdForScope(
  db: D1Database,
  publicId: string
): Promise<number | null> {
  const row = await db
    .prepare('SELECT id FROM nodes WHERE public_id = ?')
    .bind(publicId)
    .first<{ id: number }>()
  return row ? row.id : null
}

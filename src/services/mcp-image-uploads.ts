/**
 * MCP create_node_image_upload の合鍵（1回限りの画像アップロード用トークン）
 *
 * AI が画像の base64 を書き写さずに済むよう、MCP ツールで合鍵を発行し、
 * 画像のバイトは curl で PUT /api/mcp/uploads へ直接送らせる。
 *
 * - 合鍵は SHA-256 hex で保存し、平文は保存しない
 * - 有効期限は発行から UPLOAD_TOKEN_TTL_SECONDS
 * - 受付時に「確認」と「使用済みへの更新」を1つの UPDATE で行い、同時に2回送られても1回しか通さない
 * - 受付で検査に失敗しても合鍵は使用済みになる（やり直しは発行し直し）
 */

import { sha256Hex, toSqlDatetime } from '../oauth/mcp-oauth'

export const UPLOAD_TOKEN_TTL_SECONDS = 10 * 60
export const UPLOAD_TOKEN_PREFIX = 'zmu_'
export const MCP_IMAGE_UPLOAD_PATH = '/api/mcp/uploads'

/** 期限切れ行を残す期間。発行のたびに、これより古い期限切れ行を掃除する */
const PURGE_KEEP_INTERVAL = '-1 day'

export interface IssueImageUploadInput {
  userId: number
  treeId: number
  nodeId: number
  nodePublicId: string
  filename: string
  contentType: string
  sizeBytes: number
}

export interface ImageUploadRow {
  id: number
  user_id: number
  tree_id: number
  node_id: number
  node_public_id: string
  filename: string
  content_type: string
  size_bytes: number
}

function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function generateUploadToken(): string {
  const random = new Uint8Array(32)
  crypto.getRandomValues(random)
  return `${UPLOAD_TOKEN_PREFIX}${base64UrlFromBytes(random)}`
}

/** 期限切れの合鍵を掃除する（best-effort・失敗しても発行は継続する） */
async function purgeExpiredImageUploads(db: D1Database): Promise<void> {
  try {
    await db.prepare(`DELETE FROM mcp_image_uploads WHERE expires_at < datetime('now', ?)`)
      .bind(PURGE_KEEP_INTERVAL)
      .run()
  } catch {
    // best-effort
  }
}

export async function issueImageUpload(
  db: D1Database,
  input: IssueImageUploadInput,
  now: Date = new Date(),
): Promise<{ token: string; expiresAt: string }> {
  await purgeExpiredImageUploads(db)

  const token = generateUploadToken()
  const expiresAt = toSqlDatetime(new Date(now.getTime() + UPLOAD_TOKEN_TTL_SECONDS * 1000))
  await db.prepare(
    `INSERT INTO mcp_image_uploads
       (token_hash, user_id, tree_id, node_id, node_public_id, filename, content_type, size_bytes, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      await sha256Hex(token),
      input.userId,
      input.treeId,
      input.nodeId,
      input.nodePublicId,
      input.filename,
      input.contentType,
      input.sizeBytes,
      expiresAt,
    )
    .run()

  return { token, expiresAt }
}

/**
 * 合鍵を使用済みにして、その行を返す。存在しない・期限切れ・使用済みなら null。
 * 確認と更新を1つの UPDATE で行うので、同じ合鍵で同時に送られても1回しか返らない。
 */
export async function consumeImageUpload(
  db: D1Database,
  token: string,
  now: Date = new Date(),
): Promise<ImageUploadRow | null> {
  if (!token.startsWith(UPLOAD_TOKEN_PREFIX)) return null
  const nowSql = toSqlDatetime(now)
  const row = await db.prepare(
    `UPDATE mcp_image_uploads
        SET used_at = ?
      WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
      RETURNING id, user_id, tree_id, node_id, node_public_id, filename, content_type, size_bytes`
  )
    .bind(nowSql, await sha256Hex(token), nowSql)
    .first<ImageUploadRow>()
  return row ?? null
}

export function buildCurlCommand(uploadUrl: string, token: string, contentType: string): string {
  return `curl -sS -X PUT --data-binary @<FILE_PATH> -H 'Content-Type: ${contentType}' -H 'Authorization: Bearer ${token}' '${uploadUrl}'`
}

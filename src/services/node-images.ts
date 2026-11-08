/**
 * ノード画像の保存（REST アップロードと MCP create_node_image の共通実装）
 *
 * 入力検証の結果はエラー文言を持たない理由コードで返し、
 * 呼び出し側（REST: 400 応答 / MCP: tool error）が各自の文言へ写像する。
 */

import {
  MAX_NODE_IMAGE_SIZE_BYTES,
  NODE_IMAGE_ALLOWED_MIMES,
  buildStoredImageFileName,
  normalizeImageBaseName,
  resolveImageExt,
  splitFileNameAndExt,
  validateImageMagicBytes,
} from '../utils/node-images'

export type NodeImageRejection = 'empty' | 'too_large' | 'unsupported_mime' | 'unknown_ext' | 'invalid_content'

export type NodeImageValidation =
  | { ok: true; mimeType: string; fileExt: string }
  | { ok: false; reason: NodeImageRejection }

export interface StoreNodeImageInput {
  treeId: number
  nodeId: number
  fileNameRaw: string
  mimeType: string
  fileExt: string
  bytes: Uint8Array
  actorUserId: number
}

export interface StoredNodeImage {
  id: number
  node_id: number
  serial_no: number
  file_name: string
  file_ext: string
  mime_type: string
  file_size: number
  created_at: string
}

export function validateNodeImage(byteLength: number, mimeTypeRaw: string, fileNameRaw: string, bytes?: Uint8Array): NodeImageValidation {
  if (byteLength <= 0) return { ok: false, reason: 'empty' }
  if (byteLength > MAX_NODE_IMAGE_SIZE_BYTES) return { ok: false, reason: 'too_large' }

  const mimeType = String(mimeTypeRaw || '').toLowerCase()
  if (!NODE_IMAGE_ALLOWED_MIMES.has(mimeType)) return { ok: false, reason: 'unsupported_mime' }
  if (!bytes || !validateImageMagicBytes(bytes, mimeType)) return { ok: false, reason: 'invalid_content' }

  const fileExt = resolveImageExt(fileNameRaw, mimeType)
  if (!fileExt) return { ok: false, reason: 'unknown_ext' }

  return { ok: true, mimeType, fileExt }
}

async function resolveUniqueFileName(
  db: D1Database,
  treeId: number,
  nodeId: number,
  baseName: string,
  ext: string,
): Promise<string> {
  let fileName = `${baseName}.${ext}`
  let nameSerial = 1
  while (true) {
    const existsRow = await db.prepare(
      'SELECT id FROM node_images WHERE tree_id = ? AND node_id = ? AND file_name = ? LIMIT 1'
    )
      .bind(treeId, nodeId, fileName)
      .first<{ id: number }>()
    if (!existsRow) return fileName
    nameSerial += 1
    fileName = buildStoredImageFileName(baseName, ext, nameSerial)
  }
}

/**
 * 検証済みの画像を R2 に置き、node_images 行を作る。
 * INSERT が行を返さなかった場合は R2 を掃除して null、DB 例外は R2 を掃除して再送出する。
 */
export async function storeNodeImage(
  db: D1Database,
  imageBucket: R2Bucket,
  input: StoreNodeImageInput,
): Promise<StoredNodeImage | null> {
  const { treeId, nodeId, fileNameRaw, mimeType, fileExt, bytes, actorUserId } = input

  const serialRow = await db.prepare(
    'SELECT COALESCE(MAX(serial_no), 0) AS max_serial FROM node_images WHERE node_id = ?'
  )
    .bind(nodeId)
    .first<{ max_serial: number }>()
  const serialNo = Number(serialRow?.max_serial || 0) + 1

  const { baseName: uploadedBaseNameRaw } = splitFileNameAndExt(String(fileNameRaw || '').trim())
  const baseName = normalizeImageBaseName(uploadedBaseNameRaw)
  const ext = fileExt

  const fileName = await resolveUniqueFileName(db, treeId, nodeId, baseName, ext)
  const r2Key = `tree_${treeId}/node_${nodeId}/${fileName}`

  await imageBucket.put(r2Key, bytes, {
    httpMetadata: { contentType: mimeType },
  })

  try {
    const inserted = await db.prepare(
      `INSERT INTO node_images (
         tree_id, node_id, serial_no, file_name, file_ext, mime_type, file_size, r2_key, created_by_user_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id, node_id, serial_no, file_name, file_ext, mime_type, file_size, created_at`
    )
      .bind(treeId, nodeId, serialNo, fileName, ext, mimeType, bytes.byteLength, r2Key, actorUserId)
      .first<StoredNodeImage>()

    if (!inserted) {
      await imageBucket.delete(r2Key)
      return null
    }
    return inserted
  } catch (error) {
    await imageBucket.delete(r2Key)
    throw error
  }
}

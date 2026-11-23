import type { McpToolContext } from '../tool-context'
import { arrayBufferToBase64, base64ToUint8Array, createMcpNodeImage } from '../support'
import { isValidPublicNodeId, resolvePublicNodeId } from '../../utils/public-id'
import { MAX_NODE_IMAGE_SIZE_BYTES, NODE_IMAGE_ALLOWED_MIMES } from '../../utils/node-images'
import { MCP_IMAGE_UPLOAD_PATH, buildCurlCommand, issueImageUpload } from '../../services/mcp-image-uploads'

const UPLOAD_FILENAME_MAX_LENGTH = 255

export async function readNodeImage(ctx: McpToolContext) {
  const { id, args, db, env, principal, treeRow, accessibleSet, queueAuditLog, makeRpcResponse, toImageResult, toolError } = ctx
  if (!env?.NODE_IMAGES) {
    return makeRpcResponse({ id, result: toolError('Image storage is not configured') })
  }
  const nodeIdRaw = args.node_id
  const imageId = parseInt(String(args.image_id), 10)
  if (!isValidPublicNodeId(nodeIdRaw)) {
    return makeRpcResponse({ id, result: toolError('node_id is required') })
  }
  if (!Number.isFinite(imageId) || imageId <= 0) {
    return makeRpcResponse({ id, result: toolError('image_id is required') })
  }

  const nodeId = await resolvePublicNodeId(db, treeRow.tree_id, String(nodeIdRaw))
  if (!nodeId) {
    return makeRpcResponse({ id, result: toolError('Node not found') })
  }
  if (!accessibleSet.has(nodeId)) {
    return makeRpcResponse({ id, result: toolError('Access denied to node') })
  }

  const imageRow = await db.prepare(
    `SELECT r2_key, file_name, mime_type
     FROM node_images
     WHERE id = ? AND tree_id = ? AND node_id = ?`
  ).bind(imageId, treeRow.tree_id, nodeId).first<{
    r2_key: string
    file_name: string
    mime_type: string
  }>()
  if (!imageRow) {
    return makeRpcResponse({ id, result: toolError('Image not found') })
  }

  const object = await env.NODE_IMAGES.get(imageRow.r2_key)
  if (!object) {
    return makeRpcResponse({ id, result: toolError('Image file not found in storage') })
  }

  queueAuditLog({ userId: principal.user_id, action: 'mcp.read.node_image', targetType: 'node', targetId: nodeId, treeId: treeRow.tree_id, source: 'mcp' })
  const imageBuffer = await object.arrayBuffer()
  return makeRpcResponse({
    id,
    result: toImageResult(
      { data: arrayBufferToBase64(imageBuffer), mimeType: imageRow.mime_type },
      {
        filename: imageRow.file_name,
        content_type: imageRow.mime_type,
        size_bytes: imageBuffer.byteLength,
      },
    ),
  })
}

export async function createNodeImage(ctx: McpToolContext) {
  const { id, args, db, env, principal, treeRow, accessibleSet, queueAuditLog, makeRpcResponse, toToolResult, toolError } = ctx
  if (!env?.NODE_IMAGES) {
    return makeRpcResponse({ id, result: toolError('Image storage is not configured') })
  }
  const nodeIdRaw = args.node_id
  const filename = args.filename === undefined ? '' : String(args.filename)
  const contentType = args.content_type === undefined ? '' : String(args.content_type)
  const dataBase64 = args.data_base64 === undefined ? '' : String(args.data_base64)
  if (!isValidPublicNodeId(nodeIdRaw)) {
    return makeRpcResponse({ id, result: toolError('node_id is required') })
  }

  const nodeId = await resolvePublicNodeId(db, treeRow.tree_id, String(nodeIdRaw))
  if (!nodeId) {
    return makeRpcResponse({ id, result: toolError('Node not found') })
  }
  if (!accessibleSet.has(nodeId)) {
    return makeRpcResponse({ id, result: toolError('Access denied to node') })
  }

  const nodeRow = await db.prepare('SELECT id FROM nodes WHERE id = ? AND tree_id = ?')
    .bind(nodeId, treeRow.tree_id)
    .first<{ id: number }>()
  if (!nodeRow) {
    return makeRpcResponse({ id, result: toolError('Node not found') })
  }

  const bytes = base64ToUint8Array(dataBase64)
  if (!bytes) {
    return makeRpcResponse({ id, result: toolError('Invalid data_base64') })
  }

  try {
    const createdImage = await createMcpNodeImage(
      db,
      env.NODE_IMAGES,
      treeRow.tree_id,
      nodeId,
      String(nodeIdRaw),
      filename,
      contentType,
      bytes,
      principal.user_id,
    )
    queueAuditLog({ userId: principal.user_id, action: 'mcp.node.image_create', targetType: 'node', targetId: nodeId, treeId: treeRow.tree_id, source: 'mcp' })
    return makeRpcResponse({
      id,
      result: toToolResult(createdImage),
    })
  } catch (error) {
    return makeRpcResponse({ id, result: toolError(String(error instanceof Error ? error.message : error)) })
  }
}

/**
 * 画像アップロード用の1回限りの合鍵を発行する。
 * 画像のバイトは AI を通さず、返した curl コマンドで PUT /api/mcp/uploads へ直接送らせる。
 */
export async function createNodeImageUpload(ctx: McpToolContext) {
  const { id, args, db, principal, treeRow, accessibleSet, requestOrigin, queueAuditLog, makeRpcResponse, toToolResult, toolError } = ctx
  const nodeIdRaw = args.node_id
  const filename = args.filename === undefined ? '' : String(args.filename).trim()
  const contentType = args.content_type === undefined ? '' : String(args.content_type).trim().toLowerCase()
  const sizeBytes = Number(args.size_bytes)

  if (!isValidPublicNodeId(nodeIdRaw)) {
    return makeRpcResponse({ id, result: toolError('node_id is required') })
  }
  if (!filename || filename.length > UPLOAD_FILENAME_MAX_LENGTH) {
    return makeRpcResponse({ id, result: toolError(`filename is required (max ${UPLOAD_FILENAME_MAX_LENGTH} characters)`) })
  }
  if (!NODE_IMAGE_ALLOWED_MIMES.has(contentType)) {
    return makeRpcResponse({ id, result: toolError(`content_type must be one of: ${[...NODE_IMAGE_ALLOWED_MIMES].join(', ')}`) })
  }
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_NODE_IMAGE_SIZE_BYTES) {
    return makeRpcResponse({ id, result: toolError(`size_bytes must be an integer from 1 to ${MAX_NODE_IMAGE_SIZE_BYTES}`) })
  }
  if (!requestOrigin) {
    return makeRpcResponse({ id, result: toolError('Upload URL is not available') })
  }

  const nodeId = await resolvePublicNodeId(db, treeRow.tree_id, String(nodeIdRaw))
  if (!nodeId) {
    return makeRpcResponse({ id, result: toolError('Node not found') })
  }
  if (!accessibleSet.has(nodeId)) {
    return makeRpcResponse({ id, result: toolError('Access denied to node') })
  }

  const { token, expiresAt } = await issueImageUpload(db, {
    userId: principal.user_id,
    treeId: treeRow.tree_id,
    nodeId,
    nodePublicId: String(nodeIdRaw),
    filename,
    contentType,
    sizeBytes,
  })
  const uploadUrl = `${requestOrigin}${MCP_IMAGE_UPLOAD_PATH}`

  queueAuditLog({ userId: principal.user_id, action: 'mcp.node.image_upload_issue', targetType: 'node', targetId: nodeId, treeId: treeRow.tree_id, source: 'mcp' })
  return makeRpcResponse({
    id,
    result: toToolResult({
      upload_url: uploadUrl,
      upload_token: token,
      expires_at: expiresAt,
      curl_command: buildCurlCommand(uploadUrl, token, contentType),
    }),
  })
}

export const MAX_NODE_IMAGE_SIZE_BYTES = 5 * 1024 * 1024

// image/svg+xml は意図的に許可しない。SVGはブラウザで直接開いた際にスクリプトが実行される
// （同一オリジンXSS）ため、アップロードを禁止し既存分は attachment 配信する
export const NODE_IMAGE_MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
}
export const NODE_IMAGE_ALLOWED_MIMES = new Set(Object.keys(NODE_IMAGE_MIME_TO_EXT))

export function validateImageMagicBytes(bytes: Uint8Array, mimeType: string): boolean {
  const starts = (prefix: number[]) => prefix.every((value, index) => bytes[index] === value)
  switch (mimeType.toLowerCase()) {
    case 'image/png': return starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    case 'image/jpeg': return starts([0xff, 0xd8, 0xff])
    case 'image/gif': return starts([0x47, 0x49, 0x46, 0x38])
    case 'image/webp': return starts([0x52, 0x49, 0x46, 0x46]) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    default: return false
  }
}

export function resolveImageExt(fileNameRaw: string, mimeTypeRaw: string): string {
  const fileName = String(fileNameRaw || '').trim()
  const mimeType = String(mimeTypeRaw || '').toLowerCase()
  const byMime = NODE_IMAGE_MIME_TO_EXT[mimeType]
  if (byMime) return byMime

  const dotIndex = fileName.lastIndexOf('.')
  if (dotIndex >= 0) {
    const ext = fileName.slice(dotIndex + 1).toLowerCase()
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext)) {
      return ext === 'jpeg' ? 'jpg' : ext
    }
  }

  return ''
}

export function splitFileNameAndExt(fileNameRaw: string): { baseName: string; ext: string } {
  const input = String(fileNameRaw || '').trim()
  if (!input) return { baseName: 'image', ext: '' }

  const lastDot = input.lastIndexOf('.')
  if (lastDot <= 0 || lastDot === input.length - 1) {
    return { baseName: input, ext: '' }
  }
  return {
    baseName: input.slice(0, lastDot),
    ext: input.slice(lastDot + 1).toLowerCase(),
  }
}

export function normalizeImageBaseName(rawBaseName: string): string {
  const cleaned = String(rawBaseName || '')
    .replace(/[\/\\]/g, ' ')
    .replace(/["<>\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || 'image'
}

export function buildStoredImageFileName(baseName: string, ext: string, serial: number): string {
  if (serial <= 1) return `${baseName}.${ext}`
  return `${baseName} (${serial}).${ext}`
}

export function buildNodeImageFileUrl(treeId: number, nodePublicId: string, imageId: number): string {
  return `/api/trees/${treeId}/nodes/${nodePublicId}/images/${imageId}/file`
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * content から、指定した画像URLを指す画像タグ（`![alt](url)`）だけを取り除く。
 * - alt は `](` と `![` と改行を含まない範囲に限る。alt を lazy な `.*?` にすると、
 *   `![a](他の画像)![b](対象)` で他の画像のタグまで巻き込んで消えてしまう
 * - タグだけの行は行ごと取り除く。それ以外（同じ行の他の文字・他の行）は書き換えない
 */
export function stripNodeImageMarkdownReferences(contentRaw: string | null | undefined, imageUrl: string): string {
  const content = String(contentRaw || '')
  if (!content) return content

  const imageTagPattern = new RegExp(
    `!\\[(?:(?!\\]\\(|!\\[)[^\\n])*\\]\\(${escapeRegexLiteral(imageUrl)}(?:\\s+"[^"]*")?\\)`,
    'g'
  )
  // 後ろのタグから取り除けば、前のタグの位置はずれない
  const matches = [...content.matchAll(imageTagPattern)].reverse()
  return matches.reduce((current, match) => removeTagAt(current, match.index ?? 0, match[0].length), content)
}

function removeTagAt(content: string, tagStart: number, tagLength: number): string {
  const tagEnd = tagStart + tagLength
  const lineStart = content.lastIndexOf('\n', tagStart - 1) + 1
  const newlineIndex = content.indexOf('\n', tagEnd)
  const lineEnd = newlineIndex === -1 ? content.length : newlineIndex

  const isTagOnlyLine = content.slice(lineStart, tagStart).trim() === '' && content.slice(tagEnd, lineEnd).trim() === ''
  if (!isTagOnlyLine) return content.slice(0, tagStart) + content.slice(tagEnd)

  if (newlineIndex !== -1) return content.slice(0, lineStart) + content.slice(newlineIndex + 1)
  // 最終行: 直前の改行（CRLF なら \r も）ごと取り除く
  const cutIndex = content[lineStart - 2] === '\r' ? lineStart - 2 : lineStart - 1
  return content.slice(0, Math.max(cutIndex, 0))
}

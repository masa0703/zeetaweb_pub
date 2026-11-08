import type { Context } from 'hono'

import { resolveSameAppPath } from '../../public/static/safe-redirect.js'

// 画面側の maxlength と同じ値に揃えている（`src/views/tree-modals.html` のツリー作成／編集モーダル）
export const TREE_NAME_MAX_LENGTH = 100
export const TREE_DESCRIPTION_MAX_LENGTH = 500
export const NODE_TITLE_MAX_LENGTH = 300
export const NODE_CONTENT_MAX_LENGTH = 200_000
export const JSON_WRITE_MAX_BYTES = 256 * 1024
export const MCP_JSON_MAX_BYTES = 6 * 1024 * 1024
export const MAX_TREES_PER_USER = 20
export const MAX_NODES_PER_TREE = 20_000

export class QuotaExceededError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QuotaExceededError'
  }
}

export async function assertNodeQuota(db: D1Database, treeId: number, additional: number): Promise<void> {
  const row = await db.prepare('SELECT node_count FROM trees WHERE id = ?').bind(treeId).first<{ node_count: number }>()
  if (!row || Number(row.node_count || 0) + additional > MAX_NODES_PER_TREE) {
    throw new QuotaExceededError('Node quota exceeded')
  }
}

export type TextLimitResult =
  | { ok: true; value: string }
  | { ok: false; error: string }

export function validateTextLimit(
  value: unknown,
  field: string,
  maxLength: number,
  options: { required?: boolean; trim?: boolean } = {},
): TextLimitResult {
  if (typeof value !== 'string') {
    return { ok: false, error: `${field} must be a string` }
  }

  const normalized = options.trim ? value.trim() : value
  if (options.required && normalized.length === 0) {
    return { ok: false, error: `${field} is required` }
  }
  if (normalized.length > maxLength) {
    return { ok: false, error: `${field} must be ${maxLength} characters or fewer` }
  }

  return { ok: true, value: normalized }
}

// 絵文字1つ分の上限。家族・肌色付きなどの組み合わせ絵文字でも 20 前後に収まる
export const TREE_ICON_MAX_LENGTH = 32

const EMOJI_PATTERN = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u

/**
 * ツリーアイコンは「見た目で1文字の絵文字」だけを受け付ける。
 * 👨‍👩‍👧 や 🇯🇵 は複数のコードポイントでできているため、length ではなく書記素で数える。
 */
export function validateTreeIcon(value: unknown): TextLimitResult {
  if (typeof value !== 'string') {
    return { ok: false, error: 'Tree icon must be a string' }
  }
  if (value.length === 0 || value.length > TREE_ICON_MAX_LENGTH) {
    return { ok: false, error: 'Tree icon must be a single emoji' }
  }
  const graphemes = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value))
  if (graphemes.length !== 1 || !EMOJI_PATTERN.test(value)) {
    return { ok: false, error: 'Tree icon must be a single emoji' }
  }
  return { ok: true, value }
}

// ツリーの丸アイコンの背景色。`public/static/tree-rail.js` の CHIP_COLORS と同じキーに揃える
export const TREE_COLOR_KEYS = ['indigo', 'sky', 'emerald', 'amber', 'red', 'violet', 'white', 'pink'] as const

export function validateTreeColor(value: unknown): TextLimitResult {
  if (typeof value !== 'string' || !(TREE_COLOR_KEYS as readonly string[]).includes(value)) {
    return { ok: false, error: `Tree color must be one of: ${TREE_COLOR_KEYS.join(', ')}` }
  }
  return { ok: true, value }
}

export function requestBodyIsTooLarge(contentLength: string | undefined): boolean {
  if (!contentLength) return false
  const bytes = Number(contentLength)
  return Number.isFinite(bytes) && bytes > JSON_WRITE_MAX_BYTES
}

export function requestBodyExceedsLimit(contentLength: string | undefined, maxBytes = JSON_WRITE_MAX_BYTES): boolean {
  if (!contentLength) return false
  const bytes = Number(contentLength)
  return Number.isFinite(bytes) && bytes > maxBytes
}

export function isTestBackdoorEnvironmentAllowed(appUrl: string): boolean {
  try {
    const hostname = new URL(appUrl).hostname
    return hostname === 'localhost' || hostname === '127.0.0.1'
  } catch {
    return false
  }
}

/** HTTP exposure for operator-only jobs stays disabled until an operator identity exists. */
export function disabledOperatorHttpRoute(c: Context) {
  return c.json({ success: false, error: 'Not Found' }, 404)
}

/**
 * OAuth return targets must stay within this application. Only root-relative
 * paths are accepted; absolute, protocol-relative, backslash and control-char
 * variants fall back to the normal post-login page.
 *
 * 判定そのものは `public/static/safe-redirect.js` の `resolveSameAppPath()` が唯一の実装で、
 * ログイン画面も同じファイルを読む。ここは fallback を被せるだけの薄いラッパー。
 */
export function safeSameAppRedirect(
  candidate: string | null | undefined,
  fallback = '/index.html',
): string {
  return resolveSameAppPath(candidate) ?? fallback
}

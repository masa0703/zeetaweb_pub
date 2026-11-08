/**
 * 検索語の解釈（REST /api/search と MCP search_nodes の共通実装）
 *
 * 以前は REST が全角スペースのみ置換、MCP が全角英数も半角化しており、
 * 同じ検索語でも経路によって結果が変わっていた。
 */

/** 全角スペース→半角、全角英数記号（！〜～）→半角。フロント app.js の同名関数と同じ規則 */
export function normalizeSearchKeyword(input: unknown): string {
  return String(input || '')
    .replace(/　/g, ' ')
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
}

export interface ParsedSearchQuery {
  /** 正規化・trim 済みの検索語全体（ベクトル検索の埋め込み入力に使う） */
  normalized: string
  /** 空白区切りの語（LIKE 検索に使う） */
  terms: string[]
}

export function parseSearchQuery(input: unknown): ParsedSearchQuery {
  const normalized = normalizeSearchKeyword(input).trim()
  return { normalized, terms: normalized.split(/\s+/).filter(Boolean) }
}

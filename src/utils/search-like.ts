// D1 の LIKE パターン長制限への対策ユーティリティ
//
// D1 は LIKE パターンが約50バイトを超えると
// `D1_ERROR: LIKE or GLOB pattern too complex: SQLITE_ERROR` を投げる
// （標準 SQLite の上限 50,000 バイトと異なり極端に小さい。2026-07-20 に本番で実測）。
// 日本語は1文字3バイトのため、16文字程度の検索語で発生する。
// 長い検索語をバイト境界で分割し、「全セグメントを含む」AND 条件として扱うことで回避する。

// '%' + term + '%' 全体で50バイト未満に収まる安全上限（余裕をみて40バイト）
export const LIKE_PATTERN_MAX_BYTES = 40

const encoder = new TextEncoder()

/**
 * 検索語を LIKE パターンとして安全なバイト長のセグメントに分割する。
 * - 上限以下ならそのまま1要素で返す
 * - 超える場合は文字境界（コードポイント単位）で分割する
 */
export function splitTermForLike(term: string): string[] {
  if (encoder.encode(term).length <= LIKE_PATTERN_MAX_BYTES) return [term]
  const segments: string[] = []
  let current = ''
  let currentBytes = 0
  for (const ch of term) {
    const chBytes = encoder.encode(ch).length
    if (currentBytes + chBytes > LIKE_PATTERN_MAX_BYTES) {
      if (current) segments.push(current)
      current = ch
      currentBytes = chBytes
    } else {
      current += ch
      currentBytes += chBytes
    }
  }
  if (current) segments.push(current)
  return segments
}

/**
 * 検索語リストから LIKE の WHERE 句と bind 値を構築する。
 * - 各検索語は splitTermForLike で分割され、セグメント群は AND で束ねる
 *   （長い語 = 「全部分文字列を含む」近似。D1 制限内で意味をほぼ維持する）
 * - 語同士は joiner（AND/OR）で結合
 * - negate=true で NOT(...) を付ける（exclude 用）
 * - titleOnly=true でタイトルのみを検索対象にする（content を見ない）
 */
export function buildLikeClause(
  terms: string[],
  joiner: ' AND ' | ' OR ',
  negate = false,
  titleOnly = false,
): { clause: string; binds: string[] } {
  const parts: string[] = []
  const binds: string[] = []
  const columnPattern = titleOnly ? '(n.title LIKE ?)' : '(n.title LIKE ? OR n.content LIKE ?)'
  for (const term of terms) {
    const segments = splitTermForLike(term)
    const segmentClause = segments
      .map(() => columnPattern)
      .join(' AND ')
    parts.push(negate ? `NOT (${segmentClause})` : `(${segmentClause})`)
    for (const segment of segments) {
      const likeTerm = `%${segment}%`
      if (titleOnly) {
        binds.push(likeTerm)
      } else {
        binds.push(likeTerm, likeTerm)
      }
    }
  }
  return { clause: parts.join(negate ? ' AND ' : joiner), binds }
}

import { test, expect } from '@playwright/test'
import { splitTermForLike, buildLikeClause, LIKE_PATTERN_MAX_BYTES } from '../src/utils/search-like'

const byteLen = (s: string) => new TextEncoder().encode(s).length

test.describe('splitTermForLike', () => {
  test('上限以下の語はそのまま1要素', () => {
    expect(splitTermForLike('ベクトル')).toEqual(['ベクトル'])
    expect(splitTermForLike('short ascii term')).toEqual(['short ascii term'])
  })

  test('長い日本語（D1で実際に落ちた25文字）はバイト境界で分割される', () => {
    const term = '認証付きリクエストをブラウザから実行しないといけない理由'
    const segments = splitTermForLike(term)
    expect(segments.length).toBeGreaterThan(1)
    // 各セグメントは上限以下
    for (const seg of segments) {
      expect(byteLen(seg)).toBeLessThanOrEqual(LIKE_PATTERN_MAX_BYTES)
    }
    // 連結すると元の語に戻る（欠落なし）
    expect(segments.join('')).toBe(term)
  })

  test('サロゲートペア（絵文字）を壊さない', () => {
    const term = '🎉'.repeat(30) // 4バイト×30 = 120バイト
    const segments = splitTermForLike(term)
    expect(segments.join('')).toBe(term)
    for (const seg of segments) {
      expect(byteLen(seg)).toBeLessThanOrEqual(LIKE_PATTERN_MAX_BYTES)
    }
  })
})

test.describe('buildLikeClause', () => {
  test('短い語2つ・AND', () => {
    const { clause, binds } = buildLikeClause(['foo', 'bar'], ' AND ')
    expect(clause).toBe('((n.title LIKE ? OR n.content LIKE ?)) AND ((n.title LIKE ? OR n.content LIKE ?))')
    expect(binds).toEqual(['%foo%', '%foo%', '%bar%', '%bar%'])
  })

  test('長い語は分割セグメントが AND で束ねられ、OR結合でも語単位でグループ化される', () => {
    const long = '認証付きリクエストをブラウザから実行しないといけない理由'
    const { clause, binds } = buildLikeClause([long, 'foo'], ' OR ')
    const segments = splitTermForLike(long)
    // 語グループは2つ（OR 結合）。トップレベルの結合は `) OR (` の形になる
    // （LIKE ペア内部の `? OR n.` と区別して数える）
    expect(clause.split(') OR (').length).toBe(2)
    // 長い語のグループ内は AND
    expect(clause).toContain(segments.map(() => '(n.title LIKE ? OR n.content LIKE ?)').join(' AND '))
    // binds: セグメント数×2 + 2
    expect(binds.length).toBe(segments.length * 2 + 2)
    // 全パターンが50バイト未満
    for (const b of binds) {
      expect(byteLen(b)).toBeLessThan(50)
    }
  })

  test('negate（exclude）は NOT で包み AND 結合', () => {
    const { clause, binds } = buildLikeClause(['x', 'y'], ' AND ', true)
    expect(clause).toBe('NOT ((n.title LIKE ? OR n.content LIKE ?)) AND NOT ((n.title LIKE ? OR n.content LIKE ?))')
    expect(binds).toEqual(['%x%', '%x%', '%y%', '%y%'])
  })

  test('空リストは空句', () => {
    const { clause, binds } = buildLikeClause([], ' AND ')
    expect(clause).toBe('')
    expect(binds).toEqual([])
  })

  test('titleOnly=true はタイトル列のみの句を生成し bind も半分になる', () => {
    const { clause, binds } = buildLikeClause(['foo', 'bar'], ' AND ', false, true)
    expect(clause).toBe('((n.title LIKE ?)) AND ((n.title LIKE ?))')
    expect(binds).toEqual(['%foo%', '%bar%'])
  })

  test('titleOnly + negate は NOT で包み bind は1つ', () => {
    const { clause, binds } = buildLikeClause(['x'], ' AND ', true, true)
    expect(clause).toBe('NOT ((n.title LIKE ?))')
    expect(binds).toEqual(['%x%'])
  })

  test('titleOnly + 長い語は分割セグメント数と bind 数が一致する', () => {
    const long = '認証付きリクエストをブラウザから実行しないといけない理由'
    const segments = splitTermForLike(long)
    const { binds } = buildLikeClause([long], ' AND ', false, true)
    expect(binds.length).toBe(segments.length)
    for (const b of binds) {
      expect(byteLen(b)).toBeLessThan(50)
    }
  })

  test('titleOnly 未指定は title+content の両方を見る', () => {
    const { clause, binds } = buildLikeClause(['foo'], ' AND ')
    expect(clause).toBe('((n.title LIKE ? OR n.content LIKE ?))')
    expect(binds).toEqual(['%foo%', '%foo%'])
  })
})

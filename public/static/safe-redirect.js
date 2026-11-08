/**
 * 戻り先（ログイン後に戻るURL）検証の唯一の実装。
 *
 * サーバー（`src/utils/request-safety.ts` の `safeSameAppRedirect()`）と
 * ログイン画面（`public/login.html`）の両方がこのファイルを読む。
 * 以前はそれぞれに同じロジックの写しがあり、同一の欠陥が両方に同時に存在した。
 *
 * アプリ内の root-relative path だけを許可する。絶対URL・protocol-relative（`//`）・
 * バックスラッシュ・制御文字・不正URLは `null` を返す。
 *
 * @param {string | null | undefined} candidate
 * @returns {string | null} 安全な相対パス。許可できない場合は null
 */
export function resolveSameAppPath(candidate) {
  if (!candidate || !candidate.startsWith('/') || candidate.startsWith('//')) return null
  if (candidate.includes('\\') || /[\u0000-\u001f\u007f]/.test(candidate)) return null

  try {
    const base = new URL('https://zeeta.invalid')
    const resolved = new URL(candidate, base)
    if (resolved.origin !== base.origin) return null
    // dot segment の正規化は `/..//evil.example` を `//evil.example` に変えるため、
    // 入力だけでなく出力も protocol-relative になっていないか確認する
    const target = `${resolved.pathname}${resolved.search}${resolved.hash}`
    if (!target.startsWith('/') || target.startsWith('//')) return null
    return target
  } catch {
    return null
  }
}

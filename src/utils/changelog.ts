/**
 * ヘルプ画面「変更履歴」タブの中身を組み立てる。
 *
 * 履歴の正は src/data/changelog.json（利用者向けの簡潔な文。日英を同数ずつ持つ）。
 * ファイル内の並び順に依存せず、日付の降順で描画する。
 * 文中の `...` だけは <code> にし、それ以外はすべてエスケープする。
 */

export type ChangelogLocale = 'ja' | 'en'

export interface ChangelogEntry {
  readonly date: string
  readonly ja: readonly string[]
  readonly en: readonly string[]
}

export const CHANGELOG_PLACEHOLDER = '<!-- CHANGELOG_ENTRIES -->'

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char])
}

/** エスケープ後に `...` を <code> へ置き換える（バッククォートはエスケープ対象外なので安全） */
function renderInline(text: string): string {
  return escapeHtml(text).replace(/`([^`]+)`/g, '<code>$1</code>')
}

function renderEntry(entry: ChangelogEntry, locale: ChangelogLocale): string {
  const items = entry[locale].map((line) => `<li>${renderInline(line)}</li>`).join('')
  return (
    '<li class="changelog-entry">' +
    `<time class="changelog-date" datetime="${escapeHtml(entry.date)}">${escapeHtml(entry.date)}</time>` +
    `<ul class="changelog-items">${items}</ul>` +
    '</li>'
  )
}

export function renderChangelogHtml(entries: readonly ChangelogEntry[], locale: ChangelogLocale): string {
  const sorted = [...entries].sort((a, b) => b.date.localeCompare(a.date))
  return `<ol class="changelog-list">${sorted.map((entry) => renderEntry(entry, locale)).join('')}</ol>`
}

/** ヘルプHTMLのプレースホルダを変更履歴で置き換える。プレースホルダが無ければ記録して原文を返す */
export function injectChangelog(html: string, entries: readonly ChangelogEntry[], locale: ChangelogLocale): string {
  if (!html.includes(CHANGELOG_PLACEHOLDER)) {
    console.error('[changelog] placeholder not found in help html')
    return html
  }
  return html.replace(CHANGELOG_PLACEHOLDER, () => renderChangelogHtml(entries, locale))
}

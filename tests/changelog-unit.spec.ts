import assert from 'node:assert/strict'
import test from 'node:test'

import changelog from '../src/data/changelog.json' with { type: 'json' }
import { renderChangelogHtml, type ChangelogEntry } from '../src/utils/changelog.ts'

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

test('renders entries in descending date order regardless of file order', () => {
  const entries: ChangelogEntry[] = [
    { date: '2026-10-01', ja: ['古い'], en: ['old'] },
    { date: '2026-11-25', ja: ['新しい'], en: ['new'] },
    { date: '2026-11-01', ja: ['中間'], en: ['middle'] },
  ]
  const html = renderChangelogHtml(entries, 'ja')
  const order = ['新しい', '中間', '古い'].map(text => html.indexOf(text))
  assert.ok(order.every(index => index >= 0))
  assert.deepEqual([...order].sort((a, b) => a - b), order)
  assert.ok(html.indexOf('2026-11-25') < html.indexOf('2026-10-01'))
})

test('renders the requested locale only', () => {
  const entries: ChangelogEntry[] = [{ date: '2026-11-25', ja: ['日本語'], en: ['English'] }]
  assert.ok(renderChangelogHtml(entries, 'en').includes('English'))
  assert.ok(!renderChangelogHtml(entries, 'en').includes('日本語'))
  assert.ok(renderChangelogHtml(entries, 'ja').includes('日本語'))
})

test('escapes HTML in entries but keeps backticks as <code>', () => {
  const entries: ChangelogEntry[] = [{ date: '2026-11-25', ja: ['<img src=x onerror=alert(1)> と `id:abc`'], en: ['x'] }]
  const html = renderChangelogHtml(entries, 'ja')
  assert.ok(!html.includes('<img'))
  assert.ok(html.includes('&lt;img'))
  assert.ok(html.includes('<code>id:abc</code>'))
})

test('does not mutate the input array', () => {
  const entries: ChangelogEntry[] = [
    { date: '2026-10-01', ja: ['a'], en: ['a'] },
    { date: '2026-11-01', ja: ['b'], en: ['b'] },
  ]
  renderChangelogHtml(entries, 'ja')
  assert.equal(entries[0].date, '2026-10-01')
})

test('changelog.json is well-formed: valid dates, unique, both languages with the same count', () => {
  const entries = changelog as ChangelogEntry[]
  assert.ok(entries.length > 0)
  const dates = entries.map(entry => entry.date)
  assert.equal(new Set(dates).size, dates.length, 'each date appears once')
  for (const entry of entries) {
    assert.match(entry.date, DATE_PATTERN)
    assert.ok(!Number.isNaN(Date.parse(entry.date)), entry.date)
    assert.ok(entry.ja.length > 0, entry.date)
    assert.equal(entry.ja.length, entry.en.length, `${entry.date}: ja/en item counts differ`)
    for (const line of [...entry.ja, ...entry.en]) assert.ok(line.trim().length > 0, entry.date)
  }
})

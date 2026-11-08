import assert from 'node:assert/strict'
import test from 'node:test'

import enDictionary from '../public/static/i18n/en.json' with { type: 'json' }
import jaDictionary from '../public/static/i18n/ja.json' with { type: 'json' }
import { normalizeLocale, resolveLocaleFromRequest, serverT } from '../src/utils/i18n.ts'

type Dictionary = Record<string, unknown>

function flattenDictionary(value: Dictionary, prefix = ''): Map<string, string> {
  const entries = new Map<string, string>()
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof child === 'string') {
      entries.set(path, child)
    } else if (child && typeof child === 'object' && !Array.isArray(child)) {
      for (const [nestedKey, nestedValue] of flattenDictionary(child as Dictionary, path)) {
        entries.set(nestedKey, nestedValue)
      }
    } else {
      assert.fail(`Dictionary value at ${path} must be a string or object`)
    }
  }
  return entries
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).sort()
}

test('normalizeLocale normalizes supported locales and rejects unsupported values', () => {
  assert.equal(normalizeLocale('ja'), 'ja')
  assert.equal(normalizeLocale('ja-JP'), 'ja')
  assert.equal(normalizeLocale('JA'), 'ja')
  assert.equal(normalizeLocale('en'), 'en')
  assert.equal(normalizeLocale('en-US'), 'en')
  assert.equal(normalizeLocale('fr'), null)
  assert.equal(normalizeLocale(''), null)
  assert.equal(normalizeLocale(null), null)
  assert.equal(normalizeLocale(undefined), null)
})

test('resolveLocaleFromRequest gives a valid cookie precedence', () => {
  assert.equal(resolveLocaleFromRequest('ja', 'en-US,en;q=0.9'), 'ja')
  assert.equal(resolveLocaleFromRequest('en', 'ja,en;q=0.9'), 'en')
})

test('resolveLocaleFromRequest falls back from an invalid cookie to Accept-Language', () => {
  assert.equal(resolveLocaleFromRequest('bogus', 'ja,en;q=0.9'), 'ja')
})

test('resolveLocaleFromRequest uses only the first Accept-Language tag', () => {
  assert.equal(resolveLocaleFromRequest(null, 'ja,en;q=0.9'), 'ja')
  assert.equal(resolveLocaleFromRequest(null, 'en-US,en;q=0.9'), 'en')
  assert.equal(resolveLocaleFromRequest(null, 'fr-FR'), 'en')
  assert.equal(resolveLocaleFromRequest(null, 'zh-CN,ja;q=0.8'), 'en')
})

test('resolveLocaleFromRequest defaults to English when no preference exists', () => {
  assert.equal(resolveLocaleFromRequest(null, null), 'en')
  assert.equal(resolveLocaleFromRequest(undefined, undefined), 'en')
})

test('serverT resolves Japanese and English keys', () => {
  assert.equal(serverT('ja', 'mypage.newTree'), '新しいツリー')
  assert.equal(serverT('en', 'mypage.newTree'), 'New tree')
})

test('serverT replaces placeholders', () => {
  assert.equal(serverT('ja', 'mypage.ownerLabel', { name: '山田' }), 'オーナー: 山田')
  assert.equal(serverT('en', 'mypage.ownerLabel', { name: 'Alice' }), 'Owner: Alice')
})

test('serverT returns an unknown key unchanged', () => {
  assert.equal(serverT('en', 'missing.translation.key'), 'missing.translation.key')
})

test('Japanese and English dictionaries have identical keys and placeholders', () => {
  const jaEntries = flattenDictionary(jaDictionary)
  const enEntries = flattenDictionary(enDictionary)

  assert.deepEqual([...jaEntries.keys()].sort(), [...enEntries.keys()].sort())
  for (const [key, jaValue] of jaEntries) {
    assert.deepEqual(
      placeholders(jaValue),
      placeholders(enEntries.get(key) as string),
      `Placeholder mismatch at ${key}`,
    )
  }
})

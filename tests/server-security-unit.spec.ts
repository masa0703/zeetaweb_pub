import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'

import { findActiveSession } from '../src/utils/session-auth.ts'
import {
  NODE_CONTENT_MAX_LENGTH,
  NODE_TITLE_MAX_LENGTH,
  TREE_DESCRIPTION_MAX_LENGTH,
  TREE_NAME_MAX_LENGTH,
  disabledOperatorHttpRoute,
  requestBodyIsTooLarge,
  safeSameAppRedirect,
  validateTextLimit,
  validateTreeColor,
  validateTreeIcon,
  isTestBackdoorEnvironmentAllowed,
} from '../src/utils/request-safety.ts'
import { verifyJWT, validateJWTSecret } from '../src/utils/jwt.ts'
import { normalizeGoogleUser } from '../src/config/oauth.ts'

const userId = 7

function sessionDb(row: { id: string; user_id: number } | null) {
  const calls: Array<{ sql: string; bindings: unknown[] }> = []
  return {
    calls,
    db: {
      prepare(sql: string) {
        return {
          bind(...bindings: unknown[]) {
            calls.push({ sql, bindings })
            return { first: async () => row }
          },
        }
      },
    },
  }
}

test('bulk vector sync is not exposed over HTTP', async () => {
  const app = new Hono()
  app.post('/api/vectorize-bulk-sync', disabledOperatorHttpRoute)
  const response = await app.request('/api/vectorize-bulk-sync', { method: 'POST' })
  assert.equal(response.status, 404)
})

test('deleted or logged-out sessions fail active-session validation immediately', async () => {
  const token = 'signed-jwt-token'
  const { db } = sessionDb(null)
  const active = await findActiveSession(db as any, token, {
    user_id: userId, session_id: 'deleted-session', email: '', display_name: '', oauth_provider: '', iat: 1, exp: 2,
  })
  assert.equal(active, null)
})

test('active-session validation binds session ID and JWT user and checks user/expiry', async () => {
  const token = 'signed-jwt-token'
  const { db, calls } = sessionDb({ id: 'active-session', user_id: userId })
  const active = await findActiveSession(db as any, token, {
    user_id: userId, session_id: 'active-session', email: '', display_name: '', oauth_provider: '', iat: 1, exp: 2,
  })
  assert.deepEqual(active, { id: 'active-session', user_id: userId })
  assert.deepEqual(calls[0].bindings, ['active-session', userId])
  assert.match(calls[0].sql, /JOIN users/)
  assert.match(calls[0].sql, /unixepoch\(s\.expires_at\)/)
})

// 近接期限のセッションはリクエストごとに token が回転する。token 一致を条件にすると
// 並行リクエストの回転前 token 側が全て401になり、有効なユーザーがログアウトさせられる
test('active-session validation does not require the rotated token to match', async () => {
  const { db, calls } = sessionDb({ id: 'active-session', user_id: userId })
  const active = await findActiveSession(db as any, 'token-rotated-by-a-parallel-request', {
    user_id: userId, session_id: 'active-session', email: '', display_name: '', oauth_provider: '', iat: 1, exp: 2,
  })
  assert.deepEqual(active, { id: 'active-session', user_id: userId })
  assert.doesNotMatch(calls[0].sql, /s\.token = \?/)
})

test('legacy JWT lookup remains supported by exact token', async () => {
  const token = 'legacy-signed-jwt-token'
  const payload = {
    user_id: userId,
    email: '',
    display_name: '',
    oauth_provider: '',
    iat: 1,
    exp: 2,
  }
  const { db, calls } = sessionDb({ id: 'legacy-session', user_id: userId })

  const active = await findActiveSession(db as any, token, payload)

  assert.deepEqual(active, { id: 'legacy-session', user_id: userId })
  assert.deepEqual(calls[0].bindings, [token, userId])
  assert.doesNotMatch(calls[0].sql, /s\.id = \?/) 
})

test('OAuth return targets allow only same-app root-relative paths', () => {
  assert.equal(safeSameAppRedirect('/accept-invitation?token=abc'), '/accept-invitation?token=abc')
  assert.equal(safeSameAppRedirect('/index.html?tree=1#node'), '/index.html?tree=1#node')
  for (const unsafe of [
    'https://evil.example/phish',
    '//evil.example/phish',
    '/\\evil.example/phish',
    'javascript:alert(1)',
    'index.html',
    // dot segment の正規化後に protocol-relative になるもの
    '/.//evil.example/phish',
    '/..//evil.example/phish',
    '/%2e//evil.example',
    '/a/../..//evil.example',
  ]) {
    assert.equal(safeSameAppRedirect(unsafe), '/index.html')
  }
})

test('tree and node text limits accept boundaries and reject oversized input', () => {
  assert.equal(validateTextLimit('x'.repeat(TREE_NAME_MAX_LENGTH), 'name', TREE_NAME_MAX_LENGTH).ok, true)
  assert.equal(validateTextLimit('x'.repeat(TREE_NAME_MAX_LENGTH + 1), 'name', TREE_NAME_MAX_LENGTH).ok, false)
  assert.equal(validateTextLimit('x'.repeat(TREE_DESCRIPTION_MAX_LENGTH + 1), 'description', TREE_DESCRIPTION_MAX_LENGTH).ok, false)
  assert.equal(validateTextLimit('x'.repeat(NODE_TITLE_MAX_LENGTH + 1), 'title', NODE_TITLE_MAX_LENGTH).ok, false)
  assert.equal(validateTextLimit('x'.repeat(NODE_CONTENT_MAX_LENGTH + 1), 'content', NODE_CONTENT_MAX_LENGTH).ok, false)
  assert.equal(validateTextLimit('   ', 'title', NODE_TITLE_MAX_LENGTH, { required: true, trim: true }).ok, false)
  assert.equal(requestBodyIsTooLarge(String(256 * 1024 + 1)), true)
  assert.equal(requestBodyIsTooLarge(String(256 * 1024)), false)
})

test('tree icon accepts exactly one emoji, including multi-codepoint emoji', () => {
  for (const icon of ['📚', '👍🏽', '👨‍👩‍👧', '🇯🇵', '1️⃣', '❤️']) {
    assert.equal(validateTreeIcon(icon).ok, true, icon)
  }
  for (const icon of ['', 't', 'あ', '📚📚', '📚a', '<b>', 1, null, '👨‍👩‍👧'.repeat(5)]) {
    assert.equal(validateTreeIcon(icon).ok, false, String(icon))
  }
})

test('tree color accepts only the palette keys', () => {
  assert.equal(validateTreeColor('indigo').ok, true)
  assert.equal(validateTreeColor('pink').ok, true)
  for (const color of ['', 'blue', '#6366f1', 'INDIGO', 'red;background:url(x)', 3, null]) {
    assert.equal(validateTreeColor(color).ok, false, String(color))
  }
})

test('JWT rejects short secrets and verifies signatures with Web Crypto', async () => {
  assert.equal(validateJWTSecret('x'.repeat(31)), false)
  assert.equal(validateJWTSecret('x'.repeat(32)), true)
  assert.equal(await verifyJWT('not.a.jwt', 'x'.repeat(32)), null)
})

test('test endpoint environment check compares the URL hostname exactly', () => {
  assert.equal(isTestBackdoorEnvironmentAllowed('http://localhost:3000'), true)
  assert.equal(isTestBackdoorEnvironmentAllowed('http://localhost.evil.test:3000'), false)
  assert.equal(isTestBackdoorEnvironmentAllowed('http://127.0.0.1:3000'), true)
})

test('Google users must have verified_email=true', () => {
  assert.equal(normalizeGoogleUser({ id: 'g1', email: 'a@example.com', verified_email: false }), null)
  assert.equal(normalizeGoogleUser({ id: 'g1', email: 'a@example.com', verified_email: true })?.email, 'a@example.com')
})

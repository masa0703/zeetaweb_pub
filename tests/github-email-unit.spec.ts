import assert from 'node:assert/strict'
import test from 'node:test'

import { pickPrimaryGithubEmail } from '../src/config/oauth.ts'

test('primary+verified のアドレスを最優先で返す', () => {
  const emails = [
    { email: 'secondary@example.com', primary: false, verified: true },
    { email: 'primary@example.com', primary: true, verified: true },
  ]
  assert.equal(pickPrimaryGithubEmail(emails), 'primary@example.com')
})

test('primary が未検証なら verified のアドレスにフォールバックする', () => {
  const emails = [
    { email: 'unverified-primary@example.com', primary: true, verified: false },
    { email: 'verified-other@example.com', primary: false, verified: true },
  ]
  assert.equal(pickPrimaryGithubEmail(emails), 'verified-other@example.com')
})

test('verified な候補が無い場合は null を返す', () => {
  const emails = [
    { email: 'unverified@example.com', primary: true, verified: false },
  ]
  assert.equal(pickPrimaryGithubEmail(emails), null)
})

test('入力が配列でない・要素が不正な場合は null を返す', () => {
  assert.equal(pickPrimaryGithubEmail(null), null)
  assert.equal(pickPrimaryGithubEmail(undefined), null)
  assert.equal(pickPrimaryGithubEmail('not-an-array'), null)
  assert.equal(pickPrimaryGithubEmail([]), null)
  assert.equal(pickPrimaryGithubEmail([{ email: 123, primary: true, verified: true }]), null)
})

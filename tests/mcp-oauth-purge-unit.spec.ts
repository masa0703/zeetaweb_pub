import assert from 'node:assert/strict'
import test from 'node:test'
import { purgeExpiredOAuthClients } from '../src/oauth/mcp-oauth.ts'

test('purgeExpiredOAuthClients removes never-authorized and long-inactive clients with dependents', async () => {
  const statements: string[] = []
  const db = {
    prepare(sql: string) {
      statements.push(sql)
      return {
        bind(..._bindings: unknown[]) {
          return { run: async () => ({ success: true }) }
        },
      }
    },
  }

  await purgeExpiredOAuthClients(db as any, new Date('2026-11-08T00:00:00Z'))

  assert.ok(statements.some((sql) => /mcp_oauth_authorization_requests/i.test(sql)))
  assert.ok(statements.some((sql) => /mcp_oauth_authorization_codes/i.test(sql)))
  assert.ok(statements.some((sql) => /mcp_oauth_tokens/i.test(sql)))
  assert.ok(statements.some((sql) => /mcp_oauth_clients/i.test(sql)))
  assert.ok(statements.every((sql) => /DELETE FROM/i.test(sql)))
})

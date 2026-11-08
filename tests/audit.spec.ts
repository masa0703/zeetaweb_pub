import assert from 'node:assert/strict'
import test from 'node:test'

import { logAudit, logAuditFromContext } from '../src/utils/audit.ts'

test('logAudit writes the expected values and truncates the user agent', async () => {
  const boundArgs: unknown[] = []
  let prepareSql = ''
  let runCalls = 0

  const db = {
    prepare(sql: string) {
      prepareSql = sql
      return {
        bind(...args: unknown[]) {
          boundArgs.push(...args)
          return {
            async run() {
              runCalls += 1
            },
          }
        },
      }
    },
  } as unknown as D1Database

  await logAudit(db, {
    userId: 42,
    action: 'read.node',
    targetType: 'node',
    targetId: 123,
    treeId: 9,
    ipAddress: '203.0.113.10',
    userAgent: 'a'.repeat(200),
    source: 'mcp',
  })

  assert.match(prepareSql, /INSERT INTO audit_logs/)
  // api_key_id は SQL 内で NULL 固定になったため bind 対象から外れる
  assert.deepEqual(boundArgs, [
    42,
    'read.node',
    'node',
    '123',
    9,
    '203.0.113.10',
    'a'.repeat(128),
    'mcp',
  ])
  assert.equal(runCalls, 1)
})

test('logAudit swallows database failures', async () => {
  const db = {
    prepare() {
      throw new Error('simulated D1 failure')
    },
  } as unknown as D1Database

  await assert.doesNotReject(() =>
    logAudit(db, {
      userId: null,
      action: 'read.search',
      targetType: 'node',
    })
  )
})

test('logAuditFromContext reads IP and user agent and waits for completion', async () => {
  const calls: Array<{ params: unknown[]; runCalls: number }> = []
  const waitUntilPromises: Promise<unknown>[] = []

  const db = {
    prepare() {
      const call = { params: [] as unknown[], runCalls: 0 }
      calls.push(call)
      return {
        bind(...args: unknown[]) {
          call.params = args
          return {
            async run() {
              call.runCalls += 1
            },
          }
        },
      }
    },
  } as unknown as D1Database

  const c = {
    req: {
      header(name: string) {
        if (name === 'cf-connecting-ip') return '198.51.100.23'
        if (name === 'user-agent') return 'AuditBot/1.0'
        return undefined
      },
    },
    env: { DB: db },
    executionCtx: {
      waitUntil(promise: Promise<unknown>) {
        waitUntilPromises.push(promise)
      },
    },
  }

  logAuditFromContext(c as any, {
    userId: 99,
    action: 'mcp.read.node',
    targetType: 'node',
  })

  assert.equal(waitUntilPromises.length, 1)
  await waitUntilPromises[0]
  assert.equal(calls.length, 1)
  // api_key_id は SQL 内で NULL 固定になったため bind 対象から外れる
  assert.deepEqual(calls[0]?.params, [
    99,
    'mcp.read.node',
    'node',
    null,
    null,
    '198.51.100.23',
    'AuditBot/1.0',
    'api',
  ])
  assert.equal(calls[0]?.runCalls, 1)
})

test('logAuditFromContext returns immediately when DB is unavailable', () => {
  let waitUntilCalled = false
  const c = {
    req: {
      header() {
        return 'ignored'
      },
    },
    env: {},
    executionCtx: {
      waitUntil() {
        waitUntilCalled = true
      },
    },
  }

  assert.doesNotThrow(() => {
    logAuditFromContext(c as any, {
      userId: null,
      action: 'read.profile',
      targetType: 'user',
    })
  })
  assert.equal(waitUntilCalled, false)
})


test('logAuditFromContext is best-effort when DB prepare fails', async () => {
  let waitUntilCalled = false
  const c = {
    env: {
      DB: {
        prepare() {
          throw new Error('simulated D1 failure')
        },
      },
    },
    req: {
      header() {
        return 'test-agent'
      },
    },
    executionCtx: {
      waitUntil(p: Promise<unknown>) {
        waitUntilCalled = true
        void p
      },
    },
  }

  assert.doesNotThrow(() => {
    logAuditFromContext(c as any, {
      userId: 1,
      action: 'tree.create',
      targetType: 'tree',
      targetId: 99,
    })
  })
  assert.equal(waitUntilCalled, true)
})

test('logAuditFromContext is best-effort when DB run fails', async () => {
  let waitUntilCalled = false
  const c = {
    env: {
      DB: {
        prepare() {
          return {
            bind() {
              return {
                async run() {
                  throw new Error('simulated D1 run failure')
                },
              }
            },
          }
        },
      },
    },
    req: {
      header() {
        return undefined
      },
    },
    executionCtx: {
      waitUntil(p: Promise<unknown>) {
        waitUntilCalled = true
        void p
      },
    },
  }

  assert.doesNotThrow(() => {
    logAuditFromContext(c as any, {
      userId: 1,
      action: 'node.update',
      targetType: 'node',
      targetId: 42,
    })
  })
  assert.equal(waitUntilCalled, true)
})

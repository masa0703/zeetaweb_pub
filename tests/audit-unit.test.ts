/**
 * T2-test: audit.ts unit tests
 *
 * Verifies logAudit and logAuditFromContext behaviour without a real server.
 */

import { logAudit, logAuditFromContext, type AuditLogParams } from '../src/utils/audit.ts'

// ---- helpers ----

function createMockDb(opts?: { failRun?: boolean; failPrepare?: boolean }) {
  const calls: Array<{ sql: string; bindings: unknown[] }> = []

  const db = {
    prepare(sql: string) {
      if (opts?.failPrepare) {
        throw new Error('prepare failed')
      }
      return {
        bind(...bindings: unknown[]) {
          calls.push({ sql, bindings })
          return {
            run: async () => {
              if (opts?.failRun) {
                throw new Error('run failed')
              }
              return { success: true }
            },
          }
        },
      }
    },
  }

  return { db, calls }
}

function assertEqual<T>(actual: T, expected: T, msg: string) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    throw new Error(`${msg}\n  expected: ${e}\n  actual:   ${a}`)
  }
}

function assertIncludes(actual: string, expected: string, msg: string) {
  if (!actual.includes(expected)) {
    throw new Error(`${msg}\n  expected to include: "${expected}"\n  actual: "${actual}"`)
  }
}

// ---- tests ----

async function testLogAuditInsert() {
  const { db, calls } = createMockDb()
  await logAudit(db as any, {
    userId: 42,
    action: 'tree.create',
    targetType: 'tree',
    targetId: 99,
    treeId: 99,
    ipAddress: '1.2.3.4',
    userAgent: 'TestAgent/1.0',
    source: 'api',
  })

  assertEqual(calls.length, 1, 'should make 1 DB call')
  assertIncludes(calls[0].sql, 'INSERT INTO audit_logs', 'should insert into audit_logs')
  // api_key_id は SQL 内で NULL 固定になったため bind されない
  assertEqual(calls[0].bindings[0], 42, 'userId')
  assertEqual(calls[0].bindings[1], 'tree.create', 'action')
  assertEqual(calls[0].bindings[2], 'tree', 'targetType')
  assertEqual(calls[0].bindings[3], '99', 'targetId')
  assertEqual(calls[0].bindings[4], 99, 'treeId')
  assertEqual(calls[0].bindings[5], '1.2.3.4', 'ipAddress')
  assertEqual(calls[0].bindings[6], 'TestAgent/1.0', 'userAgent')
  assertEqual(calls[0].bindings[7], 'api', 'source')
  console.log('  ✓ testLogAuditInsert')
}

async function testLogAuditTruncatesUa() {
  const { db, calls } = createMockDb()
  const longUa = 'A'.repeat(200)
  await logAudit(db as any, {
    userId: null,
    action: 'auth.login',
    targetType: 'user',
    userAgent: longUa,
  })
  assertEqual((calls[0].bindings[6] as string).length, 128, 'userAgent should be truncated to 128')
  console.log('  ✓ testLogAuditTruncatesUa')
}

async function testLogAuditHandlesNulls() {
  const { db, calls } = createMockDb()
  await logAudit(db as any, {
    userId: null,
    action: 'auth.logout',
    targetType: 'user',
  })
  assertEqual(calls[0].bindings[0], null, 'userId null')
  assertEqual(calls[0].bindings[3], null, 'targetId null')
  assertEqual(calls[0].bindings[4], null, 'treeId null')
  assertEqual(calls[0].bindings[7], 'api', 'default source')
  console.log('  ✓ testLogAuditHandlesNulls')
}

async function testLogAuditSwallowsError() {
  const { db } = createMockDb({ failRun: true })
  let threw = false
  try {
    await logAudit(db as any, {
      userId: 1,
      action: 'node.create',
      targetType: 'node',
    })
  } catch {
    threw = true
  }
  assertEqual(threw, false, 'should not throw on DB error')
  console.log('  ✓ testLogAuditSwallowsError')
}

async function testLogAuditFromContextWithWaitUntil() {
  const { db, calls } = createMockDb()
  const waitUntilPromises: Promise<unknown>[] = []

  const c = {
    env: { DB: db },
    req: {
      header(name: string) {
        if (name === 'cf-connecting-ip') return '10.0.0.1'
        if (name === 'user-agent') return 'Mozilla/5.0'
        return undefined
      },
    },
    executionCtx: {
      waitUntil(p: Promise<unknown>) {
        waitUntilPromises.push(p)
      },
    },
  }

  logAuditFromContext(c as any, {
    userId: 5,
    action: 'read.node',
    targetType: 'node',
    targetId: 123,
  })

  // prepare/bind runs synchronously; only the .run() promise is deferred
  assertEqual(calls.length, 1, 'prepare/bind should run immediately')
  assertEqual(waitUntilPromises.length, 1, 'should queue via waitUntil')
  assertEqual(calls[0].bindings[5], '10.0.0.1', 'ip from header')
  assertEqual(calls[0].bindings[6], 'Mozilla/5.0', 'ua from header')

  // Wait for the queued promise to finish
  await waitUntilPromises[0]

  console.log('  ✓ testLogAuditFromContextWithWaitUntil')
}

async function testLogAuditFromContextNoWaitUntil() {
  const { db, calls } = createMockDb()

  const c = {
    env: { DB: db },
    req: {
      header() {
        return undefined
      },
    },
    // no executionCtx
  }

  logAuditFromContext(c as any, {
    userId: 3,
    action: 'tree.delete',
    targetType: 'tree',
  })

  // Give microtask queue a tick
  await new Promise((r) => setTimeout(r, 10))

  assertEqual(calls.length, 1, 'should still run without waitUntil')
  assertEqual(calls[0].bindings[5], null, 'ip null when no header')
  console.log('  ✓ testLogAuditFromContextNoWaitUntil')
}

async function testLogAuditFromContextNoDb() {
  const c = {
    env: {},
    req: { header() {} },
  }
  // Should not throw even without DB
  logAuditFromContext(c as any, {
    userId: 1,
    action: 'node.update',
    targetType: 'node',
  })
  console.log('  ✓ testLogAuditFromContextNoDb')
}

// ---- runner ----

async function run() {
  console.log('Running audit.ts unit tests...')
  await testLogAuditInsert()
  await testLogAuditTruncatesUa()
  await testLogAuditHandlesNulls()
  await testLogAuditSwallowsError()
  await testLogAuditFromContextWithWaitUntil()
  await testLogAuditFromContextNoWaitUntil()
  await testLogAuditFromContextNoDb()
  console.log('\nAll tests passed!')
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})

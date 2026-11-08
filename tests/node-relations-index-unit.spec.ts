import { test, expect } from '@playwright/test'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { getNodePathText } from '../src/utils/vector'
import { setRelationType } from '../src/services/relations'

const STRUCTURAL = 1
const REFERENCE = 3
const SLOW_INDEX = 'idx_node_relations_relation_type'

function createMigratedDb(): DatabaseSync {
  const sqlite = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false })
  const files = readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) sqlite.exec(readFileSync(`migrations/${file}`, 'utf8'))
  // migration が入れる初期データは使わない
  sqlite.exec('DELETE FROM node_relations; DELETE FROM nodes; DELETE FROM trees;')
  return sqlite
}

// node:sqlite を D1Database の必要な範囲だけで包み、実行した各SQLの実行計画を記録する
function createRecordingD1(sqlite: DatabaseSync) {
  const plans: Array<{ sql: string; details: string[] }> = []
  const record = (sql: string, args: unknown[]) => {
    const rows = sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(args as never[])) as Array<{ detail: string }>
    plans.push({ sql, details: rows.map((r) => r.detail) })
  }
  const execute = (sql: string, args: unknown[]) => {
    record(sql, args)
    const stmt = sqlite.prepare(sql)
    if (/^\s*(WITH|SELECT)|RETURNING/i.test(sql)) {
      const results = stmt.all(...(args as never[]))
      return { results, meta: { changes: results.length } }
    }
    const info = stmt.run(...(args as never[]))
    return { results: [], meta: { changes: Number(info.changes) } }
  }
  const prepare = (sql: string) => ({
    bind: (...args: unknown[]) => ({
      execute: () => execute(sql, args),
      first: async () => (execute(sql, args).results[0] ?? null),
      all: async () => execute(sql, args),
      run: async () => execute(sql, args),
    }),
  })
  const db = {
    prepare,
    batch: async (stmts: Array<{ execute: () => unknown }>) => stmts.map((s) => s.execute()),
  }
  return { db: db as unknown as D1Database, plans }
}

function seedChain(sqlite: DatabaseSync) {
  // root(1) > A(2) > B(3) > C(4)。B には REFERENCE の親 X(5) もある。ノイズとして多数の STRUCTURAL 関係を足す
  sqlite.exec(`INSERT INTO trees (id, name, owner_user_id) VALUES (900, 't', 1)`)
  const titles = ['root', 'A', 'B', 'C', 'X']
  titles.forEach((title, i) => {
    sqlite.prepare('INSERT INTO nodes (id, tree_id, title, public_id) VALUES (?, 900, ?, ?)').run(i + 1, title, `pid${i + 1}xx`)
  })
  const link = sqlite.prepare('INSERT INTO node_relations (parent_node_id, child_node_id, relation_type_id) VALUES (?, ?, ?)')
  link.run(1, 2, STRUCTURAL)
  link.run(2, 3, STRUCTURAL)
  link.run(3, 4, STRUCTURAL)
  link.run(1, 5, STRUCTURAL)
  link.run(5, 3, REFERENCE)
  for (let i = 100; i < 300; i += 1) {
    sqlite.prepare('INSERT INTO nodes (id, tree_id, title, public_id) VALUES (?, 900, ?, ?)').run(i, `n${i}`, `p${i}xxx`)
    link.run(1, i, STRUCTURAL)
  }
}

function plansTouchingSlowIndex(plans: Array<{ sql: string; details: string[] }>) {
  return plans.filter((p) => p.details.some((d) => d.includes(SLOW_INDEX)))
}

test.describe('node_relations を子ノードで引くクエリが relation_type のインデックスで全件を読まない', () => {
  test('getNodePathText: 祖先を辿る再帰と STRUCTURAL 親の確認が子ノードのインデックスを使う', async () => {
    const sqlite = createMigratedDb()
    seedChain(sqlite)
    const { db, plans } = createRecordingD1(sqlite)

    const path = await getNodePathText(db, 4)

    expect(path).toBe('root > A > B > C')
    expect(plans.length).toBeGreaterThan(0)
    expect(plansTouchingSlowIndex(plans)).toEqual([])
  })

  test('getNodePathText: STRUCTURAL 親が無いノードは全リレーションで経路を作る（従来どおり）', async () => {
    const sqlite = createMigratedDb()
    seedChain(sqlite)
    sqlite.prepare('INSERT INTO nodes (id, tree_id, title, public_id) VALUES (6, 900, ?, ?)').run('R', 'pid6xx')
    sqlite.prepare('INSERT INTO node_relations (parent_node_id, child_node_id, relation_type_id) VALUES (4, 6, ?)').run(REFERENCE)
    const { db, plans } = createRecordingD1(sqlite)

    const path = await getNodePathText(db, 6)

    expect(path).toBe('root > A > B > C > R')
    expect(plansTouchingSlowIndex(plans)).toEqual([])
  })

  test('setRelationType: STRUCTURAL への変更で他の STRUCTURAL 親を降格するクエリが子ノードのインデックスを使う', async () => {
    const sqlite = createMigratedDb()
    seedChain(sqlite)
    const { db, plans } = createRecordingD1(sqlite)

    const result = await setRelationType(db, 5, 3, STRUCTURAL)

    expect(result).toEqual({ status: 'updated', demotedParentIds: [2] })
    expect(plansTouchingSlowIndex(plans)).toEqual([])
  })
})

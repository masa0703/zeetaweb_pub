import { test, expect } from '@playwright/test'
import {
  generatePublicNodeId,
  isValidPublicNodeId,
  withPublicIdRetry,
  resolvePublicNodeId,
  resolvePublicNodeIds,
  encodeNodeIds,
} from '../src/utils/public-id'

const PUBLIC_ID_RE = /^[1-9A-HJ-NP-Za-km-z]{6}$/

test.describe('generatePublicNodeId', () => {
  test('6文字のbase58で、除外文字(0/O/I/l)を含まない', () => {
    for (let i = 0; i < 500; i++) {
      const id = generatePublicNodeId()
      expect(id).toHaveLength(6)
      expect(id).toMatch(PUBLIC_ID_RE)
      expect(id).not.toMatch(/[0OIl]/)
    }
  })

  test('十分にランダム（衝突が極めて少ない）', () => {
    const set = new Set<string>()
    const N = 2000
    for (let i = 0; i < N; i++) set.add(generatePublicNodeId())
    // 58^6 空間に対しN=2000ならほぼ衝突なし。安全側に緩め判定。
    expect(set.size).toBeGreaterThan(N - 5)
  })
})

test.describe('isValidPublicNodeId', () => {
  test('正しい公開IDを受理', () => {
    expect(isValidPublicNodeId('7Kd9mQ')).toBe(true)
    expect(isValidPublicNodeId(generatePublicNodeId())).toBe(true)
  })
  test('長さ違いを拒否', () => {
    expect(isValidPublicNodeId('7Kd9m')).toBe(false)
    expect(isValidPublicNodeId('7Kd9mQ1')).toBe(false)
    expect(isValidPublicNodeId('')).toBe(false)
  })
  test('base58に無い文字(0,O,I,l)を拒否', () => {
    expect(isValidPublicNodeId('0Kd9mQ')).toBe(false)
    expect(isValidPublicNodeId('OKd9mQ')).toBe(false)
    expect(isValidPublicNodeId('IKd9mQ')).toBe(false)
    expect(isValidPublicNodeId('lKd9mQ')).toBe(false)
  })
  test('整数や非文字列を拒否（列挙用の整数IDは通らない）', () => {
    expect(isValidPublicNodeId('204')).toBe(false)
    expect(isValidPublicNodeId(204 as unknown)).toBe(false)
    expect(isValidPublicNodeId(null)).toBe(false)
    expect(isValidPublicNodeId(undefined)).toBe(false)
  })
})

test.describe('withPublicIdRetry', () => {
  test('初回で成功すれば1回だけ呼ばれる', async () => {
    let calls = 0
    const result = await withPublicIdRetry(async (pid) => {
      calls++
      expect(pid).toMatch(PUBLIC_ID_RE)
      return { pid }
    })
    expect(calls).toBe(1)
    expect(result.pid).toMatch(PUBLIC_ID_RE)
  })

  test('UNIQUE制約違反ならID再生成してリトライ', async () => {
    let calls = 0
    const seen: string[] = []
    const result = await withPublicIdRetry(async (pid) => {
      calls++
      seen.push(pid)
      if (calls < 3) throw new Error('D1_ERROR: UNIQUE constraint failed: nodes.public_id')
      return pid
    })
    expect(calls).toBe(3)
    expect(new Set(seen).size).toBe(3) // 毎回新しいIDを生成
    expect(result).toMatch(PUBLIC_ID_RE)
  })

  test('UNIQUE以外のエラーは即座に再スロー（リトライしない）', async () => {
    let calls = 0
    await expect(
      withPublicIdRetry(async () => {
        calls++
        throw new Error('some other DB failure')
      })
    ).rejects.toThrow('some other DB failure')
    expect(calls).toBe(1)
  })

  test('maxTries超過で失敗', async () => {
    let calls = 0
    await expect(
      withPublicIdRetry(async () => {
        calls++
        throw new Error('UNIQUE constraint failed: nodes.public_id')
      }, 3)
    ).rejects.toThrow(/Failed to generate unique public_id after 3/)
    expect(calls).toBe(3)
  })
})

// ---- 最小のD1モック ----
function mockDb(handler: (sql: string, bindings: unknown[]) => any) {
  return {
    prepare(sql: string) {
      return {
        bind(...bindings: unknown[]) {
          const rows: any[] = handler(sql, bindings) ?? []
          return {
            first: async () => rows[0] ?? null,
            all: async () => ({ results: rows }),
          }
        },
      }
    },
  } as any
}

test.describe('resolve / encode (D1モック)', () => {
  test('resolvePublicNodeId: tree一致で内部idを返す', async () => {
    const db = mockDb((sql, b) => {
      expect(sql).toContain('WHERE public_id = ? AND tree_id = ?')
      const [pid, tid] = b
      if (pid === 'jP15UE' && tid === 24) return [{ id: 201 }]
      return []
    })
    expect(await resolvePublicNodeId(db, 24, 'jP15UE')).toBe(201)
    expect(await resolvePublicNodeId(db, 24, 'ffffff')).toBeNull()
  })

  test('resolvePublicNodeIds: 複数解決、空入力は空Map', async () => {
    const db = mockDb(() => [
      { id: 201, public_id: 'jP15UE' },
      { id: 204, public_id: 'LfVULF' },
    ])
    const map = await resolvePublicNodeIds(db, 24, ['jP15UE', 'LfVULF'])
    expect(map.get('jP15UE')).toBe(201)
    expect(map.get('LfVULF')).toBe(204)
    const empty = await resolvePublicNodeIds(db, 24, [])
    expect(empty.size).toBe(0)
  })

  test('encodeNodeIds: 内部id→公開ID、空入力は空Map', async () => {
    const db = mockDb(() => [
      { id: 201, public_id: 'jP15UE' },
      { id: 204, public_id: 'LfVULF' },
    ])
    const map = await encodeNodeIds(db, [201, 204])
    expect(map.get(201)).toBe('jP15UE')
    expect(map.get(204)).toBe('LfVULF')
    expect((await encodeNodeIds(db, [])).size).toBe(0)
  })
})

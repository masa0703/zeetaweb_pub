import { test, expect } from '@playwright/test'
import {
  splitIntoChunks,
  chunkVectorId,
  nodeIdFromVectorId,
  staleChunkIds,
  allChunkIdsForDelete,
  CHUNK_SIZE,
  CHUNK_OVERLAP,
  MAX_CHUNKS_PER_NODE,
} from '../src/utils/vector-chunk'

test.describe('splitIntoChunks', () => {
  test('空文字は [""]（タイトルのみノード）を返す', () => {
    expect(splitIntoChunks('')).toEqual([''])
    expect(splitIntoChunks(null)).toEqual([''])
    expect(splitIntoChunks(undefined)).toEqual([''])
  })

  test('CHUNK_SIZE 以下は 1 チャンク', () => {
    const short = 'a'.repeat(CHUNK_SIZE)
    expect(splitIntoChunks(short)).toEqual([short])
    expect(splitIntoChunks('a'.repeat(CHUNK_SIZE - 1))).toHaveLength(1)
  })

  test('長文はオーバーラップ付きで複数チャンクに分割', () => {
    const text = 'a'.repeat(CHUNK_SIZE * 3)
    const chunks = splitIntoChunks(text)
    expect(chunks.length).toBeGreaterThan(1)
    // 各チャンクは CHUNK_SIZE 以下
    for (const ch of chunks) expect(ch.length).toBeLessThanOrEqual(CHUNK_SIZE)
    // オーバーラップ: step = CHUNK_SIZE - CHUNK_OVERLAP ごとに開始
    const step = CHUNK_SIZE - CHUNK_OVERLAP
    expect(chunks[1]).toBe(text.slice(step, step + CHUNK_SIZE))
  })

  test('全文をカバーする（末尾が欠けない・MAX 未満のとき）', () => {
    const text = Array.from({ length: 2500 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('')
    const chunks = splitIntoChunks(text)
    // 先頭は必ず含まれる
    expect(text.startsWith(chunks[0])).toBeTruthy()
    // 末尾文字が最後のチャンクに含まれる
    expect(chunks[chunks.length - 1].endsWith(text[text.length - 1])).toBeTruthy()
  })

  test('MAX_CHUNKS_PER_NODE で打ち切る', () => {
    const huge = 'a'.repeat(CHUNK_SIZE * (MAX_CHUNKS_PER_NODE + 20))
    const chunks = splitIntoChunks(huge)
    expect(chunks.length).toBe(MAX_CHUNKS_PER_NODE)
  })
})

test.describe('chunkVectorId / nodeIdFromVectorId', () => {
  test('チャンクID往復', () => {
    expect(chunkVectorId(123, 0)).toBe('123#0')
    expect(chunkVectorId(4567, 12)).toBe('4567#12')
    expect(nodeIdFromVectorId('123#0')).toBe(123)
    expect(nodeIdFromVectorId('4567#12')).toBe(4567)
  })

  test('旧方式（チャンク化前の単一ID）も内部IDを取り出せる', () => {
    expect(nodeIdFromVectorId('123')).toBe(123)
  })

  test('解釈できないIDは NaN', () => {
    expect(Number.isNaN(nodeIdFromVectorId('abc#0'))).toBeTruthy()
  })
})

test.describe('staleChunkIds / allChunkIdsForDelete', () => {
  test('旧単一ID＋新チャンク数以降の古いチャンクを列挙', () => {
    const ids = staleChunkIds(123, 2)
    // 旧単一ID を含む
    expect(ids).toContain('123')
    // 生きているチャンク #0/#1 は含まない
    expect(ids).not.toContain('123#0')
    expect(ids).not.toContain('123#1')
    // #2 以降は掃除対象
    expect(ids).toContain('123#2')
    expect(ids).toContain(`123#${MAX_CHUNKS_PER_NODE - 1}`)
    // 上限を超えない
    expect(ids).not.toContain(`123#${MAX_CHUNKS_PER_NODE}`)
  })

  test('newChunkCount=0（全チャンク削除相当）は allChunkIdsForDelete と一致', () => {
    expect(staleChunkIds(99, 0)).toEqual(allChunkIdsForDelete(99))
    // 旧単一ID + #0..#(MAX-1)
    expect(allChunkIdsForDelete(99)).toHaveLength(MAX_CHUNKS_PER_NODE + 1)
    expect(allChunkIdsForDelete(99)[0]).toBe('99')
    expect(allChunkIdsForDelete(99)).toContain('99#0')
  })
})

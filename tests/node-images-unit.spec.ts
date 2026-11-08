import { test, expect } from '@playwright/test'
import { normalizeImageBaseName, stripNodeImageMarkdownReferences, validateImageMagicBytes } from '../src/utils/node-images'
import { validateNodeImage } from '../src/services/node-images'

const url = (id: number) => `/api/trees/1/nodes/Abc123/images/${id}/file`
const tag = (alt: string, id: number) => `![${alt}](${url(id)})`

test('画像ファイル名のベース名から属性注入に使える文字と制御文字を除去する', () => {
  expect(normalizeImageBaseName('x"< >\u0000\n y')).toBe('x y')
})

test.describe('stripNodeImageMarkdownReferences: 対象の画像タグだけを取り除く', () => {
  test('隣接した画像タグ（区切りなし）でも対象だけが消える', () => {
    expect(stripNodeImageMarkdownReferences(`${tag('a', 5)}${tag('b', 6)}`, url(5))).toBe(tag('b', 6))
    expect(stripNodeImageMarkdownReferences(`${tag('a', 6)}${tag('b', 5)}`, url(5))).toBe(tag('a', 6))
  })

  test('改行で近接した画像タグ: 対象の行だけが消え、空行は残らない', () => {
    const content = `${tag('a', 6)}\n${tag('b', 5)}\n${tag('c', 7)}`
    expect(stripNodeImageMarkdownReferences(content, url(5))).toBe(`${tag('a', 6)}\n${tag('c', 7)}`)
  })

  test('画像IDの前方一致（5 と 55）で巻き込まない', () => {
    expect(stripNodeImageMarkdownReferences(`${tag('a', 55)}${tag('b', 5)}`, url(5))).toBe(tag('a', 55))
    expect(stripNodeImageMarkdownReferences(`${tag('a', 5)}${tag('b', 55)}`, url(5))).toBe(tag('b', 55))
  })

  test('altにタイトルがあっても、前後のタグを巻き込まない', () => {
    expect(stripNodeImageMarkdownReferences(`![a](${url(5)} "title")${tag('b', 6)}`, url(5))).toBe(tag('b', 6))
  })

  test('直前のaltに [ や ! を含んでも巻き込まない', () => {
    expect(stripNodeImageMarkdownReferences(`![a [x ! y](${url(6)})${tag('b', 5)}`, url(5)))
      .toBe(`![a [x ! y](${url(6)})`)
  })

  test('同じ行の前に閉じていない ![ があっても、無関係なテキストを消さない', () => {
    expect(stripNodeImageMarkdownReferences(`前文 ![書きかけ ${tag('b', 5)} 後文`, url(5)))
      .toBe('前文 ![書きかけ  後文')
  })

  test('対象のファイル名に ] を含んでいても取り除ける', () => {
    expect(stripNodeImageMarkdownReferences(`${tag('img [1].png', 5)}\n${tag('b', 6)}`, url(5))).toBe(tag('b', 6))
  })

  test('文中のタグは、そのタグだけを取り除き前後の文字は触らない', () => {
    expect(stripNodeImageMarkdownReferences(`前 ${tag('a', 5)} 後`, url(5))).toBe('前  後')
  })

  test('同じ画像のタグが複数あれば、すべて取り除く', () => {
    expect(stripNodeImageMarkdownReferences(`${tag('a', 5)}\n本文\n${tag('a2', 5)}`, url(5))).toBe('本文')
  })

  test('画像だけの content は空文字になる', () => {
    expect(stripNodeImageMarkdownReferences(tag('a', 5), url(5))).toBe('')
  })

  test('最終行のタグを消しても、他の行（強制改行・連続する空行）は書き換えない', () => {
    const content = `行1  \n行2\n\n\n\n行3\n${tag('b', 5)}`
    expect(stripNodeImageMarkdownReferences(content, url(5))).toBe('行1  \n行2\n\n\n\n行3')
  })

  test('CRLF の content でもタグの行だけを消す', () => {
    expect(stripNodeImageMarkdownReferences(`${tag('a', 5)}\r\n${tag('b', 6)}`, url(5))).toBe(tag('b', 6))
  })

  test('対象のタグを含まない content は一切変更しない（行末空白・連続する空行も保持）', () => {
    const content = `abc  \n\n\n\ndef  \n${tag('b', 6)}  `
    expect(stripNodeImageMarkdownReferences(content, url(5))).toBe(content)
  })

  test('空・null・undefined は空文字を返す', () => {
    expect(stripNodeImageMarkdownReferences('', url(5))).toBe('')
    expect(stripNodeImageMarkdownReferences(null, url(5))).toBe('')
    expect(stripNodeImageMarkdownReferences(undefined, url(5))).toBe('')
  })
})

test.describe('画像の実体検査', () => {
  test('PNG のマジックバイトが申告 MIME と一致する', () => {
    expect(validateImageMagicBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png')).toBe(true)
    expect(validateImageMagicBytes(new Uint8Array([0x3c, 0x68, 0x74, 0x6d]), 'image/png')).toBe(false)
    expect(validateNodeImage(4, 'image/png', 'x.html', new Uint8Array([0x3c, 0x68, 0x74, 0x6d]))).toEqual({ ok: false, reason: 'invalid_content' })
  })
})

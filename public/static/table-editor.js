// table-editor.js — ByteMD テーブル編集ポップアップ v4

const TABLE_EDITOR_ICON_PATH = 'M6 6h36v36H6V6zM6 18h36M6 30h36M18 6v36'

// ============================================================
// テーブル検出
// ============================================================

function _isInsideCodeFence(wrapper, targetLine) {
  let count = 0
  for (let i = 0; i < targetLine; i++) {
    if (/^```/.test(wrapper.getLine(i).trim())) count++
  }
  return count % 2 !== 0
}

function detectTableAtCursor(wrapper, cursor) {
  const lineText = wrapper.getLine(cursor.line)
  if (!lineText.trim().startsWith('|')) return null
  if (_isInsideCodeFence(wrapper, cursor.line)) return null

  const total = wrapper.lineCount()
  let startLine = cursor.line
  while (startLine > 0 && wrapper.getLine(startLine - 1).trim().startsWith('|')) startLine--
  let endLine = cursor.line
  while (endLine < total - 1 && wrapper.getLine(endLine + 1).trim().startsWith('|')) endLine++

  let hasSep = false
  for (let i = startLine; i <= endLine; i++) {
    const cells = wrapper.getLine(i).replace(/^\s*\|/, '').replace(/\|\s*$/, '').split(/(?<!\\)\|/)
    if (cells.length > 0 && cells.every(c => /^\s*:?-+:?\s*$/.test(c))) { hasSep = true; break }
  }
  return hasSep ? { startLine, endLine } : null
}

// ============================================================
// テーブルパース / 生成
// ============================================================

function _splitLine(line) {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split(/(?<!\\)\|/).map(c => c.trim())
}

function parseMarkdownTable(lines) {
  // 区切り行の判定: 全セルが :?-+:? のみで構成されている行
  // （空列を持つヘッダ行と誤認しないよう、各セルに最低1つの - を要求）
  const _isSepLine = (line) => {
    const cells = _splitLine(line)
    return cells.length > 0 && cells.every(c => /^\s*:?-+:?\s*$/.test(c))
  }

  let sepIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (_isSepLine(lines[i])) { sepIdx = i; break }
  }
  if (sepIdx < 0) return null

  const headers = _splitLine(lines[Math.max(0, sepIdx - 1)])
  const numCols = headers.length

  const alignments = _splitLine(lines[sepIdx]).map(cell => {
    if (cell.startsWith(':') && cell.endsWith(':')) return 'center'
    if (cell.endsWith(':')) return 'right'
    return 'left'
  })
  while (alignments.length < numCols) alignments.push('left')

  const rows = []
  for (let i = sepIdx + 1; i < lines.length; i++) {
    const cells = _splitLine(lines[i])
    while (cells.length < numCols) cells.push('')
    rows.push(cells.slice(0, numCols))
  }
  if (rows.length === 0) rows.push(new Array(numCols).fill(''))

  return { headers, alignments, rows }
}

function generateMarkdownTable(headers, alignments, rows) {
  const colWidths = headers.map((h, i) => {
    let max = Math.max(3, h.length)
    for (const row of rows) max = Math.max(max, (row[i] || '').length)
    return max
  })
  const pad = (text, w) => text + ' '.repeat(Math.max(0, w - text.length))

  const headerRow = '| ' + headers.map((h, i) => pad(h, colWidths[i])).join(' | ') + ' |'
  const sepRow = '| ' + alignments.map((a, i) => {
    const w = colWidths[i]
    if (a === 'center') return ':' + '-'.repeat(Math.max(1, w - 2)) + ':'
    if (a === 'right')  return '-'.repeat(Math.max(1, w - 1)) + ':'
    return ':' + '-'.repeat(Math.max(2, w - 1))
  }).join(' | ') + ' |'
  const dataRows = rows.map(row =>
    '| ' + headers.map((_, i) => pad(row[i] || '', colWidths[i])).join(' | ') + ' |'
  )
  return [headerRow, sepRow, ...dataRows].join('\n')
}

// ============================================================
// スタイル（初回のみ注入）
// ============================================================

function _ensureTableEditorStyles() {
  if (document.getElementById('table-editor-styles')) return
  const style = document.createElement('style')
  style.id = 'table-editor-styles'
  style.textContent = `
    #te-overlay {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.45);
      z-index: 100000;
      display: flex; align-items: center; justify-content: center;
      padding: 16px; box-sizing: border-box;
    }
    #te-modal {
      background: #fff;
      border-radius: 8px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.25);
      width: min(860px, calc(100vw - 32px));
      height: min(88vh, 700px);
      min-width: 420px; min-height: 280px;
      display: flex; flex-direction: column;
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px;
      resize: both;
    }
    #te-modal .te-head {
      padding: 10px 14px;
      border-bottom: 1px solid #e5e7eb;
      display: flex; align-items: center; justify-content: space-between;
      flex-shrink: 0; cursor: default;
    }
    #te-modal .te-head h3 { margin: 0; font-size: 14px; font-weight: 600; color: #111827; }
    #te-modal .te-close-btn {
      background: none; border: none; cursor: pointer;
      font-size: 15px; color: #6b7280; padding: 4px 8px; border-radius: 4px; line-height: 1;
    }
    #te-modal .te-close-btn:hover { background: #f3f4f6; }
    #te-modal .te-body { flex: 1; overflow: auto; padding: 10px 14px; min-height: 0; }
    #te-modal .te-grid-scroll { overflow: auto; }
    #te-modal table.te-grid {
      border-collapse: collapse; width: max-content; min-width: 100%;
    }
    #te-modal .te-grid tr.te-align-row th {
      border: none; background: transparent; padding: 3px 2px 2px; vertical-align: middle;
    }
    #te-modal .te-align-btn {
      padding: 2px 5px; font-size: 11px; cursor: pointer;
      border: 1px solid #d1d5db; border-radius: 3px; background: #f9fafb;
      color: #6b7280; margin: 1px; line-height: 1.4;
    }
    #te-modal .te-align-btn.active { background: #2563eb; color: #fff; border-color: #2563eb; }
    #te-modal .te-align-btn:hover:not(.active) { background: #e5e7eb; }
    #te-modal .te-grid th, #te-modal .te-grid td {
      border: 1px solid #d1d5db; padding: 0; vertical-align: middle;
    }
    #te-modal .te-grid thead tr.te-header-row th { background: #fef9c3; }
    #te-modal .te-grid tbody td { background: #fff; }
    #te-modal .te-grid th.te-selected, #te-modal .te-grid td.te-selected {
      background: #dbeafe !important;
    }
    #te-modal .te-grid th.te-cursor, #te-modal .te-grid td.te-cursor {
      background: #bfdbfe !important; outline: 2px solid #2563eb; outline-offset: -2px;
    }
    #te-modal .te-rn {
      font-size: 11px; color: #9ca3af; text-align: center; width: 24px; min-width: 24px;
      user-select: none; background: #f9fafb !important; border: 1px solid #e5e7eb !important;
      padding: 0 2px;
    }
    #te-modal .te-grid input {
      border: none; outline: none; padding: 5px 6px;
      font-size: 13px; background: transparent; min-width: 60px;
      box-sizing: content-box; font-family: inherit; display: block;
    }
    #te-modal .te-foot {
      padding: 8px 14px; border-top: 1px solid #e5e7eb;
      display: flex; gap: 4px; flex-wrap: wrap; align-items: center;
      flex-shrink: 0; background: #f9fafb;
    }
    #te-modal .te-btn {
      padding: 5px 10px; font-size: 12px; border-radius: 4px;
      border: 1px solid #d1d5db; cursor: pointer; background: #fff;
      color: #374151; white-space: nowrap; font-family: inherit; line-height: 1.4;
    }
    #te-modal .te-btn:hover { background: #f3f4f6; }
    #te-modal .te-btn.primary { background: #2563eb; color: #fff; border-color: #2563eb; }
    #te-modal .te-btn.primary:hover { background: #1d4ed8; }
    #te-modal .te-btn.danger { color: #dc2626; border-color: #fca5a5; }
    #te-modal .te-btn.danger:hover { background: #fef2f2; }
    #te-modal .te-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    #te-modal .te-divider {
      width: 1px; height: 22px; background: #e5e7eb; margin: 0 2px; flex-shrink: 0;
    }
    #te-modal .te-spacer { flex: 1; }
    #te-modal .te-sum-hint {
      font-size: 12px; color: #374151; padding: 0 8px; font-variant-numeric: tabular-nums;
    }
    #te-modal .te-sum-hint .te-sum-label { color: #9ca3af; margin-right: 4px; }
    #te-modal .te-sum-hint .te-sum-value { font-weight: 600; }
    /* ダークテーマ上書き */
    html.theme-dark #te-modal { background: #1f2937; color: #e5e7eb; }
    html.theme-dark #te-modal .te-head { border-bottom-color: #374151; }
    html.theme-dark #te-modal .te-head h3 { color: #f3f4f6; }
    html.theme-dark #te-modal .te-close-btn { color: #9ca3af; }
    html.theme-dark #te-modal .te-close-btn:hover { background: #111827; }
    html.theme-dark #te-modal .te-align-btn {
      border-color: #4b5563; background: #111827; color: #9ca3af;
    }
    html.theme-dark #te-modal .te-align-btn:hover:not(.active) { background: #374151; }
    html.theme-dark #te-modal .te-grid th,
    html.theme-dark #te-modal .te-grid td { border-color: #374151; }
    html.theme-dark #te-modal .te-grid thead tr.te-header-row th { background: rgba(251, 191, 36, 0.18); }
    html.theme-dark #te-modal .te-grid tbody td { background: #1f2937; }
    html.theme-dark #te-modal .te-grid th.te-selected,
    html.theme-dark #te-modal .te-grid td.te-selected {
      background: rgba(59, 130, 246, 0.25) !important;
    }
    html.theme-dark #te-modal .te-grid th.te-cursor,
    html.theme-dark #te-modal .te-grid td.te-cursor {
      background: rgba(59, 130, 246, 0.4) !important;
    }
    html.theme-dark #te-modal .te-rn {
      background: #111827 !important; border-color: #374151 !important;
    }
    html.theme-dark #te-modal .te-foot { border-top-color: #374151; background: #111827; }
    html.theme-dark #te-modal .te-btn {
      border-color: #4b5563; background: #1f2937; color: #e5e7eb;
    }
    html.theme-dark #te-modal .te-btn:hover { background: #374151; }
    html.theme-dark #te-modal .te-btn.danger { color: #fca5a5; border-color: rgba(252, 165, 165, 0.45); }
    html.theme-dark #te-modal .te-btn.danger:hover { background: rgba(248, 113, 113, 0.16); }
    html.theme-dark #te-modal .te-divider { background: #374151; }
    html.theme-dark #te-modal .te-sum-hint { color: #e5e7eb; }
  `
  document.head.appendChild(style)
}

// ============================================================
// モーダルUI
// ============================================================

function showTableEditorModal(wrapper, tableData, insertCursor, tableInfo) {
  const existing = document.getElementById('te-overlay')
  if (existing) existing.remove()
  _ensureTableEditorStyles()

  const isNew = !tableData
  let headers    = isNew ? [1, 2, 3].map(n => t('tableEditor.columnName', { n })) : [...tableData.headers]
  let alignments = isNew ? ['left', 'left', 'left'] : [...tableData.alignments]
  let rows       = isNew ? [['', '', '']] : tableData.rows.map(r => [...r])

  // 選択状態 (row=-1 = ヘッダ行)
  let sel = { anchor: null, focus: null }

  // ドラッグ選択用フラグ
  let _isDragging = false
  // Shift+click 時に focus イベントで anchor をリセットしないためのフラグ
  let _shiftPending = false

  // undo 用スナップショット履歴（構造変更前に保存）
  const _history = []
  const _saveHistory = () => {
    _history.push({
      headers: [...headers],
      alignments: [...alignments],
      rows: rows.map(r => [...r]),
    })
    if (_history.length > 50) _history.shift()
  }
  const _undo = () => {
    if (_history.length === 0) return
    const prev = _history.pop()
    headers    = prev.headers
    alignments = prev.alignments
    rows       = prev.rows
    sel = { anchor: null, focus: null }
    renderGrid()
  }

  const getSelRange = () => {
    if (!sel.anchor || !sel.focus) return null
    return {
      minRow: Math.min(sel.anchor.row, sel.focus.row),
      maxRow: Math.max(sel.anchor.row, sel.focus.row),
      minCol: Math.min(sel.anchor.col, sel.focus.col),
      maxCol: Math.max(sel.anchor.col, sel.focus.col),
    }
  }

  const isCellSelected = (row, col) => {
    const r = getSelRange()
    return r ? (row >= r.minRow && row <= r.maxRow && col >= r.minCol && col <= r.maxCol) : false
  }

  const isCursorCell = (row, col) =>
    sel.focus && sel.focus.row === row && sel.focus.col === col

  // --- overlay / modal ---
  const overlay = document.createElement('div')
  overlay.id = 'te-overlay'

  let _onKeydown, _onMouseup

  const closeModal = () => {
    overlay.remove()
    document.removeEventListener('keydown', _onKeydown)
    document.removeEventListener('mouseup', _onMouseup)
  }

  _onKeydown = (e) => { if (e.key === 'Escape') closeModal() }
  document.addEventListener('keydown', _onKeydown)

  _onMouseup = () => {
    if (_isDragging) {
      _isDragging = false
      scroll.style.userSelect = ''
    }
  }
  document.addEventListener('mouseup', _onMouseup)

  // オーバーレイ外クリックでは閉じない（✕ボタン・ESCキーのみ）

  const modal = document.createElement('div')
  modal.id = 'te-modal'

  // ヘッダー
  const head = document.createElement('div')
  head.className = 'te-head'
  const titleEl = document.createElement('h3')
  titleEl.textContent = isNew ? t('tableEditor.newTable') : t('tableEditor.editTable')
  const closeBtn = document.createElement('button')
  closeBtn.className = 'te-close-btn'
  closeBtn.type = 'button'
  closeBtn.textContent = '✕'
  closeBtn.title = t('tableEditor.close')
  closeBtn.addEventListener('click', closeModal)
  head.append(titleEl, closeBtn)

  // ボディ
  const body = document.createElement('div')
  body.className = 'te-body'
  const scroll = document.createElement('div')
  scroll.className = 'te-grid-scroll'
  body.appendChild(scroll)

  // ドラッグ選択: mouseover で scroll 内のセル変化を検出
  // ※ TD/TH に data-te-row/col を付けているので input の外側でも拾える
  scroll.addEventListener('mouseover', (ev) => {
    if (!_isDragging) return
    const cell = ev.target.closest('[data-te-cell]')
    if (!cell) return
    const row = cell.dataset.teCell === 'header' ? -1 : parseInt(cell.dataset.teRow)
    const col = parseInt(cell.dataset.teCol)
    if (isNaN(col)) return
    if (sel.focus && sel.focus.row === row && sel.focus.col === col) return
    sel.focus = { row, col }
    updateSelectionUI()
  })

  // フッター
  const foot = document.createElement('div')
  foot.className = 'te-foot'

  // --- input の幅を内容に合わせて自動調整 ---
  const sizeInput = (inp) => {
    inp.style.width = '0'
    inp.style.width = Math.max(60, inp.scrollWidth) + 'px'
  }

  // --- フォーカス移動（input 専用属性 data-cell で確実にターゲット）---
  const focusCell = (row, col) => {
    if (row === -1) {
      scroll.querySelector(`input[data-cell="header"][data-col="${col}"]`)?.focus()
    } else if (row >= 0 && row < rows.length) {
      scroll.querySelector(`input[data-cell="data"][data-row="${row}"][data-col="${col}"]`)?.focus()
    }
  }

  // --- キーボード（IME対応: isComposing 中は無視） ---
  const handleKey = (e, row, col) => {
    if (e.isComposing || e.keyCode === 229) return
    const numCols = headers.length
    if (e.key === 'Tab') {
      e.preventDefault()
      let nr = row, nc = col
      if (e.shiftKey) { nc--; if (nc < 0) { nc = numCols - 1; nr-- } }
      else            { nc++; if (nc >= numCols) { nc = 0; nr++ } }
      focusCell(nr, nc)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      focusCell(row + 1, col)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault(); focusCell(row + 1, col)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault(); focusCell(row - 1, col)
    } else if (e.key === 'Escape') {
      closeModal()
    }
  }

  // --- グリッド再描画 ---
  const renderGrid = (focusAfter) => {
    scroll.innerHTML = ''
    const numCols = headers.length

    const table = document.createElement('table')
    table.className = 'te-grid'
    const thead = document.createElement('thead')

    // アライメント行
    const alignRow = document.createElement('tr')
    alignRow.className = 'te-align-row'
    const alignRn = document.createElement('th')
    alignRn.className = 'te-rn'
    alignRow.appendChild(alignRn)
    for (let c = 0; c < numCols; c++) {
      const th = document.createElement('th')
      ;['left', 'center', 'right'].forEach(a => {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'te-align-btn' + (alignments[c] === a ? ' active' : '')
        btn.title = {
          left: t('tableEditor.alignLeft'),
          center: t('tableEditor.alignCenter'),
          right: t('tableEditor.alignRight')
        }[a]
        btn.textContent = { left: '⬅', center: '⬌', right: '➡' }[a]
        const cc = c, ca = a
        btn.addEventListener('click', () => { alignments[cc] = ca; renderGrid({ row: -1, col: cc }) })
        th.appendChild(btn)
      })
      alignRow.appendChild(th)
    }
    thead.appendChild(alignRow)

    // ヘッダ行
    const headerRow = document.createElement('tr')
    headerRow.className = 'te-header-row'
    const hRn = document.createElement('th')
    hRn.className = 'te-rn'
    hRn.textContent = '#'
    headerRow.appendChild(hRn)
    for (let c = 0; c < numCols; c++) {
      const th = document.createElement('th')
      // ドラッグ検出用: TH 自体に data-te-* を付与（input の外側でも検出できるように）
      th.dataset.teCell = 'header'
      th.dataset.teCol  = c
      if (isCursorCell(-1, c)) th.classList.add('te-cursor')
      else if (isCellSelected(-1, c)) th.classList.add('te-selected')

      const inp = document.createElement('input')
      inp.type = 'text'
      inp.value = headers[c]
      inp.placeholder = t('tableEditor.columnName', { n: c + 1 })
      // フォーカス移動用: input 専用に data-cell / data-col を付与
      inp.dataset.cell = 'header'
      inp.dataset.col  = c

      const cc = c
      inp.addEventListener('input', () => { headers[cc] = inp.value; sizeInput(inp) })
      inp.addEventListener('keydown', (ev) => handleKey(ev, -1, cc))
      inp.addEventListener('mousedown', (ev) => {
        if (ev.button !== 0) return
        if (ev.shiftKey && sel.anchor) {
          // Shift+click: anchor を維持したまま focus だけ動かす
          ev.preventDefault()
          _shiftPending = true
          sel.focus = { row: -1, col: cc }
          updateSelectionUI()
          inp.focus()
        } else {
          // 通常クリック: ドラッグ開始（anchor/focus は focus イベントで設定）
          _isDragging = true
          scroll.style.userSelect = 'none'
        }
      })
      inp.addEventListener('focus', () => {
        if (_shiftPending) { _shiftPending = false; return }
        // 通常クリック・Tab・キーボード移動: 常に anchor/focus をリセット
        sel.anchor = { row: -1, col: cc }
        sel.focus  = { row: -1, col: cc }
        updateSelectionUI()
      })
      inp.addEventListener('paste', (ev) => handlePaste(ev, -1, cc))
      th.appendChild(inp)
      headerRow.appendChild(th)
    }
    thead.appendChild(headerRow)
    table.appendChild(thead)

    // データ行
    const tbody = document.createElement('tbody')
    for (let r = 0; r < rows.length; r++) {
      const tr = document.createElement('tr')
      const rn = document.createElement('td')
      rn.className = 'te-rn'
      rn.textContent = r + 1
      tr.appendChild(rn)
      for (let c = 0; c < numCols; c++) {
        const td = document.createElement('td')
        // ドラッグ検出用: TD 自体に data-te-* を付与
        td.dataset.teCell = 'data'
        td.dataset.teRow  = r
        td.dataset.teCol  = c
        if (isCursorCell(r, c)) td.classList.add('te-cursor')
        else if (isCellSelected(r, c)) td.classList.add('te-selected')

        const inp = document.createElement('input')
        inp.type = 'text'
        inp.value = rows[r][c] || ''
        // フォーカス移動用: input 専用に data-cell / data-row / data-col を付与
        inp.dataset.cell = 'data'
        inp.dataset.row  = r
        inp.dataset.col  = c

        const cr = r, cc = c
        inp.addEventListener('input', () => { rows[cr][cc] = inp.value; sizeInput(inp) })
        inp.addEventListener('keydown', (ev) => handleKey(ev, cr, cc))
        inp.addEventListener('mousedown', (ev) => {
          if (ev.button !== 0) return
          if (ev.shiftKey && sel.anchor) {
            ev.preventDefault()
            _shiftPending = true
            sel.focus = { row: cr, col: cc }
            updateSelectionUI()
            inp.focus()
          } else {
            _isDragging = true
            scroll.style.userSelect = 'none'
          }
        })
        inp.addEventListener('focus', () => {
          if (_shiftPending) { _shiftPending = false; return }
          sel.anchor = { row: cr, col: cc }
          sel.focus  = { row: cr, col: cc }
          updateSelectionUI()
        })
        inp.addEventListener('paste', (ev) => handlePaste(ev, cr, cc))
        td.appendChild(inp)
        tr.appendChild(td)
      }
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)
    scroll.appendChild(table)

    // 全 input の幅を内容に合わせて初期設定
    table.querySelectorAll('input').forEach(sizeInput)

    if (focusAfter) setTimeout(() => focusCell(focusAfter.row, focusAfter.col), 0)
  }

  // 選択ハイライトのみ更新（再描画なし）
  const updateSelectionUI = () => {
    const table = scroll.querySelector('table.te-grid')
    if (!table) return
    table.querySelectorAll('thead tr.te-header-row th:not(.te-rn)').forEach((th, c) => {
      th.classList.toggle('te-cursor', isCursorCell(-1, c))
      th.classList.toggle('te-selected', !isCursorCell(-1, c) && isCellSelected(-1, c))
    })
    table.querySelectorAll('tbody tr').forEach((tr, r) => {
      tr.querySelectorAll('td:not(.te-rn)').forEach((td, c) => {
        td.classList.toggle('te-cursor', isCursorCell(r, c))
        td.classList.toggle('te-selected', !isCursorCell(r, c) && isCellSelected(r, c))
      })
    })
    updateFooterBtns()
  }

  // --- ペースト（Excel / Spreadsheet TSV対応・クォート内改行対応） ---
  // ダブルクォートで囲まれたフィールド内のタブ・改行を正しく1セルとして扱う
  const _parseTSV = (text) => {
    const result = []
    let row = []
    let cell = ''
    let inQuote = false
    let i = 0
    while (i < text.length) {
      const ch = text[i]
      if (inQuote) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cell += '"'; i += 2 }  // "" → エスケープされた "
          else { inQuote = false; i++ }                      // 閉じクォート
        } else { cell += ch; i++ }
      } else {
        if (ch === '"' && cell === '') { inQuote = true; i++ }
        else if (ch === '\t') { row.push(cell); cell = ''; i++ }
        else if (ch === '\r') {
          row.push(cell); result.push(row); row = []; cell = ''
          if (text[i + 1] === '\n') i += 2; else i++
        } else if (ch === '\n') { row.push(cell); result.push(row); row = []; cell = ''; i++ }
        else { cell += ch; i++ }
      }
    }
    if (row.length > 0 || cell !== '') { row.push(cell); result.push(row) }
    // Excel が末尾に付ける空行を除去
    if (result.length > 1) {
      const last = result[result.length - 1]
      if (last.length === 1 && last[0] === '') result.pop()
    }
    return result
  }

  const handlePaste = (e, row, col) => {
    const text = e.clipboardData?.getData('text/plain') || ''
    if (!text.includes('\t') && !text.includes('\n')) return
    const pasteRows = _parseTSV(text)
    // 単一セルならブラウザ標準ペーストに任せる
    if (pasteRows.length === 1 && pasteRows[0].length === 1) return
    e.preventDefault()
    _saveHistory()
    const numPasteRows = pasteRows.length
    const numPasteCols = Math.max(...pasteRows.map(r => r.length))
    while (rows.length < row + numPasteRows) rows.push(new Array(headers.length).fill(''))
    while (headers.length < col + numPasteCols) {
      headers.push(t('tableEditor.columnName', { n: headers.length + 1 }))
      alignments.push('left')
      rows.forEach(r => r.push(''))
    }
    // セル内改行を </br> に変換してから格納
    const normCell = (v) => v.replace(/\r\n|\r|\n/g, '</br>')
    for (let pr = 0; pr < pasteRows.length; pr++) {
      const targetRow = row + pr
      if (targetRow === -1) {
        for (let pc = 0; pc < pasteRows[pr].length; pc++) {
          if (col + pc < headers.length) headers[col + pc] = normCell(pasteRows[pr][pc])
        }
      } else if (targetRow < rows.length) {
        for (let pc = 0; pc < pasteRows[pr].length; pc++) {
          if (col + pc < headers.length) rows[targetRow][col + pc] = normCell(pasteRows[pr][pc])
        }
      }
    }
    renderGrid({ row, col })
  }

  // --- コピー（Cmd/Ctrl+C）& Undo（Cmd/Ctrl+Z） ---
  const _onModalKeydown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
      e.preventDefault()
      _undo()
      return
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
      const range = getSelRange()
      if (!range) return
      const lines = []
      for (let r = range.minRow; r <= range.maxRow; r++) {
        const cells = []
        for (let c = range.minCol; c <= range.maxCol; c++) {
          // コピー時は </br> を改行に戻し、改行を含むセルはダブルクォートで囲む
          const v = r === -1 ? (headers[c] || '') : (rows[r]?.[c] || '')
          const converted = v.replace(/<\/br>/g, '\n')
          cells.push(converted.includes('\n')
            ? `"${converted.replace(/"/g, '""')}"` : converted)
        }
        lines.push(cells.join('\t'))
      }
      navigator.clipboard?.writeText(lines.join('\n')).catch(() => {})
    }
  }
  modal.addEventListener('keydown', _onModalKeydown)

  // --- フッターボタン ---
  const mkBtn = (text, cls, onClick, title) => {
    const btn = document.createElement('button')
    btn.type = 'button'; btn.textContent = text
    btn.className = 'te-btn' + (cls ? ' ' + cls : '')
    if (title) btn.title = title
    btn.addEventListener('click', onClick)
    return btn
  }
  const mkDiv = (cls) => Object.assign(document.createElement('div'), { className: cls })

  const btnRowAbove = mkBtn('↑行+', '', () => {
    _saveHistory()
    const r = getSelRange()
    const target = (r && r.minRow >= 0) ? r.minRow : 0
    rows.splice(target, 0, new Array(headers.length).fill(''))
    sel = { anchor: { row: target, col: r?.minCol ?? 0 }, focus: { row: target, col: r?.minCol ?? 0 } }
    renderGrid({ row: target, col: r?.minCol ?? 0 })
  }, t('tableEditor.addRowAbove'))

  const btnRowBelow = mkBtn('↓行+', '', () => {
    _saveHistory()
    const r = getSelRange()
    const target = (r && r.maxRow >= 0) ? r.maxRow : rows.length - 1
    rows.splice(target + 1, 0, new Array(headers.length).fill(''))
    sel = { anchor: { row: target + 1, col: r?.minCol ?? 0 }, focus: { row: target + 1, col: r?.minCol ?? 0 } }
    renderGrid({ row: target + 1, col: r?.minCol ?? 0 })
  }, t('tableEditor.addRowBelow'))

  const btnRowDel = mkBtn('行-', 'danger', () => {
    const r = getSelRange()
    if (!r || r.minRow < 0) return
    _saveHistory()
    for (let i = r.maxRow; i >= r.minRow; i--) rows.splice(i, 1)
    if (rows.length === 0) rows.push(new Array(headers.length).fill(''))
    sel = { anchor: null, focus: null }
    renderGrid({ row: Math.min(r.minRow, rows.length - 1), col: r.minCol })
  }, t('tableEditor.deleteRows'))

  const btnColLeft = mkBtn('←列+', '', () => {
    _saveHistory()
    const r = getSelRange()
    const target = r?.minCol ?? 0
    headers.splice(target, 0, t('tableEditor.columnName', { n: target + 1 }))
    alignments.splice(target, 0, 'left')
    rows.forEach(row => row.splice(target, 0, ''))
    sel = { anchor: { row: r?.minRow ?? -1, col: target }, focus: { row: r?.minRow ?? -1, col: target } }
    renderGrid({ row: r?.minRow ?? -1, col: target })
  }, t('tableEditor.addColumnLeft'))

  const btnColRight = mkBtn('→列+', '', () => {
    _saveHistory()
    const r = getSelRange()
    const target = r?.maxCol ?? (headers.length - 1)
    headers.splice(target + 1, 0, t('tableEditor.columnName', { n: target + 2 }))
    alignments.splice(target + 1, 0, 'left')
    rows.forEach(row => row.splice(target + 1, 0, ''))
    sel = { anchor: { row: r?.minRow ?? -1, col: target + 1 }, focus: { row: r?.minRow ?? -1, col: target + 1 } }
    renderGrid({ row: r?.minRow ?? -1, col: target + 1 })
  }, t('tableEditor.addColumnRight'))

  const btnColDel = mkBtn('列-', 'danger', () => {
    const r = getSelRange()
    if (!r || headers.length <= 1) return
    _saveHistory()
    for (let c = r.maxCol; c >= r.minCol; c--) {
      headers.splice(c, 1); alignments.splice(c, 1)
      rows.forEach(row => row.splice(c, 1))
    }
    sel = { anchor: null, focus: null }
    renderGrid({ row: r.minRow, col: Math.min(r.minCol, headers.length - 1) })
  }, t('tableEditor.deleteColumns'))

  const sumHint = mkDiv('te-sum-hint')

  // 範囲内のセルから数値だけを取り出して合計する。
  // カンマを除去したうえで最初の数値トークン（小数・マイナス対応）を抽出するため、
  // 「¥1,850,000」「1980円」「20%」「**¥1,775,000**」などはすべて数値部分が対象になる。
  // 数字を含まないセル（「JP PM」など）は無視する。
  const parseNumericCell = (raw) => {
    const s = String(raw ?? '').replace(/,/g, '')
    const m = s.match(/-?\d+(?:\.\d+)?/)
    if (!m) return null
    const n = Number(m[0])
    return Number.isFinite(n) ? n : null
  }

  const updateSumHint = () => {
    const r = getSelRange()
    const isMultiCell = r && (r.maxRow > r.minRow || r.maxCol > r.minCol)
    if (!isMultiCell) { sumHint.replaceChildren(); return }

    let sum = 0
    let count = 0
    for (let row = r.minRow; row <= r.maxRow; row++) {
      for (let col = r.minCol; col <= r.maxCol; col++) {
        const raw = row === -1 ? headers[col] : rows[row]?.[col]
        const n = parseNumericCell(raw)
        if (n !== null) { sum += n; count++ }
      }
    }
    if (count === 0) { sumHint.replaceChildren(); return }

    const label = Object.assign(document.createElement('span'), {
      className: 'te-sum-label', textContent: t('tableEditor.total'),
    })
    const value = Object.assign(document.createElement('span'), {
      className: 'te-sum-value', textContent: sum.toLocaleString(),
    })
    sumHint.replaceChildren(label, value)
  }

  const updateFooterBtns = () => {
    const r = getSelRange()
    const hasDataSel = r && r.minRow >= 0
    const hasColSel  = r !== null
    btnRowDel.disabled = !hasDataSel
    btnColDel.disabled = !hasColSel || headers.length <= 1
    updateSumHint()
  }

  foot.append(
    btnRowAbove, btnRowBelow, btnRowDel,
    mkDiv('te-divider'),
    btnColLeft, btnColRight, btnColDel,
    mkDiv('te-spacer'),
    sumHint,
    mkBtn(t('common.cancel'), '', closeModal),
    mkBtn(t('common.save'), 'primary', () => {
      const md = generateMarkdownTable(headers, alignments, rows)
      if (tableInfo) {
        const endLineText = wrapper.getLine(tableInfo.endLine)
        wrapper.replaceRange(md,
          { line: tableInfo.startLine, ch: 0 },
          { line: tableInfo.endLine, ch: endLineText.length }
        )
      } else {
        const cur = insertCursor || wrapper.getCursor()
        const lineText = wrapper.getLine(cur.line) || ''
        let insertText = md
        if (cur.ch > 0) insertText = '\n' + insertText
        if (cur.ch < lineText.length) insertText = insertText + '\n'
        wrapper.replaceRange(insertText, cur, cur)
      }
      closeModal()
    })
  )
  updateFooterBtns()

  modal.append(head, body, foot)
  overlay.appendChild(modal)
  document.body.appendChild(overlay)

  renderGrid()
  setTimeout(() => focusCell(-1, 0), 50)
}

// ============================================================
// 公開エントリーポイント
// ============================================================

function openTableEditorFromCurrentSelection() {
  const wrapper = window.currentEditor
  if (!wrapper) return
  const cursor = wrapper.getCursor()
  const info = detectTableAtCursor(wrapper, cursor)
  if (info) {
    const lines = []
    for (let i = info.startLine; i <= info.endLine; i++) lines.push(wrapper.getLine(i))
    const tableData = parseMarkdownTable(lines)
    showTableEditorModal(wrapper, tableData, null, info)
  } else {
    showTableEditorModal(wrapper, null, cursor, null)
  }
}

// ============================================================
// ByteMD プラグイン
// ============================================================

function tableEditorPlugin() {
  const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="${TABLE_EDITOR_ICON_PATH}"/></svg>`
  return {
    actions: [{
      title: t('tableEditor.editTable'),
      icon,
      handler: {
        type: 'action',
        click() { openTableEditorFromCurrentSelection() }
      }
    }]
  }
}

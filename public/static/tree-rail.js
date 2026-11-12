/**
 * 左バー（ツリー切替・管理）とヘッダーのアカウント操作。
 * 旧マイページ（my-page.js）の機能を編集画面へ集約したもの。
 *
 * app.js から呼ばれる窓口は window.ZeetaTreeRail。
 * モーダル内の onclick/onsubmit から呼ばれる関数だけをグローバルに公開する。
 */
(function () {
  const LAST_ACCESSED_STORAGE_KEY = 'zeeta:last-accessed-trees'
  // ツリー切替の直前に一覧を一時保存し、次のページで読み込み途中に左バーを即描画する。
  // 新しいページの最初の描画にアイコンが揃っていないと、並び替えのアニメーションが付かない
  const RAIL_CACHE_STORAGE_KEY = 'zeeta:tree-rail-cache'
  // 丸アイコンの背景色。trees.color にはキー名を保存する（サーバー側 TREE_COLOR_KEYS と同じ並び・キー）。
  // 未設定のツリーはツリーIDから自動で1色を割り当てる
  const CHIP_COLORS = [
    ['indigo', '#6366f1'],
    ['sky', '#0ea5e9'],
    ['emerald', '#10b981'],
    ['amber', '#f59e0b'],
    ['red', '#ef4444'],
    ['violet', '#8b5cf6'],
    ['white', '#ffffff'],
    ['pink', '#ec4899']
  ]
  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  const DRAWER_WIDTH_STORAGE_KEY = 'zeeta:tree-drawer-width'
  const DRAWER_MIN_WIDTH = 220
  const DRAWER_MAX_WIDTH = 480
  const DRAWER_MAX_VIEWPORT_RATIO = 0.8
  const DRAWER_KEY_STEP = 16
  // ツリーアイコンの絵文字ピッカー。初めて「変更」を押したときに読み込む。
  // 絵文字データは CSP（connect-src 'self'）に合わせて自前配信する
  const EMOJI_PICKER_BASE_URL = 'https://cdn.jsdelivr.net/npm/emoji-picker-element@1.29.1'
  const EMOJI_DATA_URL = (locale) => `/static/vendor/emoji/${locale}/data.json`

  const state = {
    trees: [],
    currentTreeId: null,
    currentUser: null,
    openMenuTreeId: null,
    memberTreeId: null,
    mcpTree: null
  }

  const byId = (id) => document.getElementById(id)

  // HTML 文字列へ差し込む値のエスケープ。属性値（"..." / '...'）の中でも使うので引用符も変換する。
  // textContent → innerHTML では & < > しか変換されず、属性を閉じて書き足される（メンバーの表示名など）
  function escapeText(value) {
    return (value === null || value === undefined ? '' : String(value))
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  function notify(message, type) {
    if (typeof window.showToast === 'function') {
      window.showToast(escapeText(message), type)
    }
  }

  function roleLabel(role) {
    return {
      owner: t('mypage.roleOwner'),
      editor: t('mypage.roleEditor'),
      viewer: t('mypage.roleViewer')
    }[role] || role
  }

  function treeInitial(name) {
    const first = Array.from(String(name || '').trim())[0] || '?'
    return first.toUpperCase()
  }

  /**
   * 丸アイコンに出す文字。絵文字アイコンがあればそれ、無ければツリー名の先頭文字
   * @param {{ name: string, icon?: string | null }} tree
   */
  function treeChipLabel(tree) {
    return tree.icon || treeInitial(tree.name)
  }

  function applyChipLabel(chip, tree) {
    chip.textContent = treeChipLabel(tree)
    chip.classList.toggle('has-icon', Boolean(tree.icon))
  }

  /** @param {{ id: number, color?: string | null }} tree */
  function chipColor(tree) {
    const chosen = CHIP_COLORS.find(([key]) => key === (tree.color === 'teal' ? 'white' : tree.color))
    if (chosen) return chosen[1]
    const index = Math.abs(Number(tree.id) || 0) % CHIP_COLORS.length
    return CHIP_COLORS[index][1]
  }

  function applyChipColor(chip, tree) {
    const color = chipColor(tree)
    chip.style.background = color
    chip.classList.toggle('is-white', color === '#ffffff')
  }

  function findTree(treeId) {
    return state.trees.find(tree => tree.id === Number(treeId)) || null
  }

  // ---------------- 最後に開いたツリー ----------------

  function readLastAccessedMap() {
    try {
      const raw = localStorage.getItem(LAST_ACCESSED_STORAGE_KEY)
      const parsed = raw ? JSON.parse(raw) : {}
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch (error) {
      console.warn('Failed to read tree last-accessed map:', error)
      return {}
    }
  }

  function markLastAccessed(treeId, { render: shouldRender = true } = {}) {
    if (!Number.isFinite(Number(treeId))) return
    const next = { ...readLastAccessedMap(), [String(treeId)]: new Date().toISOString() }
    try {
      localStorage.setItem(LAST_ACCESSED_STORAGE_KEY, JSON.stringify(next))
    } catch (error) {
      console.warn('Failed to persist tree last-accessed map:', error)
    }
    // 開いたツリーを左バーの先頭へ反映する
    if (shouldRender) render()
  }

  /**
   * 左バーの表示順: 最後に開いた順（新しい順）。一度も開いていないツリーはその後ろに作成順。
   * 自分のツリーと共有ツリーは区切らない（ツリーが多いと下のものを毎回探すことになるため）
   * @param {Array<{id: number}>} trees
   */
  function sortTrees(trees) {
    const accessMap = readLastAccessedMap()
    const openedAt = (tree) => {
      const ts = Date.parse(accessMap[String(tree.id)] || '')
      return Number.isFinite(ts) ? ts : null
    }
    return [...trees].sort((a, b) => {
      const aTs = openedAt(a)
      const bTs = openedAt(b)
      if (aTs !== null && bTs !== null && aTs !== bTs) return bTs - aTs
      if (aTs !== null && bTs === null) return -1
      if (aTs === null && bTs !== null) return 1
      return a.id - b.id
    })
  }

  /**
   * 着地先: 左バーの先頭（＝最後に開いたツリー、記録が無ければ作成順で最初）→ 0件なら null
   * @param {Array<{id: number}>} trees
   */
  function pickLandingTree(trees) {
    if (!Array.isArray(trees) || trees.length === 0) return null
    return sortTrees(trees)[0]
  }

  // ---------------- 閉じた状態（アイコン列） ----------------

  function buildRailChip(tree) {
    const wrap = document.createElement('span')
    wrap.className = 'tree-rail-chip-wrap'
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `tree-rail-chip tree-chip${tree.id === state.currentTreeId ? ' current' : ''}`
    button.dataset.treeId = String(tree.id)
    applyChipColor(button, tree)
    // ページをまたぐ切替アニメーション（View Transitions）で、同じツリーのアイコン同士を対応づける
    button.style.viewTransitionName = `tree-chip-${tree.id}`
    applyChipLabel(button, tree)
    button.setAttribute('aria-label', tree.name)
    button.dataset.tip = tree.role === 'owner' ? tree.name : `${tree.name}（${roleLabel(tree.role)}）`
    if (tree.id === state.currentTreeId) button.setAttribute('aria-current', 'page')
    wrap.appendChild(button)
    return wrap
  }

  function renderRail() {
    const list = byId('tree-rail-list')
    if (!list) return
    const trees = sortTrees(state.trees)
    // 並び・名前・開いているツリーが同じなら描き直さない。
    // 切替アニメーションの最中に要素を作り直すと、アニメーションが打ち切られるため
    const signature = JSON.stringify([state.currentTreeId, trees.map(tree => [tree.id, tree.name, tree.icon, tree.color, tree.role])])
    if (list.dataset.signature === signature) return
    list.dataset.signature = signature
    list.replaceChildren(...trees.map(buildRailChip))
  }

  // ---------------- 開いた状態（ドロワー） ----------------

  function menuItemsFor(tree) {
    if (tree.role === 'owner') {
      return [
        { action: 'edit', icon: 'fa-pencil-alt', label: t('mypage.editTreeName') },
        { action: 'mcp', icon: 'fa-key', label: t('mypage.mcpIntegration') },
        { action: 'members', icon: 'fa-user-cog', label: t('mypage.memberManagement') },
        { separator: true },
        { action: 'delete', icon: 'fa-trash-alt', label: t('mypage.delete'), danger: true }
      ]
    }
    if (tree.role === 'editor') {
      return [{ action: 'members', icon: 'fa-user-cog', label: t('mypage.memberManagement') }]
    }
    return []
  }

  function buildRowMenu(tree) {
    const menu = document.createElement('div')
    menu.className = 'tree-drawer-menu'
    menu.setAttribute('role', 'menu')
    menuItemsFor(tree).forEach(item => {
      if (item.separator) {
        const sep = document.createElement('div')
        sep.className = 'tree-menu-sep'
        menu.appendChild(sep)
        return
      }
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `tree-menu-item${item.danger ? ' danger' : ''}`
      button.dataset.action = item.action
      button.setAttribute('role', 'menuitem')
      const icon = document.createElement('i')
      icon.className = `fas ${item.icon}`
      button.append(icon, item.label)
      menu.appendChild(button)
    })
    if (tree.role !== 'owner' && tree.owner_display_name) {
      const note = document.createElement('div')
      note.className = 'tree-menu-item tree-menu-note'
      note.textContent = t('mypage.ownerLabel', { name: tree.owner_display_name })
      menu.appendChild(note)
    }
    return menu
  }

  function buildDrawerRow(tree) {
    const isCurrent = tree.id === state.currentTreeId
    const row = document.createElement('div')
    row.className = `tree-drawer-row${isCurrent ? ' current' : ''}`
    row.dataset.treeId = String(tree.id)

    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'tree-drawer-open'
    open.dataset.treeId = String(tree.id)
    const details = [tree.name]
    if (tree.description) details.push(tree.description)
    if (tree.role !== 'owner' && tree.owner_display_name) details.push(t('mypage.ownerLabel', { name: tree.owner_display_name }))
    details.push(`${t('mypage.nodeCountOther', { count: tree.node_count || 0 })} / ${t('mypage.memberCountOther', { count: tree.member_count || 0 })}`)
    open.title = details.join('\n')

    const chip = document.createElement('span')
    chip.className = 'tree-chip'
    applyChipColor(chip, tree)
    applyChipLabel(chip, tree)
    chip.setAttribute('aria-hidden', 'true')
    const name = document.createElement('span')
    name.className = 'tree-drawer-name'
    name.textContent = tree.name
    open.append(chip, name)
    if (tree.role !== 'owner') {
      const role = document.createElement('span')
      role.className = `tree-role-mini ${tree.role}`
      role.title = roleLabel(tree.role)
      role.textContent = tree.role === 'editor' ? 'E' : 'V'
      open.appendChild(role)
    }
    row.appendChild(open)

    if (tree.role === 'owner') {
      const meta = document.createElement('span')
      meta.className = 'tree-drawer-meta'
      meta.textContent = String(tree.node_count || 0)
      row.appendChild(meta)
    }

    const isMenuOpen = state.openMenuTreeId === tree.id
    const more = document.createElement('button')
    more.type = 'button'
    more.className = 'tree-drawer-more'
    more.dataset.menuTreeId = String(tree.id)
    more.setAttribute('aria-label', t('mypage.treeMenuAria', { name: tree.name }))
    more.setAttribute('aria-haspopup', 'menu')
    more.setAttribute('aria-expanded', String(isMenuOpen))
    more.innerHTML = '<i class="fas fa-ellipsis-h"></i>'
    row.appendChild(more)
    if (isMenuOpen) row.appendChild(buildRowMenu(tree))
    return row
  }

  function renderDrawer() {
    const list = byId('tree-drawer-list')
    if (!list) return
    const trees = sortTrees(state.trees)
    if (trees.length === 0) {
      const none = document.createElement('div')
      none.className = 'tree-drawer-none'
      none.textContent = t('mypage.noTreesYet')
      list.replaceChildren(none)
      return
    }
    list.replaceChildren(...trees.map(buildDrawerRow))
  }

  function render() {
    renderRail()
    renderDrawer()
  }

  function isDrawerOpen() {
    return byId('tree-drawer')?.classList.contains('open') || false
  }

  function setDrawerOpen(open) {
    const drawer = byId('tree-drawer')
    const scrim = byId('tree-drawer-scrim')
    if (!drawer) return
    if (!open) state.openMenuTreeId = null
    drawer.classList.toggle('open', open)
    drawer.setAttribute('aria-hidden', String(!open))
    scrim?.classList.toggle('open', open)
    byId('app-menu-btn')?.setAttribute('aria-expanded', String(open))
    hideTip()
    renderDrawer()
  }

  // ---------------- 開いた状態の幅（右端のつまみで変える） ----------------

  function clampDrawerWidth(width) {
    const max = Math.max(DRAWER_MIN_WIDTH, Math.min(DRAWER_MAX_WIDTH, Math.floor(window.innerWidth * DRAWER_MAX_VIEWPORT_RATIO)))
    return Math.round(Math.min(max, Math.max(DRAWER_MIN_WIDTH, width)))
  }

  function readDrawerWidth() {
    try {
      const saved = Number(localStorage.getItem(DRAWER_WIDTH_STORAGE_KEY))
      return Number.isFinite(saved) && saved > 0 ? saved : null
    } catch (error) {
      return null
    }
  }

  function applyDrawerWidth(width, { persist = false } = {}) {
    const drawer = byId('tree-drawer')
    const handle = byId('tree-drawer-resize')
    if (!drawer) return
    const next = clampDrawerWidth(width)
    drawer.style.setProperty('--drawer-width', `${next}px`)
    handle?.setAttribute('aria-valuenow', String(next))
    handle?.setAttribute('aria-valuemin', String(DRAWER_MIN_WIDTH))
    handle?.setAttribute('aria-valuemax', String(clampDrawerWidth(DRAWER_MAX_WIDTH)))
    if (!persist) return
    try {
      localStorage.setItem(DRAWER_WIDTH_STORAGE_KEY, String(next))
    } catch (error) {
      console.warn('Failed to persist tree drawer width:', error)
    }
  }

  function currentDrawerWidth() {
    return byId('tree-drawer')?.getBoundingClientRect().width || DRAWER_MIN_WIDTH
  }

  function bindDrawerResize() {
    const handle = byId('tree-drawer-resize')
    if (!handle) return
    const saved = readDrawerWidth()
    if (saved) applyDrawerWidth(saved)

    let startX = 0
    let startWidth = 0
    let frameId = null
    let latestX = 0

    const onMove = (event) => {
      latestX = event.clientX
      if (frameId) return
      frameId = window.requestAnimationFrame(() => {
        frameId = null
        applyDrawerWidth(startWidth + (latestX - startX))
      })
    }
    const onUp = (event) => {
      handle.releasePointerCapture?.(event.pointerId)
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', onUp)
      if (frameId) {
        window.cancelAnimationFrame(frameId)
        frameId = null
      }
      handle.classList.remove('dragging')
      document.body.style.userSelect = ''
      applyDrawerWidth(startWidth + (latestX - startX), { persist: true })
    }

    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      startX = event.clientX
      latestX = event.clientX
      startWidth = currentDrawerWidth()
      handle.setPointerCapture?.(event.pointerId)
      handle.classList.add('dragging')
      document.body.style.userSelect = 'none'
      handle.addEventListener('pointermove', onMove)
      handle.addEventListener('pointerup', onUp)
      handle.addEventListener('pointercancel', onUp)
    })

    handle.addEventListener('keydown', (event) => {
      const deltas = { ArrowLeft: -DRAWER_KEY_STEP, ArrowRight: DRAWER_KEY_STEP }
      let next = null
      if (event.key in deltas) next = currentDrawerWidth() + deltas[event.key]
      else if (event.key === 'Home') next = DRAWER_MIN_WIDTH
      else if (event.key === 'End') next = DRAWER_MAX_WIDTH
      if (next === null) return
      event.preventDefault()
      applyDrawerWidth(next, { persist: true })
    })

    // 画面を狭めたとき、保存した幅が画面幅の上限を超えないよう合わせ直す
    window.addEventListener('resize', () => applyDrawerWidth(readDrawerWidth() || currentDrawerWidth()))
  }

  // ---------------- ツリー名のツールチップ ----------------

  let tipElement = null

  function showTip(target) {
    if (!tipElement) {
      tipElement = document.createElement('div')
      tipElement.className = 'tree-rail-tip'
      tipElement.setAttribute('role', 'tooltip')
      document.body.appendChild(tipElement)
    }
    const rect = target.getBoundingClientRect()
    tipElement.textContent = target.dataset.tip
    tipElement.style.left = `${rect.right + 10}px`
    tipElement.style.top = `${rect.top + rect.height / 2 - 13}px`
    tipElement.hidden = false
  }

  function hideTip() {
    if (tipElement) tipElement.hidden = true
  }

  // ---------------- 画面遷移 ----------------

  function saveRailCache() {
    try {
      // 左バーの描き直し判定（renderRail の signature）に使う項目は全部保存する。
      // 欠けていると取得後に描き直され、切替アニメーションが途中で打ち切られる
      const trees = state.trees.map(({ id, name, icon, color, role }) => ({ id, name, icon, color, role }))
      sessionStorage.setItem(RAIL_CACHE_STORAGE_KEY, JSON.stringify(trees))
    } catch (error) {
      // 保存できなくても切替はできる（アニメーションが付かないだけ）
    }
  }

  // 前のページが保存した一覧で、読み込み途中に左バーだけ先に描く（最初の描画に間に合わせる）
  function renderRailFromCache() {
    try {
      const cached = JSON.parse(sessionStorage.getItem(RAIL_CACHE_STORAGE_KEY) || 'null')
      if (!Array.isArray(cached) || cached.length === 0) return
      const treeId = Number(new URLSearchParams(window.location.search).get('tree'))
      state.trees = cached
      state.currentTreeId = cached.some(tree => tree.id === treeId) ? treeId : null
      renderRail()
    } catch (error) {
      // 読めなければ通常どおり、データ取得後に描く
    }
  }

  async function navigateToTree(treeId) {
    const go = () => {
      // 先に「最後に開いた」を記録して一覧を保存しておくと、次のページは最初から新しい並びで描ける
      markLastAccessed(treeId, { render: false })
      saveRailCache()
      window.location.href = `/index.html?tree=${encodeURIComponent(treeId)}`
    }
    if (typeof window.runWithUnsavedGuard === 'function') {
      await window.runWithUnsavedGuard(go)
    } else {
      go()
    }
  }

  async function reloadTrees() {
    const response = await fetch('/api/trees')
    if (!response.ok) throw new Error(`Failed to load trees: ${response.status}`)
    const data = await response.json()
    if (!data.success || !Array.isArray(data.data)) throw new Error('Failed to load trees')
    state.trees = data.data
    render()
    return state.trees
  }

  function runMenuAction(action, tree) {
    state.openMenuTreeId = null
    renderDrawer()
    if (action === 'edit') return editTreeName(tree.id, tree.name, tree.description || '', tree.icon || null, tree.color || null)
    if (action === 'mcp') return openMcpModal(tree.id)
    if (action === 'members') return openMemberModal(tree.id)
    if (action === 'delete') return confirmDeleteTree(tree.id, tree.name)
    return undefined
  }

  function bindRailEvents() {
    const rail = byId('tree-rail')
    const drawer = byId('tree-drawer')
    const scrim = byId('tree-drawer-scrim')

    byId('tree-rail-create-btn')?.addEventListener('click', openCreateTreeModal)
    byId('tree-drawer-create-btn')?.addEventListener('click', openCreateTreeModal)
    byId('tree-empty-create-btn')?.addEventListener('click', openCreateTreeModal)
    scrim?.addEventListener('click', () => setDrawerOpen(false))

    rail?.addEventListener('click', (event) => {
      const chip = event.target.closest('.tree-rail-chip')
      if (chip) navigateToTree(chip.dataset.treeId)
    })
    rail?.addEventListener('mouseover', (event) => {
      const target = event.target.closest('[data-tip]')
      if (target) showTip(target)
      else hideTip()
    })
    rail?.addEventListener('mouseleave', hideTip)
    byId('tree-rail-list')?.addEventListener('scroll', hideTip, { passive: true })

    drawer?.addEventListener('click', (event) => {
      const more = event.target.closest('.tree-drawer-more')
      if (more) {
        const treeId = Number(more.dataset.menuTreeId)
        state.openMenuTreeId = state.openMenuTreeId === treeId ? null : treeId
        renderDrawer()
        return
      }
      const item = event.target.closest('.tree-menu-item[data-action]')
      if (item) {
        const tree = findTree(item.closest('.tree-drawer-row')?.dataset.treeId)
        if (tree) runMenuAction(item.dataset.action, tree)
        return
      }
      const open = event.target.closest('.tree-drawer-open')
      if (open) {
        setDrawerOpen(false)
        if (Number(open.dataset.treeId) !== state.currentTreeId) navigateToTree(open.dataset.treeId)
        return
      }
      if (state.openMenuTreeId !== null && !event.target.closest('.tree-drawer-menu')) {
        state.openMenuTreeId = null
        renderDrawer()
      }
    })

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !isDrawerOpen()) return
      if (document.querySelector('.tree-modal.active')) return
      event.preventDefault()
      event.stopPropagation()
      setDrawerOpen(false)
    }, true)
  }

  // ---------------- ヘッダー（☰ とアカウント操作） ----------------

  function menuButtonHtml() {
    const label = escapeText(t('mypage.menu'))
    return `<button id="app-menu-btn" class="app-menu-btn" type="button" aria-label="${label}" title="${label}" aria-controls="tree-drawer" aria-expanded="${isDrawerOpen()}"><i class="fas fa-bars"></i></button>`
  }

  function headerAccountHtml() {
    const notifications = escapeText(t('mypage.notifications'))
    const settings = escapeText(t('mypage.settings'))
    const logout = escapeText(t('mypage.logout'))
    return `
      <div class="header-account">
        <div class="header-pop-anchor">
          <button id="notification-bell-btn" class="header-icon-btn notification-bell" type="button" aria-label="${notifications}" title="${notifications}" aria-haspopup="true" aria-expanded="false">
            <i class="fas fa-bell"></i>
            <span id="notification-badge" class="notification-badge" style="display: none;">0</span>
          </button>
          <div id="notification-dropdown" class="notification-dropdown">
            <div class="notification-header">
              <h4>${notifications}</h4>
              <button type="button" id="notification-read-all-btn">${escapeText(t('mypage.markAllRead'))}</button>
            </div>
            <div id="notification-list"></div>
          </div>
        </div>
        <div class="header-pop-anchor">
          <button id="settings-btn" class="header-icon-btn" type="button" aria-label="${settings}" title="${settings}" aria-haspopup="true" aria-expanded="false" aria-controls="settings-menu">
            <i class="fas fa-cog"></i>
          </button>
          <div id="settings-menu" class="tree-header-pop" hidden>
            <label class="settings-row" for="theme-switcher">${escapeText(t('mypage.themeSwitchLabel'))}
              <select id="theme-switcher" data-testid="theme-switcher">
                <option value="system">${escapeText(t('mypage.themeSystem'))}</option>
                <option value="light">${escapeText(t('mypage.themeLight'))}</option>
                <option value="dark">${escapeText(t('mypage.themeDark'))}</option>
              </select>
            </label>
            <label class="settings-row" for="lang-switcher">${escapeText(t('mypage.langSwitchLabel'))}
              <select id="lang-switcher" data-testid="lang-switcher">
                <option value="ja">日本語</option>
                <option value="en">English</option>
              </select>
            </label>
            <div class="tree-menu-sep"></div>
            <button id="profile-link" class="tree-menu-item" type="button"><i class="fas fa-user-cog"></i>${escapeText(t('mypage.profileSettingsTitle'))}</button>
            <a id="terms-privacy-link" class="tree-menu-item" href="/help?tab=terms" target="_blank" rel="noopener"><i class="fas fa-file-contract"></i>${escapeText(t('mypage.termsPrivacy'))}</a>
            <div class="tree-menu-sep"></div>
            <div class="settings-version">${escapeText(t('mypage.buildLabel'))} <span id="version-badge">${escapeText(window.__BUILD_STAMP__ || '')}</span></div>
          </div>
        </div>
        <button id="logout-btn" class="header-logout" type="button" aria-label="${logout}" title="${logout}">
          <i class="fas fa-sign-out-alt"></i><span>${logout}</span>
        </button>
      </div>
    `
  }

  function setSettingsOpen(open) {
    const menu = byId('settings-menu')
    if (!menu) return
    menu.hidden = !open
    byId('settings-btn')?.setAttribute('aria-expanded', String(open))
  }

  function bindHeaderEvents() {
    byId('app-menu-btn')?.addEventListener('click', () => setDrawerOpen(!isDrawerOpen()))

    byId('notification-bell-btn')?.addEventListener('click', (event) => {
      event.stopPropagation()
      setSettingsOpen(false)
      if (typeof window.toggleNotifications === 'function') window.toggleNotifications()
    })
    byId('notification-read-all-btn')?.addEventListener('click', () => {
      if (typeof window.markAllAsRead === 'function') window.markAllAsRead()
    })

    byId('settings-btn')?.addEventListener('click', (event) => {
      event.stopPropagation()
      if (typeof window.closeNotifications === 'function') window.closeNotifications()
      setSettingsOpen(byId('settings-menu')?.hidden ?? false)
    })
    document.addEventListener('click', (event) => {
      if (!event.target.closest('#settings-menu') && !event.target.closest('#settings-btn')) setSettingsOpen(false)
    })

    const themeSwitcher = byId('theme-switcher')
    if (themeSwitcher && window.ZeetaTheme) {
      themeSwitcher.value = window.ZeetaTheme.getTheme()
      themeSwitcher.addEventListener('change', (event) => window.ZeetaTheme.setTheme(event.target.value))
    }
    const langSwitcher = byId('lang-switcher')
    if (langSwitcher && window.ZeetaI18n) {
      langSwitcher.value = window.ZeetaI18n.locale
      langSwitcher.addEventListener('change', async (event) => {
        const nextLocale = event.target.value
        const apply = () => window.ZeetaI18n.setLocale(nextLocale)
        if (typeof window.runWithUnsavedGuard === 'function') await window.runWithUnsavedGuard(apply)
        else apply()
      })
    }

    byId('profile-link')?.addEventListener('click', () => {
      setSettingsOpen(false)
      openProfileModal()
    })

    byId('logout-btn')?.addEventListener('click', async () => {
      const run = () => (typeof window.logout === 'function' ? window.logout() : (window.location.href = '/login.html'))
      if (typeof window.runWithUnsavedGuard === 'function') await window.runWithUnsavedGuard(run)
      else run()
    })

    // 通知は DOMContentLoaded 時点ではヘッダーが無く取りこぼすので、描画後に読み直す
    if (typeof window.loadNotifications === 'function') window.loadNotifications()
  }

  // ---------------- モーダル: プロフィール設定 ----------------
  // 別ページ（/profile.html）へ遷移するとツリーの選択・開閉状態が失われるため、モーダルで開く

  const PROFILE_PROVIDER_ICONS = {
    google: { icon: 'fab fa-google mr-2 text-red-500', label: 'Google' },
    github: { icon: 'fab fa-github mr-2', label: 'GitHub' },
    test: { icon: 'fas fa-flask mr-2 text-blue-500', label: 'Test Account' }
  }

  function isProfileModalOpen() {
    return byId('profile-modal')?.classList.contains('active') ?? false
  }

  function setProfileModalError(message) {
    const error = byId('profile-modal-error')
    if (!error) return
    error.textContent = message || ''
    error.hidden = !message
  }

  /** @param {{ email?: string, display_name?: string, avatar_url?: string, oauth_provider?: string }} profile */
  function fillProfileModal(profile) {
    byId('profile-modal-email').value = profile.email || ''
    byId('profile-modal-display-name').value = profile.display_name || ''

    const avatar = byId('profile-modal-avatar')
    const hasAvatar = typeof profile.avatar_url === 'string' && /^https:\/\//.test(profile.avatar_url)
    avatar.hidden = !hasAvatar
    if (hasAvatar) avatar.src = profile.avatar_url
    else avatar.removeAttribute('src')
    byId('profile-modal-avatar-placeholder').hidden = hasAvatar

    const provider = PROFILE_PROVIDER_ICONS[profile.oauth_provider] || { icon: 'fas fa-user mr-2', label: profile.oauth_provider || 'Unknown' }
    const providerEl = byId('profile-modal-provider')
    providerEl.querySelector('i').className = provider.icon
    providerEl.querySelector('span').textContent = provider.label
  }

  async function openProfileModal() {
    setProfileModalError('')
    byId('profile-modal-form')?.reset()
    openModal('profile-modal')
    try {
      const response = await fetch('/api/profile', { credentials: 'include' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.success || !data.data) throw new Error(data.error || 'Failed to load profile')
      fillProfileModal(data.data)
      byId('profile-modal-display-name')?.focus()
    } catch (error) {
      console.error('Failed to load profile:', error)
      setProfileModalError(t('profile.loadFailed'))
    }
  }

  function closeProfileModal() {
    closeModal('profile-modal')
    setProfileModalError('')
  }

  async function submitProfileModal(event) {
    event.preventDefault()
    const displayName = byId('profile-modal-display-name').value.trim()
    if (!displayName) {
      setProfileModalError(t('profile.displayNameRequired'))
      return
    }

    const saveButton = byId('profile-modal-save')
    saveButton.disabled = true
    try {
      const response = await fetch('/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ display_name: displayName })
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.success) throw new Error(data.error || 'Failed to update profile')
      if (state.currentUser) state.currentUser = { ...state.currentUser, display_name: data.data?.display_name ?? displayName }
      closeProfileModal()
      notify(t('profile.updateSuccess'), 'success')
    } catch (error) {
      console.error('Failed to update profile:', error)
      setProfileModalError(t('profile.updateFailed'))
    } finally {
      saveButton.disabled = false
    }
  }

  function bindProfileModalEvents() {
    // 背景（モーダルの外側）クリックで閉じる
    byId('profile-modal')?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) closeProfileModal()
    })
    // Esc で閉じる。エディタ側のショートカットへ渡さない
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !isProfileModalOpen()) return
      event.preventDefault()
      event.stopPropagation()
      closeProfileModal()
    }, true)
  }

  // ---------------- モーダル: ツリーの作成・編集・削除 ----------------

  function openModal(id) {
    setDrawerOpen(false)
    byId(id)?.classList.add('active')
  }

  function closeModal(id) {
    byId(id)?.classList.remove('active')
  }

  function openCreateTreeModal() {
    openModal('create-tree-modal')
    byId('tree-name')?.focus()
  }

  function closeCreateTreeModal() {
    closeModal('create-tree-modal')
    byId('create-tree-form')?.reset()
  }

  async function createTree(event) {
    event.preventDefault()
    const form = event.target
    const name = form.name.value.trim()
    const description = form.description.value.trim() || null
    if (!name) return

    try {
      const response = await fetch('/api/trees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description })
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.success) throw new Error(data.error || 'Failed to create tree')
      closeCreateTreeModal()
      await navigateToTree(data.data.id)
    } catch (error) {
      console.error('Failed to create tree:', error)
      notify(error.message === 'Tree quota exceeded'
        ? t('mypage.treeQuotaExceeded')
        : t('mypage.treeCreateFailedWithReason', { reason: error.message }), 'error')
    }
  }

  function editTreeName(treeId, currentName, currentDescription, currentIcon, currentColor) {
    byId('edit-tree-id').value = treeId
    byId('edit-tree-name').value = currentName
    byId('edit-tree-description').value = currentDescription || ''
    renderTreeColorOptions(currentColor || null)
    setEditTreeIcon(currentIcon || null)
    setTreeIconPickerOpen(false)
    openModal('edit-tree-modal')
    byId('edit-tree-name').focus()
    byId('edit-tree-name').select()
  }

  function closeEditTreeModal() {
    closeModal('edit-tree-modal')
    byId('edit-tree-form')?.reset()
    setTreeIconPickerOpen(false)
  }

  // ---------------- ツリーアイコン（編集モーダル） ----------------

  function selectedTreeColor() {
    return document.querySelector('#edit-tree-color-options input[name="tree-color"]:checked')?.value || null
  }

  /** プレビューは選択中のアイコン・色で描く。確定は「保存」時 */
  function renderEditTreePreview() {
    const id = Number(byId('edit-tree-id').value)
    const icon = byId('edit-tree-icon').value || null
    const name = byId('edit-tree-name').value || findTree(id)?.name || ''
    const preview = byId('edit-tree-icon-preview')
    applyChipColor(preview, { id, color: selectedTreeColor() })
    applyChipLabel(preview, { name, icon })
    byId('edit-tree-icon-clear').hidden = !icon
  }

  function setEditTreeIcon(icon) {
    byId('edit-tree-icon').value = icon || ''
    renderEditTreePreview()
  }

  // 「自動」＋8色のラジオボタン。色見本の背景は style で入れる（キーは固定値のみ）
  function renderTreeColorOptions(currentColor) {
    const container = byId('edit-tree-color-options')
    const options = [[null, null], ...CHIP_COLORS].map(([key, hex]) => {
      const label = document.createElement('label')
      label.className = `tree-color-option${key ? '' : ' tree-color-auto'}`
      label.title = t(key ? `mypage.treeColorName.${key}` : 'mypage.treeColorAuto')
      const input = document.createElement('input')
      input.type = 'radio'
      input.name = 'tree-color'
      input.value = key || ''
      input.checked = key === (currentColor === 'teal' ? 'white' : currentColor)
      input.setAttribute('aria-label', label.title)
      input.addEventListener('change', renderEditTreePreview)
      const swatch = document.createElement('span')
      swatch.className = 'tree-color-swatch'
      swatch.setAttribute('aria-hidden', 'true')
      if (hex) swatch.style.background = hex
      else swatch.textContent = t('mypage.treeColorAuto')
      if (key === 'white') swatch.classList.add('is-white')
      label.append(input, swatch)
      return label
    })
    container.replaceChildren(...options)
  }

  let emojiPickerPromise = null

  function loadEmojiPicker() {
    if (!emojiPickerPromise) {
      const locale = window.ZeetaI18n?.locale === 'ja' ? 'ja' : 'en'
      emojiPickerPromise = Promise.all([
        import(`${EMOJI_PICKER_BASE_URL}/index.js`),
        locale === 'ja' ? import(`${EMOJI_PICKER_BASE_URL}/i18n/ja.js`) : Promise.resolve(null)
      ]).then(([{ Picker }, i18nModule]) => {
        const picker = new Picker({
          locale,
          dataSource: EMOJI_DATA_URL(locale),
          ...(i18nModule ? { i18n: i18nModule.default } : {})
        })
        picker.addEventListener('emoji-click', (event) => {
          setEditTreeIcon(event.detail.unicode)
          setTreeIconPickerOpen(false)
        })
        return picker
      }).catch((error) => {
        emojiPickerPromise = null
        throw error
      })
    }
    return emojiPickerPromise
  }

  function setTreeIconPickerOpen(isOpen) {
    const container = byId('edit-tree-icon-picker')
    if (!container) return
    container.hidden = !isOpen
    byId('edit-tree-icon-change')?.setAttribute('aria-expanded', String(isOpen))
  }

  async function toggleTreeIconPicker() {
    const container = byId('edit-tree-icon-picker')
    if (!container.hidden) {
      setTreeIconPickerOpen(false)
      return
    }
    try {
      const picker = await loadEmojiPicker()
      const isDark = document.documentElement.classList.contains('theme-dark')
      picker.classList.toggle('dark', isDark)
      picker.classList.toggle('light', !isDark)
      if (picker.parentElement !== container) container.replaceChildren(picker)
      setTreeIconPickerOpen(true)
    } catch (error) {
      console.error('Failed to load emoji picker:', error)
      notify(t('mypage.treeIconPickerLoadFailed'), 'error')
    }
  }

  function clearTreeIcon() {
    setEditTreeIcon(null)
    setTreeIconPickerOpen(false)
  }

  async function submitEditTreeName(event) {
    event.preventDefault()
    const treeId = Number(byId('edit-tree-id').value)
    const name = byId('edit-tree-name').value.trim()
    const description = byId('edit-tree-description').value.trim() || null
    const icon = byId('edit-tree-icon').value || null
    const color = selectedTreeColor()
    if (!name) return

    try {
      const response = await fetch(`/api/trees/${treeId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description, icon, color })
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.success) {
        notify(t('mypage.treeNameUpdateFailedWithReason', { reason: data.error || 'Unknown error' }), 'error')
        return
      }
      closeEditTreeModal()
      await reloadTrees()
      if (treeId === state.currentTreeId) {
        document.dispatchEvent(new CustomEvent('zeeta:current-tree-updated', { detail: { tree: findTree(treeId) } }))
      }
    } catch (error) {
      console.error('Failed to update tree name:', error)
      notify(t('mypage.treeNameUpdateFailed'), 'error')
    }
  }

  function confirmDeleteTree(treeId, treeName) {
    byId('delete-tree-id').value = treeId
    const nameElement = byId('delete-tree-name')
    const placeholder = '__TREE_NAME__'
    const [before, after] = t('mypage.deleteConfirm', { name: placeholder }).split(placeholder)
    nameElement.textContent = treeName
    nameElement.parentElement.replaceChildren(before, nameElement, after)
    openModal('delete-tree-modal')
  }

  function closeDeleteTreeModal() {
    closeModal('delete-tree-modal')
  }

  async function executeDeleteTree() {
    const treeId = Number(byId('delete-tree-id').value)
    try {
      const response = await fetch(`/api/trees/${treeId}`, { method: 'DELETE' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.success) {
        notify(t('mypage.treeDeleteFailedWithReason', { reason: data.error || 'Unknown error' }), 'error')
        return
      }
      closeDeleteTreeModal()
      if (treeId === state.currentTreeId) {
        // 開いているツリーを消したときは着地先（最後に開いた別のツリー）へ移る
        window.location.href = '/index.html'
        return
      }
      await reloadTrees()
      notify(t('mypage.treeDeleted'), 'success')
    } catch (error) {
      console.error('Failed to delete tree:', error)
      notify(t('mypage.treeDeleteFailed'), 'error')
    }
  }

  // ---------------- モーダル: MCP連携 ----------------

  function buildMcpConnectionUrl(tree) {
    return `${window.location.origin}/api/mcp/trees/${tree.id}`
  }

  function openMcpModal(treeId) {
    state.mcpTree = findTree(treeId)
    if (!state.mcpTree) {
      notify(t('mypage.treeInfoLoadFailed'), 'error')
      return
    }
    byId('mcp-tree-name').textContent = state.mcpTree.name
    byId('mcp-connection-url').textContent = buildMcpConnectionUrl(state.mcpTree)
    openModal('mcp-modal')
  }

  async function copyMcpConnectionUrl() {
    if (!state.mcpTree) {
      notify(t('mypage.treeInfoLoadFailed'), 'error')
      return
    }
    try {
      await navigator.clipboard.writeText(buildMcpConnectionUrl(state.mcpTree))
      notify(t('mypage.mcpUrlCopied'), 'success')
    } catch (error) {
      console.error('Failed to copy MCP connection URL:', error)
      notify(t('mypage.mcpUrlCopyFailed'), 'error')
    }
  }

  function closeMcpModal() {
    closeModal('mcp-modal')
    state.mcpTree = null
  }

  // ---------------- モーダル: メンバー管理 ----------------

  function memberCapabilities(treeId) {
    const tree = findTree(treeId)
    const isOwner = tree?.role === 'owner'
    const canOpen = tree?.role === 'owner' || tree?.role === 'editor'
    return {
      tree,
      isOwner,
      canOpenMemberModal: canOpen,
      canViewInvitations: canOpen,
      canManageInvitations: isOwner,
      canManageMembers: isOwner
    }
  }

  async function openMemberModal(treeId) {
    state.memberTreeId = Number(treeId)
    const capabilities = memberCapabilities(treeId)
    if (!capabilities.canOpenMemberModal) {
      notify(t('mypage.sharingPermissionDenied'), 'error')
      return
    }

    try {
      const membersResponse = await fetch(`/api/trees/${treeId}/members`)
      if (!membersResponse.ok) throw new Error('Failed to load members')
      const membersData = await membersResponse.json()
      if (membersData.success && membersData.data) displayMembers(membersData.data, Number(treeId))

      if (capabilities.canViewInvitations) {
        const invitationsResponse = await fetch(`/api/trees/${treeId}/invitations`)
        const invitationsData = await invitationsResponse.json()
        if (!invitationsResponse.ok || !invitationsData.success) {
          throw new Error(invitationsData.error || 'Failed to load invitations')
        }
        if (invitationsData.data) displayPendingInvitations(invitationsData.data, capabilities)
      }

      byId('invite-section').style.display = capabilities.canManageInvitations ? 'block' : 'none'
      byId('invite-form').reset()
      openModal('member-modal')
    } catch (error) {
      console.error('Failed to load members:', error)
      notify(t('mypage.membersLoadFailed'), 'error')
    }
  }

  function closeMemberModal() {
    closeModal('member-modal')
    state.memberTreeId = null
  }

  function displayPendingInvitations(invitations, capabilities) {
    const section = byId('pending-invitations-section')
    const list = byId('pending-invitations-list')
    const pending = invitations.filter(invitation => invitation.status === 'pending')
    if (pending.length === 0) {
      section.style.display = 'none'
      return
    }
    section.style.display = 'block'
    const dateLocale = window.ZeetaI18n.locale === 'ja' ? 'ja-JP' : 'en-US'

    list.innerHTML = pending.map(invitation => {
      const expiresAt = new Date(invitation.expires_at)
      const expiresText = expiresAt < new Date()
        ? t('mypage.expired')
        : t('mypage.expiresOn', { date: expiresAt.toLocaleDateString(dateLocale) })
      const role = ['owner', 'editor', 'viewer'].includes(invitation.role) ? invitation.role : 'viewer'
      return `
        <div class="flex items-center justify-between p-2 bg-yellow-50 rounded-lg border border-yellow-200">
          <div class="flex-1">
            <div class="text-sm font-semibold text-gray-800">${escapeText(invitation.invitee_email)}</div>
            <div class="text-xs text-gray-500">${escapeText(expiresText)}</div>
          </div>
          <div class="flex items-center space-x-2">
            <span class="role-badge role-${role}" style="font-size: 0.7rem; padding: 0.2rem 0.5rem;">${escapeText(roleLabel(role))}</span>
            <span class="text-xs text-gray-500 px-2 py-1 bg-yellow-100 rounded">${escapeText(t('mypage.inviting'))}</span>
            ${capabilities.canManageInvitations ? `
              <button type="button"
                onclick="event.stopPropagation(); cancelInvitation(${Number(state.memberTreeId)}, ${Number(invitation.id)})"
                class="text-red-600 hover:text-red-800 ml-1"
                title="${escapeText(t('mypage.cancelInvitation'))}"
              ><i class="fas fa-times"></i></button>
            ` : ''}
          </div>
        </div>
      `
    }).join('')
  }

  function displayMembers(members, treeId) {
    const capabilities = memberCapabilities(treeId)
    const currentUserId = state.currentUser?.id

    byId('members-list').innerHTML = members.map(member => {
      const role = ['owner', 'editor', 'viewer'].includes(member.role) ? member.role : 'viewer'
      const isSelf = member.user_id === currentUserId
      const canManage = capabilities.canManageMembers && role !== 'owner' && !isSelf
      const displayName = member.display_name || member.email || 'User'
      const avatar = member.avatar_url && /^https:\/\//.test(member.avatar_url)
        ? `<img src="${escapeText(member.avatar_url)}" alt="" class="w-10 h-10 rounded-full" referrerpolicy="no-referrer">`
        : `<div class="w-10 h-10 rounded-full bg-purple-500 flex items-center justify-center text-white font-bold">${escapeText(treeInitial(displayName))}</div>`

      return `
        <div class="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
          <div class="flex items-center space-x-3 flex-1">
            ${avatar}
            <div class="flex-1">
              <div class="text-sm font-semibold text-gray-800">${escapeText(member.display_name || 'User')}</div>
              <div class="text-xs text-gray-500">${escapeText(member.email)}</div>
            </div>
          </div>
          <div class="flex items-center space-x-2">
            ${canManage ? `
              <select
                onchange="changeMemberRole(${Number(treeId)}, ${Number(member.user_id)}, this.value)"
                class="px-3 py-1 text-sm border border-gray-300 rounded-full bg-white focus:outline-none focus:ring-2 focus:ring-purple-500"
                aria-label="${escapeText(t('mypage.memberRoleAria', { name: displayName }))}"
              >
                <option value="editor" ${role === 'editor' ? 'selected' : ''}>${escapeText(t('mypage.roleEditor'))}</option>
                <option value="viewer" ${role === 'viewer' ? 'selected' : ''}>${escapeText(t('mypage.roleViewer'))}</option>
              </select>
              <button type="button"
                onclick="removeMember(${Number(treeId)}, ${Number(member.user_id)})"
                class="text-red-600 hover:text-red-800 ml-2"
                title="${escapeText(t('mypage.removeMember'))}"
              ><i class="fas fa-times"></i></button>
            ` : `
              <span class="role-badge role-${role}">${escapeText(roleLabel(role))}</span>
            `}
          </div>
        </div>
      `
    }).join('')
  }

  async function changeMemberRole(treeId, userId, role) {
    try {
      const response = await fetch(`/api/trees/${treeId}/members/${userId}/role`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role })
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.success) throw new Error(data.error || 'Failed to change role')
      notify(t('mypage.roleChanged'), 'success')
    } catch (error) {
      console.error('Failed to change member role:', error)
      notify(t('mypage.roleChangeFailedWithReason', { reason: error.message }), 'error')
    }
    await openMemberModal(treeId)
  }

  async function removeMember(treeId, userId) {
    if (!confirm(t('mypage.removeMemberConfirm'))) return
    try {
      const response = await fetch(`/api/trees/${treeId}/members/${userId}`, { method: 'DELETE' })
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.error || 'Failed to remove member')
      }
      notify(t('mypage.memberRemoved'), 'success')
      await openMemberModal(treeId)
      await reloadTrees()
    } catch (error) {
      console.error('Failed to remove member:', error)
      notify(t('mypage.memberRemoveFailedWithReason', { reason: error.message }), 'error')
    }
  }

  async function cancelInvitation(treeId, invitationId) {
    if (!confirm(t('mypage.cancelInvitationConfirm'))) return
    try {
      const response = await fetch(`/api/trees/${treeId}/invitations/${invitationId}`, { method: 'DELETE' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.success) throw new Error(data.error || 'Failed to cancel invitation')
      notify(t('mypage.invitationCancelled'), 'success')
      await openMemberModal(treeId)
    } catch (error) {
      console.error('Failed to cancel invitation:', error)
      notify(t('mypage.invitationCancelFailedWithReason', { reason: error.message }), 'error')
    }
  }

  async function sendInvitation(event) {
    event.preventDefault()
    const form = event.target
    const email = form.email.value.trim()
    const role = form.role.value
    if (!email) {
      notify(t('mypage.emailRequired'), 'error')
      return
    }
    if (!EMAIL_PATTERN.test(email)) {
      notify(t('mypage.validEmailRequired'), 'error')
      return
    }

    const submitButton = form.querySelector('button[type="submit"]')
    submitButton.disabled = true
    submitButton.textContent = t('mypage.sending')
    try {
      const response = await fetch(`/api/trees/${state.memberTreeId}/invitations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role })
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.success) throw new Error(data.error || 'Failed to send invitation')
      notify(t('mypage.invitationSent'), 'success')
      form.reset()
      await openMemberModal(state.memberTreeId)
    } catch (error) {
      console.error('Failed to send invitation:', error)
      notify(t('mypage.invitationSendFailedWithReason', { reason: error.message }), 'error')
    } finally {
      submitButton.disabled = false
      submitButton.textContent = t('mypage.invite')
    }
  }

  // ---------------- 公開 ----------------

  /**
   * @param {{ trees: Array<object>, currentTreeId: number|null, currentUser: object|null }} options
   */
  function init({ trees, currentTreeId, currentUser }) {
    state.trees = Array.isArray(trees) ? trees : []
    state.currentTreeId = currentTreeId ?? null
    state.currentUser = currentUser || null
    render()
  }

  function setEmptyState(isEmpty) {
    const empty = byId('tree-empty-state')
    if (empty) empty.hidden = !isEmpty
    ;['tree-pane', 'resize-handle', 'editor-pane'].forEach((id) => {
      const element = byId(id)
      if (element) element.hidden = isEmpty
    })
  }

  renderRailFromCache()

  // 切替アニメーションの最中は画面を操作できない。終わるまでを「起動中」として扱えるよう、完了を待てる形で持っておく
  let revealTransitionDone = Promise.resolve()
  window.addEventListener('pagereveal', (event) => {
    if (event.viewTransition) revealTransitionDone = event.viewTransition.finished.catch(() => {})
  })

  document.addEventListener('DOMContentLoaded', () => {
    bindRailEvents()
    bindDrawerResize()
    bindProfileModalEvents()
  })

  window.ZeetaTreeRail = {
    init,
    render,
    reloadTrees,
    pickLandingTree,
    markLastAccessed,
    menuButtonHtml,
    headerAccountHtml,
    bindHeaderEvents,
    setDrawerOpen,
    setEmptyState,
    whenRevealTransitionDone: () => revealTransitionDone,
    getTree: findTree
  }

  // モーダル内の onclick / onsubmit から呼ばれるもの
  Object.assign(window, {
    openCreateTreeModal,
    closeCreateTreeModal,
    createTree,
    closeEditTreeModal,
    submitEditTreeName,
    toggleTreeIconPicker,
    clearTreeIcon,
    closeDeleteTreeModal,
    executeDeleteTree,
    closeMcpModal,
    copyMcpConnectionUrl,
    closeMemberModal,
    closeProfileModal,
    submitProfileModal,
    sendInvitation,
    changeMemberRole,
    removeMember,
    cancelInvitation
  })
})()

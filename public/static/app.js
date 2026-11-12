// ===============================
// グローバル状態管理
// ===============================
let currentTreeId = null // Current tree ID
let currentUser = null // Current user info
let currentUserRole = null // Current user's role in this tree ('owner', 'editor', 'viewer')
let currentTree = null // Current tree info
let treeMembers = [] // Tree members for author selection
let relationTypes = []
let relationTypesLoadFailed = false
let relationTypesErrorShown = false
let nodes = []
let relations = []
let relationChildrenByParent = new Map()
let relationParentsByChild = new Map()
let selectedNodeId = null
let selectedNodeVersion = null // Current node version for optimistic locking
let selectedNodePath = null // 現在選択されているノードのパス (例: "1-2-5")
let selectedNodeElement = null // 現在選択されているDOM要素
let expandedNodes = new Set()
let expandedNodePaths = new Set()
let searchQuery = ''
let searchResults = []
let searchPopupVisible = false
let searchScope = 'root'
let searchMatchMode = 'and'
let searchOnlyTitle = false
let activeSearchMarks = []
let activeSearchPreviewMarks = []
let currentSearchHitIndex = 0
let pendingSearchHighlight = null
let contentSearchMarks = [] // ノード内容検索のハイライト要素
let contentSearchHitIndex = 0
let clipboard = null // コピー/カットしたノードのID
let clipboardMode = null // 'copy' or 'cut'
let clipboardSourceParentId = undefined // カット元の親ID（rootはnull、未設定はundefined）
let currentRootNodeId = null // Current tree's root node ID
let currentTrashRootNodeId = null // Current tree's trash root node ID
let treeViewMode = 'normal' // 'normal' or 'reverse' or 'trash'
let reverseInitialExpandedForNodeId = null
// 逆ツリーへ切り替える直前の通常表示の選択パス。戻ったとき同じ位置を選び直す
// （無いと同じIDの先頭の要素が選ばれ、それが閉じた親の中だと全ての祖先が展開される）
let normalViewSelectedNodePath = null
let nodeNavHistory = []
let nodeNavHistoryIndex = -1
let isHistoryNavigating = false
let isDirty = false // 未保存の変更があるかどうか
let initialNodeValues = null // 編集開始時の初期値
let currentEditorNodeId = null
let dirtyCheckSuppressionCount = 0
let activeEditorLoadRequestId = 0
let completedEditorLoadRequestId = 0
let editorResizeObserver = null
let editorFullscreenObserver = null
let editorWindowResizeHandler = null
let editorCodeMirrorWrapper = null
let editorFullscreenButton = null
let editorFullscreenClickHandler = null
let editorKeydownHandler = null
let editorFullscreenForcedState = null
let paneResizeInProgress = false
let editorToolbarResizeObserver = null
let editorScrollSyncHandler = null
let editorScrollSyncRafId = null
let mobileContentSwipeCleanup = null
let lastSyncedEditorHeight = null
let headerHeightSyncInitialized = false
let nodeImages = []
let activeNodeImageMenuImageId = null
let nodeImageMenuEventsInitialized = false
let nodeDetailSelectedVersion = null
let nodeDetailSelectedIsCurrent = false
let nodeDetailCurrentVersion = null
let nodeDetailPreviewCache = new Map()
let nodeDetailLoadRequestId = 0
let nodeDetailRestoreInFlight = false
let nodeDetailNodeId = null
// 履歴一覧の全行(current行 + snapshot行)。比較オーバーレイの旧/新ラベル表示に使う
let nodeDetailHistoryItems = []
// ラジオで選択した比較対象の版。比較の基準は「行選択」、比較相手がこの版
let nodeDetailCompareVersion = null
let nodeDetailCompareInFlight = false
let isSiblingReorderInFlight = false
let currentDisplayTree = []
const DEFAULT_TREE_HEADER_HEIGHT = 48
// 本文エリア下端とスクロール領域下端のすき間
const EDITOR_CONTENT_BOTTOM_GAP = 8
// モバイルでの本文エリアの高さ（ビューポート比）。CSS の #editor-pane { min-height: 55vh } に合わせる
const MOBILE_EDITOR_VIEWPORT_RATIO = 0.55
// モバイルで本文を全画面に切り替えるスワイプの移動量（px）
const MOBILE_CONTENT_SWIPE_THRESHOLD = 24
// ホイールのイベント間隔がこれより空いたら別の操作とみなす（ms）
const MOBILE_WHEEL_GESTURE_GAP_MS = 250
// bytemd の FullScreen / OffScreen アイコン path（全画面ボタンの識別に使う）
const BYTEMD_FULLSCREEN_ICON_PATHS = new Set([
  'M33 6h9v9M42 33v9h-9M15 42H6v-9M6 15V6h9',  // enter fullscreen
  'M33 6v9h9M15 6v9H6M15 42v-9H6M33 42v-9h8.9' // exit fullscreen
])
const MD_PREVIEW_PREF_KEY = 'zeeta_md_preview_enabled'
const PRINT_ORIENTATION_PREF_KEY = 'zeeta.print.orientation'
const RENDER_CONFIG_STORAGE_KEY = 'zeeta.render.config'
const NODE_DRAFT_STORAGE_PREFIX = 'zeeta.node-draft.v1:'
const NODE_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_CHILD_SORT_MODE = 'manual'
const DEFAULT_CHILD_SORT_DIRECTION = 'asc'
const DEFAULT_RENDER_CONFIG = {
  preloadDescendantDepth: 2,
  maxRenderItemsPerTree: 2400,
  maxRenderPathsPerNode: 120
}
let renderConfig = { ...DEFAULT_RENDER_CONFIG }
let draftSaveTimer = null
const promptedDraftKeys = new Set()
const RELATION_TYPE_ICON_MAP = {
  1: '•',
  3: '→'
}

function clampInteger(value, min, max, fallback) {
  const numberValue = Number(value)
  if (!Number.isFinite(numberValue)) return fallback
  const integerValue = Math.floor(numberValue)
  return Math.max(min, Math.min(max, integerValue))
}

function suppressDirtyCheck() {
  dirtyCheckSuppressionCount += 1
}

function resumeDirtyCheck() {
  dirtyCheckSuppressionCount = Math.max(0, dirtyCheckSuppressionCount - 1)
}

function isDirtyCheckSuppressed() {
  // renderEditor 内の直接抑止に加え、最新のエディタロードが未完了の間も抑止する。
  // 追い越されたロードの遅い完了では抑止を延長しない（実編集が確認なしで破棄されるのを防ぐ）。
  if (dirtyCheckSuppressionCount > 0) return true
  return completedEditorLoadRequestId < activeEditorLoadRequestId
}

function beginEditorLoad() {
  return ++activeEditorLoadRequestId
}

function finishEditorLoad(requestId) {
  if (Number.isInteger(requestId)) {
    completedEditorLoadRequestId = Math.max(completedEditorLoadRequestId, requestId)
  }
}

function isLatestEditorLoad(requestId) {
  return requestId === activeEditorLoadRequestId
}

function getNodeDraftKey(treeId = currentTreeId, nodeId = currentEditorNodeId) {
  if (!currentUser?.id || !treeId || !nodeId) return null
  return `${NODE_DRAFT_STORAGE_PREFIX}${currentUser.id}:${treeId}:${nodeId}`
}

function clearNodeDraft(treeId = currentTreeId, nodeId = currentEditorNodeId) {
  const key = getNodeDraftKey(treeId, nodeId)
  if (!key) return
  try {
    localStorage.removeItem(key)
  } catch (error) {
    console.error('Failed to clear node draft:', error)
  }
}

function persistCurrentNodeDraft() {
  const key = getNodeDraftKey()
  const snapshot = captureEditorSnapshot()
  if (!key || !snapshot) return false

  const hasChanges = initialNodeValues && (
    snapshot.title !== initialNodeValues.title ||
    snapshot.content !== initialNodeValues.content ||
    snapshot.author_user_id !== initialNodeValues.author_user_id
  )
  if (!hasChanges && !isDirty) return false

  try {
    localStorage.setItem(key, JSON.stringify({
      ...snapshot,
      user_id: currentUser.id,
      tree_id: currentTreeId,
      node_id: currentEditorNodeId,
      version: selectedNodeVersion,
      saved_at: Date.now()
    }))
    return true
  } catch (error) {
    console.error('Failed to persist node draft:', error)
    return false
  }
}

function scheduleNodeDraftSave() {
  if (draftSaveTimer) clearTimeout(draftSaveTimer)
  draftSaveTimer = setTimeout(() => {
    draftSaveTimer = null
    if (isDirty) persistCurrentNodeDraft()
    else clearNodeDraft()
  }, 250)
}

function cleanupExpiredNodeDrafts() {
  const now = Date.now()
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index)
    if (!key?.startsWith(NODE_DRAFT_STORAGE_PREFIX)) continue
    try {
      const draft = JSON.parse(localStorage.getItem(key) || 'null')
      if (!draft?.saved_at || now - draft.saved_at > NODE_DRAFT_TTL_MS) localStorage.removeItem(key)
    } catch {
      localStorage.removeItem(key)
    }
  }
}

function restoreNodeDraftIfAvailable(node) {
  const key = getNodeDraftKey(currentTreeId, node?.id)
  if (!key || promptedDraftKeys.has(key)) return

  let draft
  try {
    draft = JSON.parse(localStorage.getItem(key) || 'null')
  } catch {
    localStorage.removeItem(key)
    return
  }
  if (!draft || Date.now() - draft.saved_at > NODE_DRAFT_TTL_MS) {
    localStorage.removeItem(key)
    return
  }
  promptedDraftKeys.add(key)
  if (draft.title === node.title && draft.content === (node.content || '') && Number(draft.author_user_id) === Number(node.author_user_id)) {
    localStorage.removeItem(key)
    return
  }

  const hasVersionConflict = Number(draft.version) !== Number(node.version)
  const message = hasVersionConflict
    ? t('editor.draftRestoreConflictConfirm')
    : t('editor.draftRestoreConfirm')
  if (!confirm(message)) {
    localStorage.removeItem(key)
    return
  }

  document.getElementById('node-title').value = draft.title || ''
  if (window.currentEditor) window.currentEditor.value(draft.content || '')
  const author = document.getElementById('node-author')
  if (author && draft.author_user_id) author.value = String(draft.author_user_id)
  if (hasVersionConflict) selectedNodeVersion = draft.version
  checkDirty()
}

window.ZeetaEditorDrafts = {
  persistCurrentDraft: persistCurrentNodeDraft,
  resetDraftPrompts: () => promptedDraftKeys.clear()
}

function readStoredRenderConfig() {
  try {
    const raw = localStorage.getItem(RENDER_CONFIG_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (_error) {
    return {}
  }
}

function loadRenderConfig() {
  const params = new URLSearchParams(window.location.search)
  const stored = readStoredRenderConfig()
  const nextConfig = {
    preloadDescendantDepth: clampInteger(
      params.get('preload_depth') ?? stored.preloadDescendantDepth,
      0,
      4,
      DEFAULT_RENDER_CONFIG.preloadDescendantDepth
    ),
    maxRenderItemsPerTree: clampInteger(
      params.get('max_items') ?? stored.maxRenderItemsPerTree,
      200,
      20000,
      DEFAULT_RENDER_CONFIG.maxRenderItemsPerTree
    ),
    maxRenderPathsPerNode: clampInteger(
      params.get('max_paths') ?? stored.maxRenderPathsPerNode,
      5,
      500,
      DEFAULT_RENDER_CONFIG.maxRenderPathsPerNode
    )
  }
  renderConfig = nextConfig
  return renderConfig
}

function rebuildRelationIndexes() {
  relationChildrenByParent = new Map()
  relationParentsByChild = new Map()
  relations.forEach(rel => {
    const parentId = rel.parent_node_id
    const childId = rel.child_node_id
    if (parentId) {
      const children = relationChildrenByParent.get(parentId) || []
      children.push(rel)
      relationChildrenByParent.set(parentId, children)
    }
    if (childId) {
      const parents = relationParentsByChild.get(childId) || []
      parents.push(rel)
      relationParentsByChild.set(childId, parents)
    }
  })
}

function setRelations(nextRelations) {
  relations = Array.isArray(nextRelations) ? nextRelations : []
  rebuildRelationIndexes()
}

// ===============================
// ユーティリティ関数
// ===============================

// ローディングオーバーレイの表示/非表示
// 起動時の読み込み中表示は、読み込みが長引いたときだけ出す。
// すぐ出すと、ツリー切替のアニメーションに暗い覆いが写り込んで画面が一瞬暗くなる
const INITIAL_LOADING_DELAY_MS = 400
let initialLoadingTimer = null

function showLoadingAfterDelay(delayMs) {
  clearTimeout(initialLoadingTimer)
  initialLoadingTimer = setTimeout(showLoading, delayMs)
}

function showLoading() {
  let overlay = document.getElementById('loading-overlay')
  if (!overlay) {
    overlay = document.createElement('div')
    overlay.id = 'loading-overlay'
    overlay.innerHTML = `
      <div class="loading-spinner">
        <div class="spinner"></div>
        <div class="loading-text">${t('editor.processing')}</div>
      </div>
    `
    document.body.appendChild(overlay)
  }
  overlay.style.display = 'flex'
}

function hideLoading() {
  clearTimeout(initialLoadingTimer)
  const overlay = document.getElementById('loading-overlay')
  if (overlay) {
    overlay.style.display = 'none'
  }
}

function isMarkdownPreviewPreferred() {
  try {
    return localStorage.getItem(MD_PREVIEW_PREF_KEY) !== '0'
  } catch (_error) {
    return true
  }
}

function setMarkdownPreviewPreferred(enabled) {
  try {
    localStorage.setItem(MD_PREVIEW_PREF_KEY, enabled ? '1' : '0')
  } catch (_error) {
    // noop
  }
}

function applyMarkdownPreviewPreference() {
  if (!window.currentEditor) return
  const shouldPreview = isMarkdownPreviewPreferred()
  const isEmpty = !window.currentEditor.value().trim()
  const targetPreview = shouldPreview && !isEmpty
  const isPreviewActive = typeof window.currentEditor.isPreviewActive === 'function'
    ? window.currentEditor.isPreviewActive()
    : false
  if (targetPreview !== isPreviewActive) {
    window.currentEditor.togglePreview()
  }
}

function normalizePrintOrientation(value) {
  return value === 'landscape' ? 'landscape' : 'portrait'
}

function getSavedPrintOrientation() {
  try {
    return normalizePrintOrientation(localStorage.getItem(PRINT_ORIENTATION_PREF_KEY))
  } catch (_error) {
    return 'portrait'
  }
}

function setSavedPrintOrientation(orientation) {
  try {
    localStorage.setItem(PRINT_ORIENTATION_PREF_KEY, normalizePrintOrientation(orientation))
  } catch (_error) {
    // noop
  }
}

function ensureCaretStyles() {
  if (document.getElementById('caret-style')) return
  const style = document.createElement('style')
  style.id = 'caret-style'
  style.textContent = `
    .toggle-btn { width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; margin-right: 6px; border: 0; border-radius: 4px; background: transparent; padding: 0; color: #9ca3af; cursor: pointer; flex: 0 0 auto; }
    .toggle-btn:hover { background: #f8fafc; color: #6b7280; }
    .toggle-btn:focus-visible { outline: 2px solid #93c5fd; outline-offset: 1px; }
    .toggle-spacer { width: 18px; height: 18px; display: inline-block; margin-right: 6px; flex: 0 0 auto; }
    .toggle-icon { transition: transform 0.15s ease; display: inline-block; font-size: 10px; color: currentColor; pointer-events: none; }
    .toggle-icon.caret-expanded { transform: rotate(90deg); }
    .tree-multi-parent-badge {
      display: inline-flex;
      align-items: center;
      gap: 0;
      padding: 1px 7px;
      border-radius: 999px;
      border: 1px solid rgba(148, 163, 184, 0.28);
      background: rgba(248, 250, 252, 0.95);
      color: #64748b;
      font-size: 10px;
      line-height: 1.2;
      white-space: nowrap;
    }
    .search-hit-highlight { background: #fde68a; border-radius: 2px; }
    .search-hit-preview-highlight { background: #fde68a; border-radius: 2px; padding: 0 1px; }
    .search-hit-preview-highlight.current { background: #fb923c; color: #1f2937; box-shadow: 0 0 0 1px #c2410c; }
    /* ダークテーマ上書き */
    html.theme-dark .toggle-btn:hover { background: #111827; color: #9ca3af; }
    html.theme-dark .tree-multi-parent-badge {
      border-color: rgba(148, 163, 184, 0.28);
      background: rgba(17, 24, 39, 0.95);
      color: #9ca3af;
    }
    html.theme-dark .search-hit-highlight { background: rgba(251, 191, 36, 0.4); color: #f3f4f6; }
    html.theme-dark .search-hit-preview-highlight { background: rgba(251, 191, 36, 0.4); color: #f3f4f6; }
  `
  document.head.appendChild(style)
}

function ensureNodeImageUiStyles() {
  if (document.getElementById('node-image-style')) return
  const style = document.createElement('style')
  style.id = 'node-image-style'
  style.textContent = `
    .node-image-list { display:flex; align-items:center; gap:6px; flex-wrap:wrap; justify-content:flex-end; padding-right:12px; overflow:visible; }
    .node-image-icon-item { position:relative; width:24px; height:24px; border:1px solid #d1d5db; border-radius:6px; background:#fff; display:flex; align-items:center; justify-content:center; cursor:pointer; color:#4b5563; }
    .node-image-icon-item.is-draggable { cursor:grab; }
    .node-image-icon-item[aria-expanded="true"] { border-color:#2563eb; box-shadow:0 0 0 2px rgba(37, 99, 235, 0.15); }
    .node-image-icon-item > i { font-size:20px; line-height:1; }
    .node-image-icon-item:hover { border-color:#9ca3af; }
    .node-image-menu { display:none; position:absolute; top:30px; right:0; width:240px; padding:8px; background:#fff; border:1px solid #dbe4f0; border-radius:10px; box-shadow:0 14px 32px rgba(15, 23, 42, 0.16); z-index:120; color:#1f2937; }
    .node-image-menu.active { display:block; }
    .node-image-menu-action { width:100%; display:flex; align-items:center; gap:8px; padding:7px 9px; border:none; border-radius:8px; background:transparent; color:#1f2937; font-size:13px; text-align:left; cursor:pointer; }
    .node-image-menu-action:hover { background:#f3f4f6; }
    .node-image-menu-action:focus-visible { outline:2px solid #2563eb; outline-offset:2px; }
    .node-image-menu-action.is-danger { color:#b91c1c; }
    .node-image-menu-action.is-danger i { color:#dc2626; }
    .node-image-menu-action.is-disabled { color:#9ca3af; cursor:default; pointer-events:none; }
    .node-image-menu-action i { width:14px; color:#6b7280; text-align:center; flex:0 0 auto; }
    .node-image-menu-readonly { margin-top:8px; padding-top:8px; border-top:1px solid #e5e7eb; }
    .node-image-menu-label { display:block; margin-bottom:4px; font-size:10px; font-weight:700; letter-spacing:0.04em; color:#6b7280; text-transform:uppercase; }
    .node-image-menu-file-name { display:block; font-size:12px; line-height:1.5; color:#111827; white-space:normal; word-break:break-word; }
    .node-image-menu-preview-wrap { margin-top:8px; }
    .node-image-menu-preview-frame { position:relative; display:flex; align-items:center; justify-content:center; min-height:84px; max-height:180px; overflow:hidden; background:#f8fafc; border:1px solid #e5e7eb; border-radius:8px; }
    .node-image-menu-preview { display:block; max-width:100%; max-height:180px; object-fit:contain; }
    .node-image-menu-preview-fallback { display:none; padding:16px 12px; font-size:12px; line-height:1.5; color:#6b7280; text-align:center; }
    .node-image-menu-preview-frame.is-error .node-image-menu-preview { display:none; }
    .node-image-menu-preview-frame.is-error .node-image-menu-preview-fallback { display:block; }
    .node-image-drop-active .bytemd-editor { background-color:#eff6ff; }
    .node-image-drop-disabled .bytemd-editor,
    .node-image-drop-disabled .bytemd-preview { background-color:#f8fafc; box-shadow: inset 0 0 0 1px #cbd5e1; cursor:not-allowed; opacity:0.82; }
    .node-image-drop-disabled .cm-editor,
    .node-image-drop-disabled .cm-content,
    .node-image-drop-disabled .cm-scroller,
    .node-image-drop-disabled .markdown-body { cursor:not-allowed !important; }
    /* ダークテーマ上書き */
    html.theme-dark .node-image-icon-item { border-color:#4b5563; background:#1f2937; color:#d1d5db; }
    html.theme-dark .node-image-icon-item:hover { border-color:#6b7280; }
    html.theme-dark .node-image-menu { background:#1f2937; border-color:#374151; color:#e5e7eb; }
    html.theme-dark .node-image-menu-action { color:#e5e7eb; }
    html.theme-dark .node-image-menu-action:hover { background:#111827; }
    html.theme-dark .node-image-menu-action.is-danger { color:#fca5a5; }
    html.theme-dark .node-image-menu-action.is-danger i { color:#f87171; }
    html.theme-dark .node-image-menu-action i { color:#9ca3af; }
    html.theme-dark .node-image-menu-readonly { border-top-color:#374151; }
    html.theme-dark .node-image-menu-label { color:#9ca3af; }
    html.theme-dark .node-image-menu-file-name { color:#f3f4f6; }
    html.theme-dark .node-image-menu-preview-frame { background:#111827; border-color:#374151; }
    html.theme-dark .node-image-menu-preview-fallback { color:#9ca3af; }
    html.theme-dark .node-image-drop-active .bytemd-editor { background-color:rgba(59, 130, 246, 0.12); }
    html.theme-dark .node-image-drop-disabled .bytemd-editor,
    html.theme-dark .node-image-drop-disabled .bytemd-preview { background-color:#111827; box-shadow: inset 0 0 0 1px #4b5563; }
  `
  document.head.appendChild(style)
}

function initializeNodeImageMenuEvents() {
  if (nodeImageMenuEventsInitialized) return
  nodeImageMenuEventsInitialized = true

  document.addEventListener('click', (event) => {
    if (event.target.closest('.node-image-icon-item')) return
    closeNodeImageMenu()
  })

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    if (activeNodeImageMenuImageId === null) return
    closeNodeImageMenu()
  })
}

function closeNodeImageMenu() {
  const listEl = document.getElementById('node-image-list')
  if (listEl) {
    listEl.querySelectorAll('.node-image-icon-item[aria-expanded="true"]').forEach(item => {
      item.setAttribute('aria-expanded', 'false')
    })
    listEl.querySelectorAll('.node-image-menu.active').forEach(menu => {
      menu.classList.remove('active')
    })
  }
  activeNodeImageMenuImageId = null
}

function setNodeImagePreviewFallback(imageId) {
  const frame = document.querySelector(`.node-image-menu-preview-frame[data-image-id="${imageId}"]`)
  if (frame) frame.classList.add('is-error')
}

async function refreshNodeImagesAfterDelete(nodeId, editorContent) {
  nodeImages = await fetchNodeImages(nodeId)
  renderNodeImageIcons(nodeId)

  const refreshedNode = await fetchNodeById(nodeId)
  if (!refreshedNode || selectedNodeId !== nodeId || !window.currentEditor) return

  // エディタは、削除対象のタグだけを取り除いた「現在の内容」にする（未保存の編集を消さない）。
  // 保存済みの内容との差は、そのまま未保存の変更として残す
  const savedContent = refreshedNode.content || ''
  window.currentEditor.value(typeof editorContent === 'string' ? editorContent : savedContent)
  selectedNodeVersion = refreshedNode.version || selectedNodeVersion
  initialNodeValues = {
    ...(initialNodeValues || { title: refreshedNode.title || '', author_user_id: refreshedNode.author_user_id ?? null }),
    content: savedContent
  }
  checkDirty()
}

async function handleNodeImageDelete(nodeId, imageId) {
  if (!canOperateNodeImages()) return
  if (!confirm(t('editor.deleteImageConfirm'))) return
  if (!imageId) return

  closeNodeImageMenu()
  showLoading()
  try {
    const currentEditorContent = selectedNodeId === nodeId && window.currentEditor ? window.currentEditor.value() : null
    const result = await deleteNodeImage(nodeId, imageId, currentEditorContent)
    if (!result) return
    await refreshNodeImagesAfterDelete(nodeId, result.editor_content)
  } finally {
    hideLoading()
  }
}

function toggleNodeImageMenu(imageId) {
  const listEl = document.getElementById('node-image-list')
  if (!listEl) return

  const nextIsOpen = activeNodeImageMenuImageId !== imageId
  closeNodeImageMenu()
  if (!nextIsOpen) return

  const icon = listEl.querySelector(`.node-image-icon-item[data-image-id="${imageId}"]`)
  const menu = icon?.querySelector('.node-image-menu')
  if (!icon || !menu) return

  icon.setAttribute('aria-expanded', 'true')
  menu.classList.add('active')
  activeNodeImageMenuImageId = imageId
}

function buildNodePlainText(nodeId) {
  const node = getNodeById(nodeId)
  const title = node?.title ? node.title : t('editor.untitled')
  return `${title} (id:${nodeId})`
}

async function writeNodePlainTextToSystemClipboard(nodeId) {
  if (!navigator.clipboard?.writeText) return
  try {
    await navigator.clipboard.writeText(buildNodePlainText(nodeId))
  } catch (error) {
    console.warn('Failed to write plain text to system clipboard:', error)
  }
}

function setInternalClipboardByNodePath(nodeId, nodePath, nodeElement = null, mode = 'copy') {
  clipboard = nodeId
  clipboardMode = mode === 'cut' ? 'cut' : 'copy'
  const copyEl = nodeElement || document.querySelector(`.tree-item[data-node-path="${nodePath}"]`)
  const copyWrapper = copyEl?.closest('[data-node-group]')
  const copyParent = copyWrapper?.parentElement
  if (copyParent && copyParent.id !== 'tree-container') {
    clipboardSourceParentId = copyParent.dataset.parent
  } else {
    clipboardSourceParentId = getCurrentViewRootNodeId()
  }
}

function getCurrentViewRootNodeId() {
  if (treeViewMode === 'trash') return currentTrashRootNodeId
  return currentRootNodeId
}

function setTreeViewTabActive(viewMode) {
  document.querySelectorAll('.tree-view-tab').forEach(t => t.classList.remove('active'))
  const activeTab = document.querySelector(`.tree-view-tab[data-view="${viewMode}"]`)
  if (activeTab) activeTab.classList.add('active')
}

function updateNodeHistoryButtonsState() {
  const backBtn = document.getElementById('history-back-btn')
  const forwardBtn = document.getElementById('history-forward-btn')
  const canGoBack = nodeNavHistoryIndex > 0
  const canGoForward = nodeNavHistoryIndex >= 0 && nodeNavHistoryIndex < nodeNavHistory.length - 1

  if (backBtn) {
    backBtn.disabled = !canGoBack
    backBtn.style.opacity = canGoBack ? '1' : '0.45'
    backBtn.style.cursor = canGoBack ? 'pointer' : 'not-allowed'
  }
  if (forwardBtn) {
    forwardBtn.disabled = !canGoForward
    forwardBtn.style.opacity = canGoForward ? '1' : '0.45'
    forwardBtn.style.cursor = canGoForward ? 'pointer' : 'not-allowed'
  }
}

function isSameNodeHistoryEntry(a, b) {
  if (!a || !b) return false
  return a.viewMode === b.viewMode &&
    a.nodeId === b.nodeId &&
    a.nodePath === b.nodePath &&
    (a.reverseRootNodeId ?? null) === (b.reverseRootNodeId ?? null)
}

function pushNodeHistory(entry) {
  if (isHistoryNavigating || !entry || !entry.nodeId || !entry.nodePath) return
  const current = nodeNavHistoryIndex >= 0 ? nodeNavHistory[nodeNavHistoryIndex] : null
  if (current && isSameNodeHistoryEntry(current, entry)) {
    updateNodeHistoryButtonsState()
    return
  }
  if (nodeNavHistoryIndex < nodeNavHistory.length - 1) {
    nodeNavHistory = nodeNavHistory.slice(0, nodeNavHistoryIndex + 1)
  }
  nodeNavHistory.push(entry)
  nodeNavHistoryIndex = nodeNavHistory.length - 1
  updateNodeHistoryButtonsState()
}

function getCurrentDisplayNodeId() {
  if (selectedNodeElement?.dataset?.nodeId) {
    return selectedNodeElement.dataset.nodeId
  }
  if (selectedNodePath) {
    const fromPath = String(selectedNodePath).split('-').pop()
    if (fromPath) return fromPath
  }
  if (selectedNodeId) return selectedNodeId
  return null
}

function loadEditorForNode(nodeId, options = {}) {
  const { onRendered = null } = options
  if (!nodeId) return

  const editorLoadRequestId = beginEditorLoad()
  fetchNodeById(nodeId).then(node => {
    if (!node) return
    return axios.get(`/api/trees/${currentTreeId}/nodes/${nodeId}/parents`).then(parentsRes => {
      if (!isLatestEditorLoad(editorLoadRequestId)) return
      const parents = parentsRes.data.success ? parentsRes.data.data : []
      renderEditor(node, parents)
      if (typeof onRendered === 'function') {
        onRendered(node, parents)
      }
    })
  }).catch((error) => {
    console.error('Failed to load editor node:', error)
  }).finally(() => {
    finishEditorLoad(editorLoadRequestId)
  })
}

function captureEditorSnapshot() {
  const titleEl = document.getElementById('node-title')
  const authorEl = document.getElementById('node-author')
  if (!titleEl || !authorEl) return null

  return {
    title: titleEl.value || '',
    content: window.currentEditor ? window.currentEditor.value() : '',
    author_user_id: parseInt(authorEl.value) || null
  }
}

async function navigateNodeHistory(direction) {
  const delta = direction === 'back' ? -1 : 1
  const nextIndex = nodeNavHistoryIndex + delta
  if (nextIndex < 0 || nextIndex >= nodeNavHistory.length) {
    updateNodeHistoryButtonsState()
    return
  }

  const okToProceed = await runWithUnsavedGuard(async () => {})
  if (!okToProceed) return

  const prevIndex = nodeNavHistoryIndex
  nodeNavHistoryIndex = nextIndex
  const result = await applyNodeHistoryEntry(nodeNavHistory[nextIndex])
  if (result === false) {
    // ノードが実際に存在しない場合のみエラー表示する
    nodeNavHistoryIndex = prevIndex
    showToast(t('editor.historyNodeNotFound'), 'error')
  }
  // result === null は後続の操作に追い越された場合。その操作が状態を更新済みのため何もしない
  updateNodeHistoryButtonsState()
}

async function navigateNodeHistoryBack() {
  await navigateNodeHistory('back')
}

async function navigateNodeHistoryForward() {
  await navigateNodeHistory('forward')
}

async function applyNodeHistoryEntry(entry) {
  if (!entry || !entry.nodeId) return false
  isHistoryNavigating = true
  try {
    hideNormalViewMenu()
    treeViewMode = entry.viewMode === 'reverse' ? 'reverse' : (entry.viewMode === 'trash' ? 'trash' : 'normal')
    setTreeViewTabActive(treeViewMode)

    if (treeViewMode === 'reverse') {
      const reverseRootNodeId = entry.reverseRootNodeId || entry.nodeId
      selectedNodeId = reverseRootNodeId
      if (reverseInitialExpandedForNodeId !== reverseRootNodeId) {
        expandNodeDirectChildren(reverseRootNodeId, String(reverseRootNodeId))
        reverseInitialExpandedForNodeId = reverseRootNodeId
      }
      renderTree()

      const targetByPath = entry.nodePath
        ? document.querySelector(`.tree-item[data-node-path="${entry.nodePath}"]`)
        : null
      const targetEl = targetByPath || document.querySelector(`.tree-item[data-node-id="${entry.nodeId}"]`)
      if (!targetEl) return false

      const targetNodeId = targetEl.dataset.nodeId
      const targetPath = targetEl.dataset.nodePath
      if (!targetNodeId || !targetPath) return false

      selectedNodeElement = targetEl
      selectedNodePath = targetPath
      document.querySelectorAll('.tree-item.active').forEach(el => el.classList.remove('active'))
      document.querySelectorAll('.tree-item.duplicate-active').forEach(el => el.classList.remove('duplicate-active'))
      targetEl.classList.add('active')
      document.querySelectorAll(`.tree-item[data-node-id="${targetNodeId}"]`).forEach(el => {
        if (el.dataset.nodePath !== targetPath) el.classList.add('duplicate-active')
      })

      const editorLoadRequestId = beginEditorLoad()
      try {
        const node = await fetchNodeById(targetNodeId)
        if (!node) return false
        const parentsRes = await axios.get(`/api/trees/${currentTreeId}/nodes/${targetNodeId}/parents`)
        if (!isLatestEditorLoad(editorLoadRequestId)) return null // 後続の操作に追い越された（未検出ではない）
        const parents = parentsRes.data.success ? parentsRes.data.data : []
        renderEditor(node, parents)
        return true
      } finally {
        finishEditorLoad(editorLoadRequestId)
      }
    }

    renderTree()
    return await selectNode(entry.nodeId, entry.nodePath, { recordHistory: false })
  } finally {
    isHistoryNavigating = false
  }
}

class ByteMDWrapper {
  constructor(container, initialValue, plugins) {
    this._container = container
    this._value = initialValue || ''
    this._changeHandlers = []
    this._previewOnly = false
    this._readOnly = false

    this._editor = new bytemd.Editor({
      target: container,
      props: {
        value: this._value,
        plugins: plugins || [],
        mode: 'split',
      }
    })

    const GFM_TABLE_ICON_PATH = 'M39.3 6H8.7A2.7 2.7 0 0 0 6 8.7v30.6A2.7 2.7 0 0 0 8.7 42h30.6a2.7 2.7 0 0 0 2.7-2.7V8.7A2.7 2.7 0 0 0 39.3 6Z'
    const _TABLE_EDITOR_ICON_PATH = typeof TABLE_EDITOR_ICON_PATH !== 'undefined' ? TABLE_EDITOR_ICON_PATH : ''

    // Toolbar icon reorder: write-only, preview-only, fullscreen, TOC, table editor, then the rest
    setTimeout(() => {
      const toolbar = container.querySelector('.bytemd-toolbar')
      if (!toolbar) return
      const icons = [...toolbar.querySelectorAll('.bytemd-toolbar-icon')]
      if (icons.length === 0) return

      const getFirstPath = (icon) => icon.querySelector('path')?.getAttribute('d') || ''

      const ITALIC_ICON_PATH = 'M20 6h16M12 42h16M29 5.952 19 42'

      // TOC (AlignTextLeftOne) は2つの path を持ち、固有の内側ラインが2番目の path にある。
      // getFirstPath だけでは外枠と区別できないため、全 path を検索する。
      const allPaths = (icon) => [...icon.querySelectorAll('path')].map(p => p.getAttribute('d'))
      const getIconPriority = (icon) => {
        const fp = getFirstPath(icon)
        if (fp === 'M42 6v36') return 0 // write-only
        if (fp === 'M6 6v36') return 1  // preview-only
        if (fp === 'M33 6h9v9M42 33v9h-9M15 42H6v-9M6 15V6h9') return 2 // fullscreen enter
        if (fp === 'M33 6v9h9M15 6v9H6M15 42v-9H6M33 42v-9h8.9') return 2  // fullscreen exit
        if (allPaths(icon).includes('M26 24H14M34 15H14M32 33H14')) return 3 // TOC（全 path から検索）
        return undefined
      }

      icons.sort((a, b) => {
        const pa = getIconPriority(a)
        const pb = getIconPriority(b)
        if (pa !== undefined && pb !== undefined) return pa - pb
        if (pa !== undefined) return -1
        if (pb !== undefined) return 1
        return 0
      })

      const REMOVE_PATHS = new Set([
        GFM_TABLE_ICON_PATH,               // GFM テーブル（カスタムボタンに置き換え済み）
        'M12 5v38M36 5v38M12 24h24',       // H (Heading) ボタン
        'M17 6h14v9H17zM6 33h14v9H6zM28 33h14v9H28z', // Mermaid (品) ボタン
      ])

      icons.forEach(icon => {
        if (REMOVE_PATHS.has(getFirstPath(icon))) {
          icon.remove()
        } else {
          toolbar.appendChild(icon)
        }
      })

      // テーブルエディタボタンを italic の直後に移動
      const allIcons = [...toolbar.querySelectorAll('.bytemd-toolbar-icon')]
      const tableEditorBtn = allIcons.find(ic =>
        [...ic.querySelectorAll('path')].some(p => p.getAttribute('d') === _TABLE_EDITOR_ICON_PATH)
      )
      const italicBtn = allIcons.find(ic => getFirstPath(ic) === ITALIC_ICON_PATH)
      if (tableEditorBtn && italicBtn) italicBtn.after(tableEditorBtn)
    }, 300)

    this._editor.$on('change', (e) => {
      this._value = e.detail.value
      this._editor.$set({ value: e.detail.value })
      this._changeHandlers.forEach(fn => { try { fn() } catch (_) {} })
    })

    // Toolbar icon click while in preview-only: exit preview-only (don't touch localStorage/toggle)
    container.addEventListener('click', (e) => {
      const icon = e.target.closest('.bytemd-toolbar-icon')
      if (!icon) return

      // TOC（目次）ボタンは preview を抜けない。
      // bytemd の AlignTextLeftOne アイコン内側 path で識別（bytemd 全体でこの d は TOC のみ）。
      const isTocIcon = [...icon.querySelectorAll('path')].some(
        p => p.getAttribute('d') === 'M26 24H14M34 15H14M32 33H14'
      )
      if (isTocIcon) return

      // 全画面表示ボタンも preview を抜けない（preview/edit 状態を維持したまま fullscreen を切り替える）。
      // bytemd の FullScreen / OffScreen アイコン path で識別。
      const isFullscreenIcon = [...icon.querySelectorAll('path')].some(
        p => BYTEMD_FULLSCREEN_ICON_PATHS.has(p.getAttribute('d'))
      )
      if (isFullscreenIcon) return

      // テーブルエディタボタン: preview-only 中でも1クリックで開く
      // 通常時は ByteMD の actions.click() に任せる（二重起動防止）
      const _isTableEditorIcon = [...icon.querySelectorAll('path')].some(
        p => p.getAttribute('d') === _TABLE_EDITOR_ICON_PATH
      )
      if (_isTableEditorIcon && this._previewOnly) {
        this.exitPreviewOnly()
        if (typeof openTableEditorFromCurrentSelection === 'function') openTableEditorFromCurrentSelection()
        e.stopImmediatePropagation()
        return
      }

      if (this._previewOnly) {
        // 我々のCSS preview-onlyモード: 任意のツールバークリックでexitPreviewOnly
        this.exitPreviewOnly()
        return
      }

      // ByteMD内部previewモード: write-onlyボタン直接クリック時もスクロール同期する
      // exitPreviewOnly()経由だと二重クリックになるため、ここでスクロールのみ処理
      if (this.isPreviewActive() && icon.querySelector('path')?.getAttribute('d') === 'M42 6v36') {
        const previewEl = this._container.querySelector('.bytemd-preview')
        const scrollTop = previewEl ? previewEl.scrollTop : 0
        const maxScroll = previewEl ? Math.max(1, previewEl.scrollHeight - previewEl.clientHeight) : 1
        const scrollRatio = scrollTop / maxScroll
        if (scrollRatio > 0.01) {
          const self = this
          setTimeout(() => {
            if (window.currentEditor !== self) return
            const cm = self._getLegacyCodeMirror()
            if (cm && typeof cm.scrollTo === 'function') {
              if (typeof cm.refresh === 'function') cm.refresh()
              const info = cm.getScrollInfo()
              const targetY = scrollRatio * Math.max(0, info.height - info.clientHeight)
              cm.scrollTo(null, targetY)
            }
          }, 100)
        }
      }
    }, true)

    // Fullscreen: teleport .bytemd to document.body to escape ancestor CSS constraints
    this._fsOriginalParent = null
    this._fsOriginalNext = null
    const bytemdEl = container.querySelector('.bytemd')
    if (bytemdEl) {
      this._fsObserver = new MutationObserver(() => {
        if (bytemdEl.classList.contains('bytemd-fullscreen')) {
          if (bytemdEl.parentNode !== document.body) {
            this._fsOriginalParent = bytemdEl.parentNode
            this._fsOriginalNext = bytemdEl.nextSibling
            document.body.appendChild(bytemdEl)
          }
        } else {
          if (this._fsOriginalParent && bytemdEl.parentNode !== this._fsOriginalParent) {
            this._fsOriginalParent.insertBefore(bytemdEl, this._fsOriginalNext)
            this._fsOriginalParent = null
            this._fsOriginalNext = null
          }
        }
      })
      this._fsObserver.observe(bytemdEl, { attributes: true, attributeFilter: ['class'] })
    }

    const self = this
    this.codemirror = {
      on(event, fn) {
        if (event === 'change') self._changeHandlers.push(fn)
      },
      off(event, fn) {
        if (event === 'change') {
          self._changeHandlers = self._changeHandlers.filter(f => f !== fn)
        }
      },
      setOption(key, val) {
        if (key === 'readOnly') {
          self._readOnly = !!val
          self._container.style.pointerEvents = val ? 'none' : ''
          self._container.style.opacity = val ? '0.7' : ''
        }
      },
      getOption(key) {
        if (key === 'fullScreen') {
          return !!self._container.querySelector('.bytemd-fullscreen')
        }
        return null
      },
      refresh() { /* ByteMD auto-updates */ },
      focus() {
        self.focusEditor()
      },
      scrollIntoView() {},
      getWrapperElement() {
        return self._container
      },
      getDoc() {
        return {
          getValue() { return self._value },
          posFromIndex() { return { line: 0, ch: 0 } },
          markText() { return { clear() {} } },
          setSelection() {},
          replaceSelection(text) { self._insertText(text) },
          setCursor() {}
        }
      }
    }
  }

  value(content) {
    if (content === undefined) return this._value
    this._value = content
    this._editor.$set({ value: content })
    return this
  }

  isPreviewActive() {
    if (this._previewOnly) return true
    const editorEl = this._container.querySelector('.bytemd-editor')
    if (!editorEl) return true
    return window.getComputedStyle(editorEl).display === 'none'
  }

  focusEditor() {
    const view = this._getEditorView()
    if (view && typeof view.focus === 'function') {
      view.focus()
      if (this._container.contains(document.activeElement)) return true
    }

    const cmContent = this._container.querySelector('.cm-content')
    if (cmContent && typeof cmContent.focus === 'function') {
      cmContent.focus()
      if (this._container.contains(document.activeElement)) return true
    }

    const cmEditor = this._container.querySelector('.cm-editor')
    if (cmEditor && typeof cmEditor.focus === 'function') {
      cmEditor.focus()
      if (this._container.contains(document.activeElement)) return true
    }

    const textInput = this._container.querySelector('.bytemd-editor textarea, .bytemd-editor input, .bytemd-editor [contenteditable="true"]')
    if (textInput && typeof textInput.focus === 'function') {
      textInput.focus()
      if (this._container.contains(document.activeElement)) return true
    }

    return false
  }

  exitPreviewOnly() {
    if (!this.isPreviewActive()) return false

    // previewのスクロール比率を保存（exitの前に読む）
    const previewEl = this._container.querySelector('.bytemd-preview')
    const previewScrollTop = previewEl ? previewEl.scrollTop : 0
    const maxPreviewScroll = previewEl
      ? Math.max(1, previewEl.scrollHeight - previewEl.clientHeight)
      : 1
    const scrollRatio = previewScrollTop / maxPreviewScroll

    // 我々の _previewOnly 機構を解除（CSSクラス除去でエディタが表示に戻る）
    if (this._previewOnly) {
      this._previewOnly = false
      this._container.classList.remove('bytemd-preview-only')
    }

    // ByteMD組み込みpreviewモードを解除（editorEl.style.display='none' + bytemd-split削除が判明）
    const editorEl = this._container.querySelector('.bytemd-editor')
    if (editorEl && editorEl.style.display === 'none') {
      editorEl.style.display = ''
    }

    // eキーはsplitではなくwrite-onlyモード（エディタ全幅、preview非表示）にする
    // ByteMDのpreview onlyと対称的に: previewEl.style.display='none' + bytemd-split削除
    const previewPane = this._container.querySelector('.bytemd-preview')
    const bytemdEl = this._container.querySelector('.bytemd')
    if (previewPane) previewPane.style.display = 'none'
    if (editorEl) editorEl.style.width = '100%'
    if (bytemdEl) bytemdEl.classList.remove('bytemd-split')

    // ByteMDのwrite-onlyボタンをクリックしてByteMLの内部状態を同期する
    // write-onlyボタンはSVG path 'M42 6v36'（右境界線アイコン）で識別
    // これによりwrite-onlyボタンが1回で効くようになる（現在は2回必要）
    const allIcons = [...this._container.querySelectorAll('.bytemd-toolbar-icon')]
    const writeOnlyBtn = allIcons.find(el =>
      el.querySelector('path')?.getAttribute('d') === 'M42 6v36'
    )
    if (writeOnlyBtn) writeOnlyBtn.click()

    // ガード付きfocus（古いエディタのタイムアウトが新エディタにフォーカスしてeキーを妨げないよう防止）
    const focusIfCurrent = () => {
      if (window.currentEditor !== this) return
      this.focusEditor()
    }

    requestAnimationFrame(() => { focusIfCurrent() })
    setTimeout(focusIfCurrent, 30)
    setTimeout(focusIfCurrent, 120)

    // ByteMDはCodeMirror 5を使用。CM5 APIで安定的にスクロール位置を設定する。
    // scrollTop直接設定ではCM5の内部スクロール状態が更新されず、
    // CM5の内部イベントでカーソル位置にリセットされてしまうため。
    if (scrollRatio > 0.01) {
      setTimeout(() => {
        if (window.currentEditor !== this) return
        const cm = this._getLegacyCodeMirror()
        if (cm && typeof cm.scrollTo === 'function') {
          // refresh()でCM5に再測定を促してから、scrollTo()で内部状態ごとスクロール
          if (typeof cm.refresh === 'function') cm.refresh()
          const info = cm.getScrollInfo()
          const targetY = scrollRatio * Math.max(0, info.height - info.clientHeight)
          cm.scrollTo(null, targetY)
        } else {
          // CM6またはDOMフォールバック
          const scroller = document.querySelector('.cm-scroller')
            || document.querySelector('.CodeMirror-scroll')
          const maxScroll = scroller ? Math.max(0, scroller.scrollHeight - scroller.clientHeight) : 0
          if (scroller && maxScroll > 0) scroller.scrollTop = scrollRatio * maxScroll
        }
      }, 100)
    }
    return true
  }

  togglePreview() {
    if (this._previewOnly) {
      this.exitPreviewOnly()
    } else {
      // ByteMDのpreview-onlyボタンをクリックしてツールバーの表示を同期する
      // preview-onlyボタンはSVG path 'M6 6v36'（左境界線アイコン）で識別
      // _previewOnly=trueにする前にクリックすることで、クリックリスナーがexitPreviewOnly()を
      // 呼び出さないようにする
      const allIcons = [...this._container.querySelectorAll('.bytemd-toolbar-icon')]
      const previewOnlyBtn = allIcons.find(el =>
        el.querySelector('path')?.getAttribute('d') === 'M6 6v36'
      )
      if (previewOnlyBtn) previewOnlyBtn.click()
      this._previewOnly = true
      this._container.classList.add('bytemd-preview-only')
    }
  }

  toTextArea() {
    if (this._fsObserver) { this._fsObserver.disconnect(); this._fsObserver = null }
    // Return .bytemd to original parent before destroying
    const bytemdEl = this._fsOriginalParent ? document.body.querySelector('.bytemd') : null
    if (bytemdEl && this._fsOriginalParent) {
      this._fsOriginalParent.insertBefore(bytemdEl, this._fsOriginalNext)
    }
    try { this._editor.$destroy() } catch (_) {}
  }

  getEditorElement() {
    return this._container.querySelector('.bytemd-editor') || this._container
  }

  canEdit() {
    return !this.isPreviewActive() && !this._readOnly
  }

  getDropPosition(clientX, clientY) {
    const view = this._getEditorView()
    if (view && typeof view.posAtCoords === 'function') {
      try {
        const pos = view.posAtCoords({ x: clientX, y: clientY })
        return Number.isInteger(pos) ? pos : null
      } catch (_error) {
        return null
      }
    }

    const codeMirror = this._getLegacyCodeMirror()
    if (!codeMirror || typeof codeMirror.coordsChar !== 'function') return null
    try {
      const pos = codeMirror.coordsChar({ left: clientX, top: clientY }, 'window')
      if (!pos || typeof codeMirror.indexFromPos !== 'function') return null
      const index = codeMirror.indexFromPos(pos)
      return Number.isInteger(index) ? index : null
    } catch (_error) {
      return null
    }
  }

  getCursorPosition() {
    const view = this._getEditorView()
    if (view?.state?.selection?.main) {
      const { from } = view.state.selection.main
      return Number.isInteger(from) ? from : null
    }

    const codeMirror = this._getLegacyCodeMirror()
    if (!codeMirror) return null
    try {
      const doc = typeof codeMirror.getDoc === 'function' ? codeMirror.getDoc() : codeMirror
      const cursor = typeof doc?.getCursor === 'function' ? doc.getCursor() : null
      if (!cursor || typeof codeMirror.indexFromPos !== 'function') return null
      const index = codeMirror.indexFromPos(cursor)
      return Number.isInteger(index) ? index : null
    } catch (_error) {
      return null
    }
  }

  setCursorPosition(position) {
    const view = this._getEditorView()
    if (view?.state?.doc && typeof view.dispatch === 'function') {
      const docLength = view.state.doc.length
      const nextPos = Number.isInteger(position)
        ? Math.max(0, Math.min(position, docLength))
        : 0
      view.dispatch({ selection: { anchor: nextPos } })
      if (typeof view.focus === 'function') view.focus()
      return true
    }

    const codeMirror = this._getLegacyCodeMirror()
    if (!codeMirror || typeof codeMirror.posFromIndex !== 'function') return false
    try {
      const doc = typeof codeMirror.getDoc === 'function' ? codeMirror.getDoc() : codeMirror
      const docLength = typeof codeMirror.getValue === 'function' ? codeMirror.getValue().length : this._value.length
      const nextPos = Number.isInteger(position)
        ? Math.max(0, Math.min(position, docLength))
        : 0
      const cmPos = codeMirror.posFromIndex(nextPos)
      if (typeof doc?.setCursor === 'function') {
        doc.setCursor(cmPos)
      } else if (typeof codeMirror.setCursor === 'function') {
        codeMirror.setCursor(cmPos)
      } else {
        return false
      }
      if (typeof codeMirror.focus === 'function') codeMirror.focus()
      return true
    } catch (_error) {
      return false
    }
  }

  insertText(text, position = null) {
    this._insertText(text, position)
  }

  _getEditorView() {
    // 全画面時は .bytemd が document.body に移動するため、両方から探す
    const cmEl = this._container.querySelector('.cm-editor')
              || document.querySelector('.bytemd-fullscreen .cm-editor')
    if (!cmEl) return null
    const candidateKeys = [
      ...Object.keys(cmEl),
      ...Object.getOwnPropertyNames(cmEl),
      ...Object.getOwnPropertySymbols(cmEl)
    ]
    for (const key of candidateKeys) {
      const candidate = cmEl[key]
      if (candidate && typeof candidate.dispatch === 'function' && candidate.state) {
        return candidate
      }
    }
    return null
  }

  _getLegacyCodeMirror() {
    const cmEl = this._container.querySelector('.CodeMirror')
              || document.querySelector('.bytemd-fullscreen .CodeMirror')
    if (!cmEl) return null
    if (cmEl.CodeMirror) return cmEl.CodeMirror

    const candidateKeys = [
      ...Object.keys(cmEl),
      ...Object.getOwnPropertyNames(cmEl),
      ...Object.getOwnPropertySymbols(cmEl)
    ]
    for (const key of candidateKeys) {
      const candidate = cmEl[key]
      if (candidate && typeof candidate.getDoc === 'function' && typeof candidate.getValue === 'function') {
        return candidate
      }
    }
    return null
  }

  _insertText(text, position = null) {
    const view = this._getEditorView()
    if (view) {
      const docLength = view.state.doc.length
      const nextPos = Number.isInteger(position)
        ? Math.max(0, Math.min(position, docLength))
        : view.state.selection.main.from
      view.dispatch({
        changes: { from: nextPos, to: nextPos, insert: text },
        selection: { anchor: nextPos + text.length }
      })
      this._value = view.state.doc.toString()
      if (typeof view.focus === 'function') view.focus()
      return
    }

    const codeMirror = this._getLegacyCodeMirror()
    if (codeMirror && typeof codeMirror.getDoc === 'function' && typeof codeMirror.posFromIndex === 'function') {
      const doc = codeMirror.getDoc()
      const currentValue = typeof codeMirror.getValue === 'function' ? codeMirror.getValue() : this._value
      const nextPos = Number.isInteger(position)
        ? Math.max(0, Math.min(position, currentValue.length))
        : this.getCursorPosition()
      const from = codeMirror.posFromIndex(Number.isInteger(nextPos) ? nextPos : currentValue.length)
      doc.replaceRange(text, from, from)
      const insertedEnd = codeMirror.posFromIndex((Number.isInteger(nextPos) ? nextPos : currentValue.length) + text.length)
      if (typeof doc.setCursor === 'function') doc.setCursor(insertedEnd)
      this._value = typeof codeMirror.getValue === 'function' ? codeMirror.getValue() : (currentValue + text)
      if (typeof codeMirror.focus === 'function') codeMirror.focus()
      return
    }

    this._value = this._value + text
    this._editor.$set({ value: this._value })
  }

  // --- テーブルエディタ用ヘルパー（CM6 先、legacy フォールバック） ---

  getCursor() {
    const view = this._getEditorView()
    if (view?.state?.selection?.main) {
      const from = view.state.selection.main.from
      const lineInfo = view.state.doc.lineAt(from)
      return { line: lineInfo.number - 1, ch: from - lineInfo.from }
    }
    const cm = this._getLegacyCodeMirror()
    if (!cm) return { line: 0, ch: 0 }
    try {
      const doc = typeof cm.getDoc === 'function' ? cm.getDoc() : cm
      return typeof doc.getCursor === 'function' ? doc.getCursor() : { line: 0, ch: 0 }
    } catch { return { line: 0, ch: 0 } }
  }

  getLine(n) {
    const view = this._getEditorView()
    if (view?.state?.doc) {
      try { return view.state.doc.line(n + 1).text } catch { return '' }
    }
    const cm = this._getLegacyCodeMirror()
    return (cm && typeof cm.getLine === 'function') ? cm.getLine(n) : ''
  }

  lineCount() {
    const view = this._getEditorView()
    if (view?.state?.doc) return view.state.doc.lines
    const cm = this._getLegacyCodeMirror()
    return (cm && typeof cm.lineCount === 'function') ? cm.lineCount() : 0
  }

  replaceRange(text, from, to) {
    const view = this._getEditorView()
    if (view?.state?.doc) {
      try {
        const fromOffset = view.state.doc.line(from.line + 1).from + from.ch
        const toOffset   = view.state.doc.line(to.line + 1).from + to.ch
        view.dispatch({ changes: { from: fromOffset, to: toOffset, insert: text } })
        this._value = view.state.doc.toString()
        if (typeof view.focus === 'function') view.focus()
        return
      } catch (_e) { /* fall through to legacy */ }
    }
    const cm = this._getLegacyCodeMirror()
    if (cm) {
      const doc = typeof cm.getDoc === 'function' ? cm.getDoc() : cm
      if (typeof doc.replaceRange === 'function') doc.replaceRange(text, from, to)
    }
  }
}

function cleanupEditorLayoutHooks() {
  if (editorResizeObserver) {
    editorResizeObserver.disconnect()
    editorResizeObserver = null
  }
  if (editorToolbarResizeObserver) {
    editorToolbarResizeObserver.disconnect()
    editorToolbarResizeObserver = null
  }
  if (editorFullscreenObserver) {
    editorFullscreenObserver.disconnect()
    editorFullscreenObserver = null
  }
  if (editorWindowResizeHandler) {
    window.removeEventListener('resize', editorWindowResizeHandler)
    editorWindowResizeHandler = null
  }
  if (editorScrollSyncHandler) {
    const scrollArea = document.getElementById('editor-scroll-area')
    if (scrollArea) scrollArea.removeEventListener('scroll', editorScrollSyncHandler)
    editorScrollSyncHandler = null
  }
  if (editorScrollSyncRafId !== null) {
    window.cancelAnimationFrame(editorScrollSyncRafId)
    editorScrollSyncRafId = null
  }
  lastSyncedEditorHeight = null
  if (editorFullscreenButton && editorFullscreenClickHandler) {
    editorFullscreenButton.removeEventListener('click', editorFullscreenClickHandler)
    editorFullscreenButton = null
    editorFullscreenClickHandler = null
  }
  if (editorKeydownHandler) {
    document.removeEventListener('keydown', editorKeydownHandler)
    editorKeydownHandler = null
  }
  if (mobileContentSwipeCleanup) {
    mobileContentSwipeCleanup()
    mobileContentSwipeCleanup = null
  }
  editorCodeMirrorWrapper = null
  editorFullscreenForcedState = null
  document.body.classList.remove('editor-content-fullscreen')
}

function isContentEditorFullscreen() {
  if (typeof editorFullscreenForcedState === 'boolean') return editorFullscreenForcedState
  return !!document.querySelector('.bytemd-fullscreen')
}

function syncSplitHandleVisibility() {
  const resizeHandle = document.getElementById('resize-handle')
  const isFullscreen = isContentEditorFullscreen()
  document.body.classList.toggle('editor-content-fullscreen', isFullscreen)
  if (!resizeHandle) return

  resizeHandle.style.display = isFullscreen ? 'none' : ''
}

function syncEditorStickyLayout(cmWrapper = null) {
  const contentSection = document.getElementById('content-editor-section')
  const contentHeader = document.getElementById('content-editor-header')
  if (!contentSection || !contentHeader) return 0

  if (isContentEditorFullscreen()) {
    contentSection.classList.remove('has-sticky-toolbar')
    contentSection.style.removeProperty('--editor-content-header-height')
    contentSection.style.removeProperty('--editor-toolbar-height')
    contentSection.style.removeProperty('--editor-toolbar-sticky-top')
    return 0
  }

  const headerHeight = Math.ceil(contentHeader.getBoundingClientRect().height)
  contentSection.style.setProperty('--editor-content-header-height', `${headerHeight}px`)

  const toolbar = contentSection.querySelector('.bytemd-toolbar')
  if (!toolbar) {
    contentSection.classList.remove('has-sticky-toolbar')
    contentSection.style.removeProperty('--editor-toolbar-height')
    contentSection.style.removeProperty('--editor-toolbar-sticky-top')
    return headerHeight
  }

  const toolbarHeight = Math.ceil(toolbar.getBoundingClientRect().height)
  contentSection.classList.add('has-sticky-toolbar')
  contentSection.style.setProperty('--editor-toolbar-height', `${toolbarHeight}px`)
  contentSection.style.setProperty('--editor-toolbar-sticky-top', `${headerHeight}px`)

  return headerHeight + toolbarHeight
}

// モバイルレイアウト（<768px）では編集ペインが独立してスクロールせず、ページ全体がスクロールする。
// このときスクロール連動は発動しないため、下端スペーサーは無駄な空白になるだけになる
function isMobileEditorLayout() {
  return window.matchMedia('(max-width: 767px)').matches
}

function clickBytemdFullscreenIcon(bytemdEl) {
  const icon = [...bytemdEl.querySelectorAll('.bytemd-toolbar-icon')].find(el =>
    [...el.querySelectorAll('path')].some(p => BYTEMD_FULLSCREEN_ICON_PATHS.has(p.getAttribute('d')))
  )
  if (icon) icon.click()
}

// モバイルでは本文の欄が画面の下半分ほどしかなく、本文に触れると本文の中だけがスクロールする。
// 本文の下端まで見えている状態から、編集ペインでさらに上へスクロール（スワイプ・ホイール）したら
// 本文を全画面（ヘッダーも隠れて画面の上端まで）にし、
// 全画面で本文が先頭にあるときに下へスクロールしたら元に戻す
function setupMobileContentSwipe(bytemdEl) {
  // 全画面中の .bytemd は body 直下へ移るので、document で受けて対象を絞る
  const isSwipeTarget = (target) => {
    if (!isMobileEditorLayout() || !(target instanceof Element)) return false
    return bytemdEl.contains(target) || !!target.closest('#editor-pane')
  }
  const scrollTopAt = (target) => {
    const scroller = target.closest?.('.bytemd-preview, .CodeMirror-scroll, .cm-scroller')
    return scroller ? scroller.scrollTop : 0
  }
  // 操作を始めた時点で本文の下端が画面内にあるか。途中でページ送りが下端に届いただけでは広げない
  const isContentBottomVisible = () =>
    bytemdEl.getBoundingClientRect().bottom <= window.innerHeight + 1
  const toggleIfNeeded = (deltaY, startScrollTop, startedAtBottom) => {
    const isFullscreen = bytemdEl.classList.contains('bytemd-fullscreen')
    const shouldEnter = !isFullscreen && startedAtBottom && deltaY >= MOBILE_CONTENT_SWIPE_THRESHOLD
    const shouldExit = isFullscreen && startScrollTop <= 0 && deltaY <= -MOBILE_CONTENT_SWIPE_THRESHOLD
    if (!shouldEnter && !shouldExit) return false
    clickBytemdFullscreenIcon(bytemdEl)
    return true
  }

  // タッチ: 指を上へ動かす（clientY が減る）＝ 上へスクロール
  let touchStartY = null
  let touchStartScrollTop = 0
  let touchStartedAtBottom = false
  let touchHandled = false
  const onTouchStart = (event) => {
    if (event.touches.length !== 1 || !isSwipeTarget(event.target)) {
      touchStartY = null
      return
    }
    touchStartY = event.touches[0].clientY
    touchStartScrollTop = scrollTopAt(event.target)
    touchStartedAtBottom = isContentBottomVisible()
    touchHandled = false
  }
  const onTouchMove = (event) => {
    if (touchStartY === null || touchHandled || event.touches.length !== 1) return
    touchHandled = toggleIfNeeded(touchStartY - event.touches[0].clientY, touchStartScrollTop, touchStartedAtBottom)
  }
  const onTouchEnd = () => { touchStartY = null }

  // ホイール・トラックパッド: 慣性で続くイベントは1回の操作としてまとめる
  let wheelGestureAt = 0
  let wheelDelta = 0
  let wheelStartScrollTop = 0
  let wheelStartedAtBottom = false
  let wheelHandled = false
  const onWheel = (event) => {
    if (!isSwipeTarget(event.target)) return
    const now = Date.now()
    if (now - wheelGestureAt > MOBILE_WHEEL_GESTURE_GAP_MS) {
      wheelDelta = 0
      wheelStartScrollTop = scrollTopAt(event.target)
      wheelStartedAtBottom = isContentBottomVisible()
      wheelHandled = false
    }
    wheelGestureAt = now
    if (wheelHandled) return
    wheelDelta += event.deltaY
    wheelHandled = toggleIfNeeded(wheelDelta, wheelStartScrollTop, wheelStartedAtBottom)
  }

  // iOS では ByteMD 全画面の height:100vh がブラウザのバーやキーボードに隠れた部分まで含むため、
  // 下端が見えず、ページごとずれてツールバーも隠れる。全画面中は見えている範囲（visualViewport）に合わせる
  const viewport = window.visualViewport
  const syncFullscreenViewport = () => {
    const isActive = isMobileEditorLayout() && bytemdEl.classList.contains('bytemd-fullscreen')
    document.documentElement.classList.toggle('mobile-content-fullscreen', isActive)
    if (!isActive || !viewport) {
      bytemdEl.style.removeProperty('top')
      bytemdEl.style.removeProperty('height')
      return
    }
    bytemdEl.style.setProperty('top', `${Math.round(viewport.offsetTop)}px`)
    bytemdEl.style.setProperty('height', `${Math.round(viewport.height)}px`, 'important')
  }
  const fullscreenClassObserver = new MutationObserver(syncFullscreenViewport)
  fullscreenClassObserver.observe(bytemdEl, { attributes: true, attributeFilter: ['class'] })
  if (viewport) {
    viewport.addEventListener('resize', syncFullscreenViewport)
    viewport.addEventListener('scroll', syncFullscreenViewport)
  }

  const listeners = [
    ['touchstart', onTouchStart],
    ['touchmove', onTouchMove],
    ['touchend', onTouchEnd],
    ['touchcancel', onTouchEnd],
    ['wheel', onWheel]
  ]
  listeners.forEach(([type, fn]) => document.addEventListener(type, fn, { passive: true }))
  return () => {
    listeners.forEach(([type, fn]) => document.removeEventListener(type, fn))
    fullscreenClassObserver.disconnect()
    if (viewport) {
      viewport.removeEventListener('resize', syncFullscreenViewport)
      viewport.removeEventListener('scroll', syncFullscreenViewport)
    }
    document.documentElement.classList.remove('mobile-content-fullscreen')
  }
}

function syncContentEditorHeight(cmWrapper) {
  if (!cmWrapper) return

  const isFullscreen = isContentEditorFullscreen()
  if (isFullscreen) {
    // ByteMD fullscreen CSS handles sizing
    cmWrapper.style.height = ''
    cmWrapper.style.maxHeight = ''
    cmWrapper.style.minHeight = ''
    const fullscreenSpacer = document.getElementById('editor-scroll-spacer')
    if (fullscreenSpacer) fullscreenSpacer.style.height = '0px'
    lastSyncedEditorHeight = null
    syncEditorStickyLayout(cmWrapper)
    return
  }

  // ByteMD コンテナの高さを、スクロール量 s に連動させて調整する:
  //   E(s) = Hc − EDITOR_CONTENT_BOTTOM_GAP − max(A − s, h)
  //     Hc: #editor-scroll-area の clientHeight
  //     A:  本文上端のコンテンツ座標（rect.top − containerRect.top + scrollTop。
  //         画像リストの有無で変わるため定数にせず毎回実測する）
  //     h:  sticky ヘッダ（#content-editor-header）の高さ
  //   s = 0 で従来どおり画面に収まる高さ、s ≥ A − h で title ブロックが上に隠れ、
  //   CONTENT キャプションが上端に貼り付いた最大高さになる（それ以上は伸びない）。
  // 下端スペーサー（#editor-scroll-spacer）は E の増分を打ち消すように縮み、
  // maxScroll を常に A − h に保つ。スクロール末尾に余白のデッドゾーンができない。
  const scrollContainer = document.getElementById('editor-scroll-area')
  const stickyOffset = syncEditorStickyLayout(cmWrapper)
  const rect = cmWrapper.getBoundingClientRect()
  const containerRect = scrollContainer ? scrollContainer.getBoundingClientRect() : null

  let nextHeight
  if (isMobileEditorLayout()) {
    // モバイルでは編集ペインの高さが中身で決まるため、スクロール領域の高さから
    // 本文の高さを求めると循環参照になる（本文を伸ばすとペインが伸び、また本文が伸びる）。
    // ビューポート基準の固定値にして安定させ、スペーサーも持たない
    nextHeight = Math.max(180, Math.round(window.innerHeight * MOBILE_EDITOR_VIEWPORT_RATIO))
    const mobileSpacer = document.getElementById('editor-scroll-spacer')
    if (mobileSpacer && mobileSpacer.style.height !== '0px') mobileSpacer.style.height = '0px'
  } else if (containerRect && scrollContainer) {
    const scrollTop = scrollContainer.scrollTop
    const contentTop = rect.top - containerRect.top + scrollTop
    const contentHeader = document.getElementById('content-editor-header')
    const headerHeight = contentHeader
      ? Math.ceil(contentHeader.getBoundingClientRect().height)
      : stickyOffset
    const reservedTop = Math.max(contentTop - scrollTop, headerHeight)
    const rawHeight = Math.floor(scrollContainer.clientHeight - reservedTop - EDITOR_CONTENT_BOTTOM_GAP)
    nextHeight = Math.max(180, rawHeight)

    const spacer = document.getElementById('editor-scroll-spacer')
    // 最小高さ(180px)に張り付くほど狭いときは、本文がすでにはみ出していて
    // スクロール連動の余地が無い。スペーサーを置いても末尾の空白になるだけ
    if (spacer && rawHeight <= 180) {
      if (spacer.style.height !== '0px') spacer.style.height = '0px'
    } else if (spacer) {
      // スクロール領域全体の高さ（scrollHeight）が Hc + (A − h) になるようにする。
      // スペーサーの margin-top は CSS で 0 にしてある（space-y-4 の 16px を打ち消す）。
      // マージンが残っていると最大スクロール位置でスペーサーが 0 にクランプされ、
      // 末尾に数px のデッドゾーンができる。
      const spacerHeight = Math.max(0, Math.ceil(scrollContainer.clientHeight - headerHeight - nextHeight))
      if (spacer.style.height !== `${spacerHeight}px`) {
        spacer.style.height = `${spacerHeight}px`
      }
    }
  } else {
    nextHeight = Math.max(180, Math.floor(window.innerHeight - rect.top - 40))
  }

  cmWrapper.style.minHeight = '180px'
  cmWrapper.style.maxHeight = 'none'
  // スクロールイベントは頻発するため、前回と 1px 未満の差なら height を書き換えない
  if (lastSyncedEditorHeight === null || Math.abs(lastSyncedEditorHeight - nextHeight) >= 1) {
    cmWrapper.style.height = `${nextHeight}px`
    lastSyncedEditorHeight = nextHeight
  }
}

function syncContentEditorScrollBounds(_cmWrapper) {
  // ByteMD が内部スクロールを自動管理するため不要
}

function syncMainContainerWithHeaderHeight() {
  const header = document.getElementById('tree-header')
  const headerHeight = header ? Math.ceil(header.offsetHeight) : DEFAULT_TREE_HEADER_HEIGHT
  document.documentElement.style.setProperty('--tree-header-height', `${headerHeight}px`)
}

function getSortModeLabel(mode) {
  switch (mode) {
    case 'manual': return t('editor.sortManual')
    case 'created_at': return t('editor.sortCreatedAt')
    case 'updated_at': return t('editor.sortUpdatedAt')
    case 'title': return t('editor.sortTitle')
    default: return t('editor.sortManual')
  }
}

function getRelationTypeIcon(relationTypeId) {
  return RELATION_TYPE_ICON_MAP[relationTypeId] || RELATION_TYPE_ICON_MAP[1]
}

function getRelationTypeLabel(relationType) {
  const icon = getRelationTypeIcon(Number(relationType.icon_type) || Number(relationType.id) || 1)
  return `${icon} ${relationType.name}`
}

function getRelationTypeIdForEdge(parentId, childId) {
  const relation = relations.find(r => r.parent_node_id === parentId && r.child_node_id === childId)
  return relation ? (Number(relation.relation_type_id) || 1) : 1
}

function parseDateValue(value) {
  const date = new Date(value || 0)
  return Number.isNaN(date.getTime()) ? 0 : date.getTime()
}

function normalizeSortMode(mode) {
  return ['manual', 'created_at', 'updated_at', 'title'].includes(mode) ? mode : DEFAULT_CHILD_SORT_MODE
}

function normalizeSortDirection(direction) {
  return ['asc', 'desc'].includes(direction) ? direction : DEFAULT_CHILD_SORT_DIRECTION
}

function getNodeById(nodeId) {
  return nodes.find(n => n.id === nodeId) || null
}

function getChildSortConfig(parentNodeId) {
  const parentNode = getNodeById(parentNodeId)
  return {
    mode: normalizeSortMode(parentNode?.child_sort_mode),
    direction: normalizeSortDirection(parentNode?.child_sort_direction)
  }
}

function isManualSortForParent(parentNodeId) {
  return getChildSortConfig(parentNodeId).mode === 'manual'
}

function getParentNodeIdFromPath(nodePath) {
  const viewRoot = getCurrentViewRootNodeId()
  if (!nodePath) return viewRoot
  const pathParts = String(nodePath).split('-')
  if (pathParts.length <= 1) return viewRoot
  return pathParts[pathParts.length - 2]
}

function getVisibleParentMetaForNode(nodeId, nodePath = null) {
  if (treeViewMode !== 'normal') return null
  const targetPath = nodePath || selectedNodePath
  const parentId = getParentNodeIdFromPath(targetPath)
  if (!parentId) return null

  const parentNode = getNodeById(parentId)
  const parentTitle = parentNode?.title || (parentId === currentRootNodeId ? 'root' : t('editor.parentNodeFallback'))
  const parentRelations = relationParentsByChild.get(nodeId) || []
  const parentCount = parentRelations.length

  return {
    parentId,
    parentTitle,
    parentCount
  }
}

function getParentNodeIdFromElement(treeItemEl) {
  if (!treeItemEl) return getCurrentViewRootNodeId()
  const wrapper = treeItemEl.closest('[data-node-group]')
  const parentContainer = wrapper?.parentElement
  if (parentContainer && parentContainer.id !== 'tree-container') {
    return parentContainer.dataset.parent
  }
  return getCurrentViewRootNodeId()
}

function compareNodesBySortMode(a, b, sortMode, sortDirection) {
  if (sortMode === 'manual') {
    if (a.relationPosition !== b.relationPosition) {
      return a.relationPosition - b.relationPosition
    }
    return parseDateValue(a.created_at) - parseDateValue(b.created_at)
  }

  let base = 0
  if (sortMode === 'created_at') {
    base = parseDateValue(a.created_at) - parseDateValue(b.created_at)
  } else if (sortMode === 'updated_at') {
    base = parseDateValue(a.updated_at) - parseDateValue(b.updated_at)
  } else if (sortMode === 'title') {
    base = String(a.title || '').localeCompare(String(b.title || ''), 'ja')
  }

  if (base === 0) {
    base = parseDateValue(a.created_at) - parseDateValue(b.created_at)
  }

  return sortDirection === 'desc' ? -base : base
}

// カスタムプロンプトモーダル
function showPrompt(message, defaultValue = '') {
  return new Promise((resolve) => {
    // モーダルを作成
    let modal = document.getElementById('custom-prompt-modal')
    if (!modal) {
      modal = document.createElement('div')
      modal.id = 'custom-prompt-modal'
      modal.innerHTML = `
        <div class="prompt-overlay"></div>
        <div class="prompt-dialog">
          <div class="prompt-message"></div>
          <input type="text" class="prompt-input" />
          <div class="prompt-buttons">
            <button type="button" class="prompt-cancel">${t('common.cancel')}</button>
            <button type="button" class="prompt-ok">${t('common.ok')}</button>
          </div>
        </div>
      `
      document.body.appendChild(modal)

      // スタイルを追加
      const style = document.createElement('style')
      style.textContent = `
        #custom-prompt-modal {
          display: none;
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          z-index: 10000;
        }
        #custom-prompt-modal .prompt-overlay {
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: rgba(0, 0, 0, 0.5);
        }
        #custom-prompt-modal .prompt-dialog {
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          background: white;
          border-radius: 8px;
          padding: 24px;
          min-width: 400px;
          max-width: 90%;
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
        }
        #custom-prompt-modal .prompt-message {
          font-size: 16px;
          color: #333;
          margin-bottom: 16px;
        }
        #custom-prompt-modal .prompt-input {
          width: 100%;
          font-size: 16px;
          padding: 12px;
          border: 2px solid #e2e8f0;
          border-radius: 6px;
          box-sizing: border-box;
          outline: none;
          transition: border-color 0.2s;
        }
        #custom-prompt-modal .prompt-input:focus {
          border-color: #667eea;
        }
        #custom-prompt-modal .prompt-buttons {
          display: flex;
          justify-content: flex-end;
          gap: 12px;
          margin-top: 20px;
        }
        #custom-prompt-modal .prompt-cancel {
          padding: 10px 20px;
          font-size: 14px;
          border: none;
          border-radius: 6px;
          cursor: pointer;
          background: #e2e8f0;
          color: #4a5568;
        }
        #custom-prompt-modal .prompt-cancel:hover {
          background: #cbd5e0;
        }
        #custom-prompt-modal .prompt-ok {
          padding: 10px 20px;
          font-size: 14px;
          border: none;
          border-radius: 6px;
          cursor: pointer;
          background: #667eea;
          color: white;
        }
        #custom-prompt-modal .prompt-ok:hover {
          background: #5a67d8;
        }
        /* ダークテーマ上書き */
        html.theme-dark #custom-prompt-modal .prompt-dialog {
          background: #1f2937;
        }
        html.theme-dark #custom-prompt-modal .prompt-message {
          color: #e5e7eb;
        }
        html.theme-dark #custom-prompt-modal .prompt-input {
          border-color: #374151;
          background: #111827;
          color: #e5e7eb;
        }
        html.theme-dark #custom-prompt-modal .prompt-cancel {
          background: #374151;
          color: #e5e7eb;
        }
        html.theme-dark #custom-prompt-modal .prompt-cancel:hover {
          background: #4b5563;
        }
      `
      document.head.appendChild(style)
    }

    const messageEl = modal.querySelector('.prompt-message')
    const inputEl = modal.querySelector('.prompt-input')
    const cancelBtn = modal.querySelector('.prompt-cancel')
    const okBtn = modal.querySelector('.prompt-ok')
    const overlay = modal.querySelector('.prompt-overlay')

    messageEl.textContent = message
    inputEl.value = defaultValue

    modal.style.display = 'block'
    inputEl.focus()
    inputEl.select()

    function cleanup() {
      modal.style.display = 'none'
      inputEl.removeEventListener('keydown', handleKeydown)
      cancelBtn.removeEventListener('click', handleCancel)
      okBtn.removeEventListener('click', handleOk)
      overlay.removeEventListener('click', handleCancel)
    }

    function handleCancel() {
      cleanup()
      resolve(null)
    }

    function handleOk() {
      cleanup()
      resolve(inputEl.value)
    }

    function handleKeydown(e) {
      // Ignore Enter while IME composition is active to avoid accidental submit
      if (e.isComposing) return

      if (e.key === 'Enter') {
        handleOk()
      } else if (e.key === 'Escape') {
        handleCancel()
      }
    }

    inputEl.addEventListener('keydown', handleKeydown)
    cancelBtn.addEventListener('click', handleCancel)
    okBtn.addEventListener('click', handleOk)
    overlay.addEventListener('click', handleCancel)
  })
}

// 未保存確認モーダル
function showUnsavedConfirm() {
  return new Promise((resolve) => {
    // モーダルを作成
    let modal = document.getElementById('unsaved-confirm-modal')
    if (!modal) {
      modal = document.createElement('div')
      modal.id = 'unsaved-confirm-modal'
      modal.innerHTML = `
        <div class="confirm-overlay"></div>
        <div class="confirm-dialog">
          <div class="confirm-icon">
            <i class="fas fa-exclamation-triangle"></i>
          </div>
          <div class="confirm-message">${t('editor.saveChangesConfirm')}</div>
          <div class="confirm-sub">${t('editor.unsavedChangesWarning')}</div>
          <div class="confirm-buttons">
            <button type="button" class="confirm-no">${t('common.no')}</button>
            <button type="button" class="confirm-yes">${t('common.yes')}</button>
          </div>
        </div>
      `
      document.body.appendChild(modal)

      // スタイルを追加
      const style = document.createElement('style')
      style.textContent = `
        #unsaved-confirm-modal {
          display: none;
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          z-index: 10000;
        }
        #unsaved-confirm-modal .confirm-overlay {
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: rgba(0, 0, 0, 0.5);
        }
        #unsaved-confirm-modal .confirm-dialog {
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          background: white;
          border-radius: 12px;
          padding: 32px;
          min-width: 360px;
          max-width: 90%;
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
          text-align: center;
        }
        #unsaved-confirm-modal .confirm-icon {
          font-size: 48px;
          color: #f59e0b;
          margin-bottom: 16px;
        }
        #unsaved-confirm-modal .confirm-message {
          font-size: 18px;
          font-weight: 600;
          color: #1f2937;
          margin-bottom: 8px;
        }
        #unsaved-confirm-modal .confirm-sub {
          font-size: 14px;
          color: #6b7280;
          margin-bottom: 24px;
        }
        #unsaved-confirm-modal .confirm-buttons {
          display: flex;
          justify-content: center;
          gap: 12px;
        }
        #unsaved-confirm-modal .confirm-no {
          padding: 12px 32px;
          font-size: 15px;
          font-weight: 500;
          border: none;
          border-radius: 8px;
          cursor: pointer;
          background: #e5e7eb;
          color: #374151;
          transition: background 0.2s;
        }
        #unsaved-confirm-modal .confirm-no:hover {
          background: #d1d5db;
        }
        #unsaved-confirm-modal .confirm-yes {
          padding: 12px 32px;
          font-size: 15px;
          font-weight: 500;
          border: none;
          border-radius: 8px;
          cursor: pointer;
          background: #3b82f6;
          color: white;
          transition: background 0.2s;
        }
        #unsaved-confirm-modal .confirm-yes:hover {
          background: #2563eb;
        }
        /* ダークテーマ上書き */
        html.theme-dark #unsaved-confirm-modal .confirm-dialog {
          background: #1f2937;
        }
        html.theme-dark #unsaved-confirm-modal .confirm-message {
          color: #f3f4f6;
        }
        html.theme-dark #unsaved-confirm-modal .confirm-sub {
          color: #9ca3af;
        }
        html.theme-dark #unsaved-confirm-modal .confirm-no {
          background: #374151;
          color: #e5e7eb;
        }
        html.theme-dark #unsaved-confirm-modal .confirm-no:hover {
          background: #4b5563;
        }
      `
      document.head.appendChild(style)
    }

    const yesBtn = modal.querySelector('.confirm-yes')
    const noBtn = modal.querySelector('.confirm-no')
    const overlay = modal.querySelector('.confirm-overlay')

    modal.style.display = 'block'

    function cleanup() {
      modal.style.display = 'none'
      yesBtn.removeEventListener('click', handleYes)
      noBtn.removeEventListener('click', handleNo)
      overlay.removeEventListener('click', handleNo)
    }

    function handleYes() {
      cleanup()
      resolve('yes')
    }

    function handleNo() {
      cleanup()
      resolve('no')
    }

    yesBtn.addEventListener('click', handleYes)
    noBtn.addEventListener('click', handleNo)
    overlay.addEventListener('click', handleNo)
  })
}

function showPrintOrientationDialog(initialOrientation = 'portrait') {
  return new Promise((resolve) => {
    let modal = document.getElementById('print-orientation-modal')
    if (!modal) {
      modal = document.createElement('div')
      modal.id = 'print-orientation-modal'
      modal.innerHTML = `
        <div class="print-orientation-overlay"></div>
        <div class="print-orientation-dialog" role="dialog" aria-modal="true" aria-label="${t('editor.printOrientationDialogLabel')}">
          <div class="print-orientation-title">${t('editor.selectPrintOrientation')}</div>
          <div class="print-orientation-options" role="radiogroup" aria-label="${t('editor.printOrientation')}">
            <label class="print-orientation-option">
              <input type="radio" name="print-orientation" value="portrait" />
              <span>${t('editor.portrait')}</span>
            </label>
            <label class="print-orientation-option">
              <input type="radio" name="print-orientation" value="landscape" />
              <span>${t('editor.landscape')}</span>
            </label>
          </div>
          <div class="print-orientation-buttons">
            <button type="button" class="print-orientation-cancel">${t('common.cancel')}</button>
            <button type="button" class="print-orientation-ok">${t('common.ok')}</button>
          </div>
        </div>
      `
      document.body.appendChild(modal)

      const style = document.createElement('style')
      style.id = 'print-orientation-style'
      style.textContent = `
        #print-orientation-modal {
          display: none;
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          z-index: 10020;
        }
        #print-orientation-modal .print-orientation-overlay {
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: rgba(0, 0, 0, 0.42);
        }
        #print-orientation-modal .print-orientation-dialog {
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          width: min(360px, 92vw);
          background: #fff;
          border-radius: 10px;
          padding: 18px;
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18);
        }
        #print-orientation-modal .print-orientation-title {
          font-size: 15px;
          font-weight: 600;
          color: #1f2937;
          margin-bottom: 14px;
        }
        #print-orientation-modal .print-orientation-options {
          display: flex;
          gap: 14px;
          margin-bottom: 16px;
        }
        #print-orientation-modal .print-orientation-option {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-size: 14px;
          color: #374151;
          cursor: pointer;
        }
        #print-orientation-modal .print-orientation-buttons {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
        }
        #print-orientation-modal .print-orientation-cancel,
        #print-orientation-modal .print-orientation-ok {
          border: none;
          border-radius: 8px;
          font-size: 13px;
          font-weight: 600;
          padding: 8px 14px;
          cursor: pointer;
        }
        #print-orientation-modal .print-orientation-cancel {
          background: #e5e7eb;
          color: #374151;
        }
        #print-orientation-modal .print-orientation-cancel:hover {
          background: #d1d5db;
        }
        #print-orientation-modal .print-orientation-ok {
          background: #2563eb;
          color: #fff;
        }
        #print-orientation-modal .print-orientation-ok:hover {
          background: #1d4ed8;
        }
        /* ダークテーマ上書き */
        html.theme-dark #print-orientation-modal .print-orientation-dialog {
          background: #1f2937;
        }
        html.theme-dark #print-orientation-modal .print-orientation-title {
          color: #f3f4f6;
        }
        html.theme-dark #print-orientation-modal .print-orientation-option {
          color: #e5e7eb;
        }
        html.theme-dark #print-orientation-modal .print-orientation-cancel {
          background: #374151;
          color: #e5e7eb;
        }
        html.theme-dark #print-orientation-modal .print-orientation-cancel:hover {
          background: #4b5563;
        }
      `
      document.head.appendChild(style)
    }

    const overlay = modal.querySelector('.print-orientation-overlay')
    const dialog = modal.querySelector('.print-orientation-dialog')
    const cancelBtn = modal.querySelector('.print-orientation-cancel')
    const okBtn = modal.querySelector('.print-orientation-ok')
    const radios = modal.querySelectorAll('input[name="print-orientation"]')
    const initial = normalizePrintOrientation(initialOrientation)

    radios.forEach((radio) => {
      radio.checked = radio.value === initial
    })

    modal.style.display = 'block'
    const focused = modal.querySelector(`input[name="print-orientation"][value="${initial}"]`)
    if (focused) focused.focus()

    function getSelectedOrientation() {
      const selected = modal.querySelector('input[name="print-orientation"]:checked')
      return normalizePrintOrientation(selected?.value)
    }

    function cleanup() {
      modal.style.display = 'none'
      overlay.removeEventListener('click', handleCancel)
      cancelBtn.removeEventListener('click', handleCancel)
      okBtn.removeEventListener('click', handleOk)
      document.removeEventListener('keydown', handleKeydown)
    }

    function handleCancel() {
      cleanup()
      resolve(null)
    }

    function handleOk() {
      const orientation = getSelectedOrientation()
      cleanup()
      resolve(orientation)
    }

    function handleKeydown(event) {
      if (event.isComposing) return
      if (modal.style.display !== 'block') return
      if (event.key === 'Escape') {
        event.preventDefault()
        handleCancel()
      } else if (event.key === 'Enter' && dialog.contains(document.activeElement)) {
        event.preventDefault()
        handleOk()
      }
    }

    overlay.addEventListener('click', handleCancel)
    cancelBtn.addEventListener('click', handleCancel)
    okBtn.addEventListener('click', handleOk)
    document.addEventListener('keydown', handleKeydown)
  })
}

function showDeleteNodeChoiceDialog(parentTitle) {
  return new Promise((resolve) => {
    let modal = document.getElementById('delete-node-choice-modal')
    if (!modal) {
      modal = document.createElement('div')
      modal.id = 'delete-node-choice-modal'
      modal.innerHTML = `
        <div class="delete-node-choice-overlay"></div>
        <div class="delete-node-choice-dialog" role="dialog" aria-modal="true" aria-label="${t('editor.trashOperationDialogLabel')}">
          <div class="delete-node-choice-title">${t('editor.selectTrashOperation')}</div>
          <div class="delete-node-choice-subtitle">${t('editor.multipleParentsTrashHelp')}</div>
          <div class="delete-node-choice-options" role="radiogroup" aria-label="${t('editor.trashOperation')}">
            <label class="delete-node-choice-option">
              <input type="radio" name="delete-node-choice" value="unlink-parent" />
              <span></span>
            </label>
            <label class="delete-node-choice-option">
              <input type="radio" name="delete-node-choice" value="trash-node" />
              <span>${t('editor.moveNodeToTrash')}</span>
            </label>
          </div>
          <div class="delete-node-choice-buttons">
            <button type="button" class="delete-node-choice-cancel">${t('common.cancel')}</button>
            <button type="button" class="delete-node-choice-ok">${t('common.ok')}</button>
          </div>
        </div>
      `
      document.body.appendChild(modal)

      const style = document.createElement('style')
      style.id = 'delete-node-choice-style'
      style.textContent = `
        #delete-node-choice-modal {
          display: none;
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          z-index: 10021;
        }
        #delete-node-choice-modal .delete-node-choice-overlay {
          position: absolute;
          inset: 0;
          background: rgba(0, 0, 0, 0.42);
        }
        #delete-node-choice-modal .delete-node-choice-dialog {
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          width: min(440px, 92vw);
          background: #fff;
          border-radius: 10px;
          padding: 18px;
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18);
        }
        #delete-node-choice-modal .delete-node-choice-title {
          font-size: 15px;
          font-weight: 600;
          color: #1f2937;
          margin-bottom: 8px;
        }
        #delete-node-choice-modal .delete-node-choice-subtitle {
          font-size: 13px;
          color: #4b5563;
          margin-bottom: 14px;
          line-height: 1.5;
        }
        #delete-node-choice-modal .delete-node-choice-options {
          display: flex;
          flex-direction: column;
          gap: 10px;
          margin-bottom: 16px;
        }
        #delete-node-choice-modal .delete-node-choice-option {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          font-size: 14px;
          color: #374151;
          cursor: pointer;
          line-height: 1.5;
        }
        #delete-node-choice-modal .delete-node-choice-option input {
          margin-top: 2px;
        }
        #delete-node-choice-modal .delete-node-choice-buttons {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
        }
        #delete-node-choice-modal .delete-node-choice-cancel,
        #delete-node-choice-modal .delete-node-choice-ok {
          border: none;
          border-radius: 8px;
          font-size: 13px;
          font-weight: 600;
          padding: 8px 14px;
          cursor: pointer;
        }
        #delete-node-choice-modal .delete-node-choice-cancel {
          background: #e5e7eb;
          color: #374151;
        }
        #delete-node-choice-modal .delete-node-choice-cancel:hover {
          background: #d1d5db;
        }
        #delete-node-choice-modal .delete-node-choice-ok {
          background: #2563eb;
          color: #fff;
        }
        #delete-node-choice-modal .delete-node-choice-ok:hover {
          background: #1d4ed8;
        }
        /* ダークテーマ上書き */
        html.theme-dark #delete-node-choice-modal .delete-node-choice-dialog {
          background: #1f2937;
        }
        html.theme-dark #delete-node-choice-modal .delete-node-choice-title {
          color: #f3f4f6;
        }
        html.theme-dark #delete-node-choice-modal .delete-node-choice-subtitle {
          color: #9ca3af;
        }
        html.theme-dark #delete-node-choice-modal .delete-node-choice-option {
          color: #e5e7eb;
        }
        html.theme-dark #delete-node-choice-modal .delete-node-choice-cancel {
          background: #374151;
          color: #e5e7eb;
        }
        html.theme-dark #delete-node-choice-modal .delete-node-choice-cancel:hover {
          background: #4b5563;
        }
      `
      document.head.appendChild(style)
    }

    const overlay = modal.querySelector('.delete-node-choice-overlay')
    const dialog = modal.querySelector('.delete-node-choice-dialog')
    const cancelBtn = modal.querySelector('.delete-node-choice-cancel')
    const okBtn = modal.querySelector('.delete-node-choice-ok')
    const unlinkLabel = modal.querySelector('input[value="unlink-parent"] + span')
    const radios = modal.querySelectorAll('input[name="delete-node-choice"]')
    const defaultRadio = modal.querySelector('input[name="delete-node-choice"][value="unlink-parent"]')

    if (unlinkLabel) {
      unlinkLabel.textContent = t('editor.unlinkParent', { title: parentTitle })
    }
    radios.forEach((radio) => {
      radio.checked = radio === defaultRadio
    })

    modal.style.display = 'block'
    if (defaultRadio) defaultRadio.focus()

    function getSelectedAction() {
      const selected = modal.querySelector('input[name="delete-node-choice"]:checked')
      return selected?.value || 'unlink-parent'
    }

    function cleanup() {
      modal.style.display = 'none'
      overlay.removeEventListener('click', handleCancel)
      cancelBtn.removeEventListener('click', handleCancel)
      okBtn.removeEventListener('click', handleOk)
      document.removeEventListener('keydown', handleKeydown)
    }

    function handleCancel() {
      cleanup()
      resolve(null)
    }

    function handleOk() {
      cleanup()
      resolve(getSelectedAction())
    }

    function handleKeydown(event) {
      if (event.isComposing) return
      if (modal.style.display !== 'block') return
      if (event.key === 'Escape') {
        event.preventDefault()
        handleCancel()
      } else if (event.key === 'Enter' && dialog.contains(document.activeElement)) {
        event.preventDefault()
        handleOk()
      }
    }

    overlay.addEventListener('click', handleCancel)
    cancelBtn.addEventListener('click', handleCancel)
    okBtn.addEventListener('click', handleOk)
    document.addEventListener('keydown', handleKeydown)
  })
}

// 編集内容に変更があるかチェック
function checkDirty() {
  if (isDirtyCheckSuppressed()) {
    isDirty = false
    return false
  }

  if (!currentEditorNodeId || !initialNodeValues) {
    isDirty = false
    return false
  }

  const titleEl = document.getElementById('node-title')
  const authorEl = document.getElementById('node-author')
  const currentContent = window.currentEditor ? window.currentEditor.value() : ''

  const currentTitle = titleEl ? titleEl.value : ''
  const currentAuthorUserId = authorEl ? (parseInt(authorEl.value) || null) : null

  isDirty = (
    currentTitle !== initialNodeValues.title ||
    currentContent !== initialNodeValues.content ||
    currentAuthorUserId !== initialNodeValues.author_user_id
  )

  scheduleNodeDraftSave()

  return isDirty
}

async function confirmProceedWithUnsavedChanges() {
  return runWithUnsavedGuard(async () => {})
}

async function runWithUnsavedGuard(action) {
  if (typeof action !== 'function') return false
  if (isDirtyCheckSuppressed()) {
    await action()
    return true
  }
  if (!checkDirty()) {
    await action()
    return true
  }

  const answer = await showUnsavedConfirm()
  if (answer === 'yes') {
    const saved = await saveCurrentNode()
    if (!saved) return false
  } else {
    isDirty = false
    initialNodeValues = null
  }

  await action()
  return true
}

// コンテキストメニュー（右クリックメニュー）
let contextMenuNodeId = null
let contextMenuNodePath = null
let contextMenuParentNodeId = null

function createContextMenu() {
  let menu = document.getElementById('node-context-menu')
  if (!menu) {
    menu = document.createElement('div')
    menu.id = 'node-context-menu'
    menu.innerHTML = `
      <div class="context-menu-item" data-action="duplicate">
        <i class="fas fa-copy"></i>
        <span>${t('editor.duplicate')}</span>
        <span class="context-menu-shortcut">Alt+M</span>
      </div>
      <div class="context-menu-separator"></div>
      <div class="context-menu-item" data-action="copy">
        <i class="fas fa-clipboard"></i>
        <span>${t('editor.addParent')}</span>
        <span class="context-menu-shortcut">⌘C</span>
      </div>
      <div class="context-menu-item" data-action="cut">
        <i class="fas fa-cut"></i>
        <span>${t('editor.moveParent')}</span>
        <span class="context-menu-shortcut">⌘X</span>
      </div>
      <div class="context-menu-item" data-action="paste">
        <i class="fas fa-paste"></i>
        <span>${t('editor.pasteHelp')}</span>
        <span class="context-menu-shortcut">⌘V</span>
      </div>
      <div class="context-menu-separator"></div>
      <div class="context-menu-item" data-action="add-child">
        <i class="fas fa-plus"></i>
        <span>${t('editor.createChildNode')}</span>
        <span class="context-menu-shortcut">Alt+N</span>
      </div>
      <div class="context-menu-item" data-action="add-sibling">
        <i class="fas fa-plus-circle"></i>
        <span>${t('editor.createSiblingNode')}</span>
        <span class="context-menu-shortcut">Alt+Shift+N</span>
      </div>
      <div class="context-menu-separator"></div>
      <div class="context-submenu-trigger" data-action="sort-submenu">
        <i class="fas fa-sort"></i>
        <span>${t('editor.sort')}</span>
        <span class="context-menu-arrow">▶</span>
        <div class="context-submenu">
          <div class="context-menu-item" data-action="sort-mode-manual">
            <i class="fas fa-check context-menu-check"></i>
            <span>${t('editor.sortManualDefault')}</span>
          </div>
          <div class="context-menu-item" data-action="sort-mode-created_at">
            <i class="fas fa-check context-menu-check"></i>
            <span>${t('editor.sortCreatedAt')}</span>
          </div>
          <div class="context-menu-item" data-action="sort-mode-updated_at">
            <i class="fas fa-check context-menu-check"></i>
            <span>${t('editor.sortUpdatedAt')}</span>
          </div>
          <div class="context-menu-item" data-action="sort-mode-title">
            <i class="fas fa-check context-menu-check"></i>
            <span>${t('editor.sortTitle')}</span>
          </div>
          <div class="context-menu-separator"></div>
          <div class="context-menu-item" data-action="sort-direction-asc">
            <i class="fas fa-check context-menu-check"></i>
            <span>${t('editor.sortAscending')}</span>
          </div>
          <div class="context-menu-item" data-action="sort-direction-desc">
            <i class="fas fa-check context-menu-check"></i>
            <span>${t('editor.sortDescending')}</span>
          </div>
        </div>
      </div>
      <div class="context-menu-separator"></div>
      <div class="context-menu-item" data-action="move-up">
        <i class="fas fa-arrow-up"></i>
        <span>${t('editor.moveUp')}</span>
        <span class="context-menu-shortcut">Alt+↑</span>
      </div>
      <div class="context-menu-item" data-action="move-down">
        <i class="fas fa-arrow-down"></i>
        <span>${t('editor.moveDown')}</span>
        <span class="context-menu-shortcut">Alt+↓</span>
      </div>
      <div class="context-menu-separator"></div>
      <div class="context-menu-item" data-action="expand-descendants">
        <i class="fas fa-folder-open"></i>
        <span>${t('editor.expandChildNodes')}</span>
        <span class="context-menu-shortcut">Alt+O</span>
      </div>
      <div class="context-menu-item" data-action="collapse-descendants">
        <i class="fas fa-folder"></i>
        <span>${t('editor.collapseChildNodes')}</span>
        <span class="context-menu-shortcut">Alt+L</span>
      </div>
      <div class="context-menu-item" data-action="restore-from-trash">
        <i class="fas fa-undo"></i>
        <span>${t('editor.restore')}</span>
      </div>
      <div class="context-menu-item" data-action="permanently-delete">
        <i class="fas fa-trash"></i>
        <span>${t('editor.deletePermanently')}</span>
      </div>
    `
    document.body.appendChild(menu)

    // スタイルを追加
    const style = document.createElement('style')
    style.textContent = `
      #node-context-menu {
        display: none;
        position: fixed;
        background: white;
        border-radius: 8px;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
        padding: 6px 0;
        min-width: 180px;
        z-index: 10000;
      }
      #node-context-menu.active {
        display: block;
      }
      .context-menu-item {
        display: flex;
        align-items: center;
        padding: 4px 14px;
        cursor: pointer;
        font-size: 14px;
        line-height: 1.2;
        color: #374151;
        transition: background 0.15s;
      }
      .context-menu-item:hover {
        background: #f3f4f6;
      }
      .context-menu-item.disabled {
        color: #9ca3af;
        pointer-events: none;
      }
      .context-menu-section-title {
        font-size: 11px;
        font-weight: 600;
        color: #6b7280;
        padding: 2px 14px;
        text-transform: uppercase;
      }
      .context-menu-item i {
        width: 18px;
        margin-right: 10px;
        font-size: 13px;
        color: #6b7280;
      }
      .context-menu-check {
        opacity: 0;
      }
      .context-menu-item.active-sort .context-menu-check {
        opacity: 1;
        color: #2563eb;
      }
      .context-menu-item span:first-of-type {
        flex: 1;
      }
      .context-menu-shortcut {
        font-size: 11px;
        color: #9ca3af;
        margin-left: 16px;
      }
      .context-menu-multiline {
        display: flex;
        flex: 1;
        flex-direction: column;
        gap: 2px;
      }
      .context-menu-multiline-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .context-menu-shortcut-inline {
        font-size: 11px;
        color: #9ca3af;
        margin-left: 16px;
        white-space: nowrap;
      }
      .context-menu-separator {
        height: 1px;
        background: #e5e7eb;
        margin: 2px 0;
      }
      .context-submenu-trigger {
        display: flex;
        align-items: center;
        padding: 4px 14px;
        cursor: pointer;
        font-size: 14px;
        line-height: 1.2;
        color: #374151;
        transition: background 0.15s;
        position: relative;
      }
      .context-submenu-trigger:hover {
        background: #f3f4f6;
      }
      .context-submenu-trigger i {
        width: 18px;
        margin-right: 10px;
        font-size: 13px;
        color: #6b7280;
      }
      .context-submenu-trigger span:first-of-type {
        flex: 1;
      }
      .context-menu-arrow {
        font-size: 10px;
        color: #9ca3af;
        margin-left: 8px;
      }
      .context-submenu {
        display: none;
        position: absolute;
        left: 100%;
        top: 0;
        background: white;
        border-radius: 8px;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
        padding: 6px 0;
        min-width: 160px;
        z-index: 10001;
      }
      .context-submenu-trigger:hover > .context-submenu {
        display: block;
      }
      /* ダークテーマ上書き */
      html.theme-dark #node-context-menu,
      html.theme-dark .context-submenu {
        background: #1f2937;
      }
      html.theme-dark .context-menu-item,
      html.theme-dark .context-submenu-trigger {
        color: #e5e7eb;
      }
      html.theme-dark .context-menu-item:hover,
      html.theme-dark .context-submenu-trigger:hover {
        background: #111827;
      }
      html.theme-dark .context-menu-section-title {
        color: #9ca3af;
      }
      html.theme-dark .context-menu-item i,
      html.theme-dark .context-submenu-trigger i {
        color: #9ca3af;
      }
      html.theme-dark .context-menu-separator {
        background: #374151;
      }
      html.theme-dark .context-menu-item.active-sort .context-menu-check {
        color: #60a5fa;
      }
    `
    document.head.appendChild(style)

    // メニュー項目のクリック処理
    menu.querySelectorAll('.context-menu-item').forEach(item => {
      item.addEventListener('click', async (e) => {
        e.stopPropagation()
        const action = item.dataset.action
        const keepMenuOpen = isContextSortAction(action)
        if (!keepMenuOpen) hideContextMenu()
        await handleContextMenuAction(action)
        if (keepMenuOpen) {
          updateContextMenuSortState(menu)
        }
      })
    })

    // サブメニュートリガーのクリックではメニューを閉じない
    menu.querySelectorAll('.context-submenu-trigger').forEach(trigger => {
      trigger.addEventListener('click', (e) => {
        e.stopPropagation()
      })
    })

    // 外側クリックで閉じる
    document.addEventListener('click', hideContextMenu)
  }
  return menu
}

function isContextSortAction(action) {
  return action?.startsWith('sort-mode-') || action?.startsWith('sort-direction-')
}

function updateContextMenuSortState(menu) {
  if (!menu || !contextMenuNodeId) return
  const sortConfig = getChildSortConfig(contextMenuNodeId)
  const sortModeActions = ['manual', 'created_at', 'updated_at', 'title']
  sortModeActions.forEach(mode => {
    const item = menu.querySelector(`[data-action="sort-mode-${mode}"]`)
    if (!item) return
    item.classList.toggle('active-sort', sortConfig.mode === mode)
  })
  const ascItem = menu.querySelector('[data-action="sort-direction-asc"]')
  const descItem = menu.querySelector('[data-action="sort-direction-desc"]')
  if (ascItem) ascItem.classList.toggle('active-sort', sortConfig.direction === 'asc')
  if (descItem) descItem.classList.toggle('active-sort', sortConfig.direction === 'desc')

  const moveUpItem = menu.querySelector('[data-action="move-up"]')
  const moveDownItem = menu.querySelector('[data-action="move-down"]')
  if (moveUpItem) moveUpItem.classList.toggle('disabled', !isManualSortForParent(contextMenuParentNodeId))
  if (moveDownItem) moveDownItem.classList.toggle('disabled', !isManualSortForParent(contextMenuParentNodeId))
}

function showContextMenu(e, nodeId, nodePath) {
  e.preventDefault()
  e.stopPropagation()

  contextMenuNodeId = nodeId
  contextMenuNodePath = nodePath

  const menu = createContextMenu()

  // ペーストの有効/無効
  const pasteItem = menu.querySelector('[data-action="paste"]')
  if (clipboard) {
    pasteItem.classList.remove('disabled')
  } else {
    pasteItem.classList.add('disabled')
  }

  contextMenuParentNodeId = getParentNodeIdFromPath(nodePath)
  const isReverseView = treeViewMode === 'reverse'
  const isTrashView = treeViewMode === 'trash'
  const isTrashActionEnabled = isTrashView && contextMenuNodeId !== currentTrashRootNodeId

  const menuItems = menu.querySelectorAll(':scope > .context-menu-item')
  const separators = menu.querySelectorAll(':scope > .context-menu-separator')
  const submenuTriggers = menu.querySelectorAll(':scope > .context-submenu-trigger')
  if (isTrashView) {
    menuItems.forEach(item => {
      const action = item.dataset.action
      const visible = action === 'restore-from-trash' || action === 'permanently-delete'
      item.style.display = visible ? 'flex' : 'none'
      if (visible) item.classList.toggle('disabled', !isTrashActionEnabled)
    })
    separators.forEach(el => { el.style.display = 'none' })
    submenuTriggers.forEach(el => { el.style.display = 'none' })
  } else if (isReverseView) {
    menuItems.forEach(item => {
      const action = item.dataset.action
      const visible = action === 'expand-descendants' || action === 'collapse-descendants'
      item.style.display = visible ? 'flex' : 'none'
    })
    separators.forEach(el => { el.style.display = 'none' })
    submenuTriggers.forEach(el => { el.style.display = 'none' })
  } else {
    menuItems.forEach(item => {
      const action = item.dataset.action
      const hideInNormal = action === 'restore-from-trash' || action === 'permanently-delete'
      item.style.display = hideInNormal ? 'none' : ''
      item.classList.remove('disabled')
    })
    separators.forEach(el => { el.style.display = '' })
    submenuTriggers.forEach(el => { el.style.display = '' })
  }

  updateContextMenuSortState(menu)

  // メニュー位置を設定
  const x = e.clientX
  const y = e.clientY

  menu.style.left = `${x}px`
  menu.style.top = `${y}px`
  menu.classList.add('active')

  // 画面外にはみ出ないよう調整
  const rect = menu.getBoundingClientRect()
  if (rect.right > window.innerWidth) {
    menu.style.left = `${window.innerWidth - rect.width - 10}px`
  }
  if (rect.bottom > window.innerHeight) {
    menu.style.top = `${window.innerHeight - rect.height - 10}px`
  }
}

function getDisplayChildEntries(nodeId, currentPath) {
  if (!nodeId || !currentPath) return []
  if (treeViewMode === 'reverse') {
    return (relationParentsByChild.get(nodeId) || [])
      .filter(rel => rel.parent_node_id !== currentRootNodeId)
      .map(rel => ({
        id: rel.parent_node_id,
        path: `${currentPath}-${rel.parent_node_id}`
      }))
  }
  return (relationChildrenByParent.get(nodeId) || [])
    .map(rel => ({
      id: rel.child_node_id,
      path: `${currentPath}-${rel.child_node_id}`
    }))
}

function collectDisplayDescendantEntries(rootNodeId, rootPath) {
  const visitedPaths = new Set()
  const descendants = []
  const stack = [...getDisplayChildEntries(rootNodeId, rootPath)]

  while (stack.length > 0) {
    const entry = stack.pop()
    if (!entry || !entry.id || !entry.path || visitedPaths.has(entry.path)) continue
    visitedPaths.add(entry.path)
    descendants.push(entry)
    const children = getDisplayChildEntries(entry.id, entry.path)
    for (const child of children) stack.push(child)
  }

  return descendants
}

function expandNodeDescendants(nodeId, nodePath) {
  if (!nodeId || !nodePath) return
  expandedNodes.delete(nodeId)
  expandedNodePaths.add(nodePath)
  const descendants = collectDisplayDescendantEntries(nodeId, nodePath)
  descendants.forEach(entry => {
    expandedNodes.delete(entry.id)
    expandedNodePaths.add(entry.path)
  })
}

function expandNodeDirectChildren(nodeId, nodePath) {
  if (!nodeId || !nodePath) return
  expandedNodes.delete(nodeId)
  expandedNodePaths.add(nodePath)
  const children = getDisplayChildEntries(nodeId, nodePath)
  children.forEach(entry => {
    expandedNodes.delete(entry.id)
    expandedNodePaths.delete(entry.path)
  })
}

function collapseNodeDescendants(nodeId, nodePath, options = {}) {
  if (!nodeId || !nodePath) return
  const keepNodeExpanded = options.keepNodeExpanded !== false
  expandedNodes.delete(nodeId)
  if (keepNodeExpanded) {
    // Keep the target node expanded so its direct children remain visible.
    expandedNodePaths.add(nodePath)
  } else {
    expandedNodePaths.delete(nodePath)
  }
  const descendants = collectDisplayDescendantEntries(nodeId, nodePath)
  descendants.forEach(entry => {
    expandedNodes.delete(entry.id)
    expandedNodePaths.delete(entry.path)
  })
}

function hideContextMenu() {
  const menu = document.getElementById('node-context-menu')
  if (menu) {
    menu.classList.remove('active')
  }
}

async function updateNodeSortSettings(nodeId, mode, direction) {
  const response = await axios.patch(`/api/trees/${currentTreeId}/nodes/${nodeId}/sort-settings`, {
    child_sort_mode: mode,
    child_sort_direction: direction
  })
  return response.data?.success
}

async function applySortForContextParent(nextMode, nextDirection) {
  // ソート設定は「右クリックしたノード（親）」に保存し、その子ノード順へ適用する
  if (!contextMenuNodeId) return false
  const current = getChildSortConfig(contextMenuNodeId)
  const mode = normalizeSortMode(nextMode || current.mode)
  const direction = normalizeSortDirection(nextDirection || current.direction)

  const success = await updateNodeSortSettings(contextMenuNodeId, mode, direction)
  if (!success) return false
  await fetchNodes()
  return true
}

async function handleContextMenuAction(action) {
  if (!contextMenuNodeId) return

  switch (action) {
    case 'duplicate':
      await duplicateNode(contextMenuNodeId, contextMenuNodePath)
      break
    case 'copy':
      setInternalClipboardByNodePath(contextMenuNodeId, contextMenuNodePath)
      await writeNodePlainTextToSystemClipboard(contextMenuNodeId)
      break
    case 'cut': {
      setInternalClipboardByNodePath(contextMenuNodeId, contextMenuNodePath, null, 'cut')
      await writeNodePlainTextToSystemClipboard(contextMenuNodeId)
      break
    }
    case 'paste':
      if (clipboard && contextMenuNodeId) {
        if (contextMenuNodePath) expandedNodePaths.add(contextMenuNodePath)
        const shouldMove = clipboardMode === 'cut' && clipboardSourceParentId !== undefined && clipboardSourceParentId !== null
        let pasteSuccess = false

        if (shouldMove) {
          pasteSuccess = await moveRelation(clipboard, clipboardSourceParentId, contextMenuNodeId, null, { reload: false })
        } else {
          pasteSuccess = await addRelation(contextMenuNodeId, clipboard, { reload: false })
          if (pasteSuccess) {
            await fetchNodes()
          }
        }

        if (pasteSuccess) {
          if (shouldMove && clipboardSourceParentId !== undefined) {
            clipboard = null
            clipboardMode = null
            clipboardSourceParentId = undefined
          }
        }
      }
      break
    case 'add-child':
      await addChildNode(contextMenuNodeId)
      break
    case 'add-sibling': {
      const targetEl = document.querySelector(`.tree-item[data-node-path="${contextMenuNodePath}"]`)
      await addSiblingNode(targetEl)
      break
    }
    case 'sort-mode-manual':
      if (!(await applySortForContextParent('manual', null))) {
        showToast(t('editor.sortSaveFailed'), 'error')
      }
      break
    case 'sort-mode-created_at':
      if (!(await applySortForContextParent('created_at', null))) {
        showToast(t('editor.sortSaveFailed'), 'error')
      }
      break
    case 'sort-mode-updated_at':
      if (!(await applySortForContextParent('updated_at', null))) {
        showToast(t('editor.sortSaveFailed'), 'error')
      }
      break
    case 'sort-mode-title':
      if (!(await applySortForContextParent('title', null))) {
        showToast(t('editor.sortSaveFailed'), 'error')
      }
      break
    case 'sort-direction-asc':
      if (!(await applySortForContextParent(null, 'asc'))) {
        showToast(t('editor.sortSaveFailed'), 'error')
      }
      break
    case 'sort-direction-desc':
      if (!(await applySortForContextParent(null, 'desc'))) {
        showToast(t('editor.sortSaveFailed'), 'error')
      }
      break
    case 'move-up': {
      if (!isManualSortForParent(contextMenuParentNodeId)) return
      const upEl = document.querySelector(`.tree-item[data-node-path="${contextMenuNodePath}"]`)
      await moveNodeInSiblings(-1, upEl)
      break
    }
    case 'move-down': {
      if (!isManualSortForParent(contextMenuParentNodeId)) return
      const downEl = document.querySelector(`.tree-item[data-node-path="${contextMenuNodePath}"]`)
      await moveNodeInSiblings(1, downEl)
      break
    }
    case 'expand-descendants':
      expandNodeDescendants(contextMenuNodeId, contextMenuNodePath)
      renderTree()
      break
    case 'collapse-descendants':
      collapseNodeDescendants(contextMenuNodeId, contextMenuNodePath)
      renderTree()
      break
    case 'restore-from-trash':
      await restoreNodeFromTrash(contextMenuNodeId)
      break
    case 'permanently-delete':
      await permanentlyDeleteNode(contextMenuNodeId)
      break
  }

  contextMenuParentNodeId = null
}

async function duplicateNode(nodeId, nodePath) {
  if (!canEdit()) {
    showToast(t('editor.editPermissionRequired'), 'error')
    return
  }

  // パスから親IDを取得
  let parentId = null
  if (nodePath) {
    const pathParts = nodePath.split('-')
    if (pathParts.length > 1) {
      parentId = pathParts[pathParts.length - 2]
    }
  }

  // トップレベルノード（親がパスにない）場合は、隠しルートノードを親にする
  if (!parentId && currentRootNodeId) {
    parentId = currentRootNodeId
  }

  showLoading()
  try {
    if (!parentId) {
      showToast(t('editor.duplicateParentNotFound'), 'error')
      return
    }

    const response = await axios.post(`/api/trees/${currentTreeId}/nodes/${nodeId}/duplicate`, {
      parent_node_id: parentId,
      copy_images: true
    })
    const duplicatedNode = response.data?.success ? response.data.data?.node : null

    if (duplicatedNode?.id) {
      if (nodePath) {
        const pathParts = nodePath.split('-')
        if (pathParts.length > 1) {
          expandedNodePaths.add(pathParts.slice(0, -1).join('-'))
        }
      }
      await fetchNodes()
      await selectNode(duplicatedNode.id)
    }

  } catch (error) {
    console.error('Failed to duplicate node:', error)
    if (error.response?.data?.error) {
      showToast(t('editor.duplicateFailedWithReason', { reason: error.response.data.error }), 'error')
    } else {
      showToast(t('editor.duplicateFailed'), 'error')
    }
  } finally {
    hideLoading()
  }
}

// トースト通知の表示
function showToast(message, type = 'success', duration = 5000) {
  const normalizedMessage = (message === null || message === undefined) ? '' : String(message)
  if (
    window.ZeetaAuth?.isRedirectScheduled?.() &&
    normalizedMessage !== window.ZeetaAuth?.SESSION_EXPIRED_MESSAGE
  ) {
    return
  }

  const toast = document.createElement('div')
  toast.className = `toast toast-${type}`

  // アイコンを決定
  const icon = type === 'success' ? '✓' : (type === 'info' ? 'ℹ' : '⚠')

  toast.innerHTML = `
    <div class="toast-icon">${icon}</div>
    <span class="toast-message">${normalizedMessage}</span>
    <button class="toast-close" onclick="this.parentElement.remove()">×</button>
  `
  document.body.appendChild(toast)

  // アニメーション用にちょっと遅延
  setTimeout(() => toast.classList.add('show'), 10)

  // 自動削除
  setTimeout(() => {
    toast.classList.remove('show')
    setTimeout(() => toast.remove(), 300)
  }, duration)
}

// ===============================
// Authentication & Tree Context
// ===============================

/**
 * Check if user is authenticated
 */
async function checkAuth() {
  try {
    const response = await axios.get('/auth/me')
    if (response.data.success && response.data.data) {
      currentUser = response.data.data
      return true
    }
    return false
  } catch (error) {
    console.error('Auth check failed:', error)
    return false
  }
}

/**
 * Get tree ID from URL query parameter
 */
function getTreeIdFromURL() {
  const params = new URLSearchParams(window.location.search)
  const treeId = params.get('tree')
  return treeId ? parseInt(treeId) : null
}

/**
 * Get node ID from URL query parameter
 */
function getNodeIdFromURL() {
  const params = new URLSearchParams(window.location.search)
  const nodeId = params.get('node')
  return nodeId || null
}

function buildNodeShareUrl(nodeId) {
  if (!Number.isFinite(currentTreeId) || currentTreeId <= 0 || !nodeId) {
    return ''
  }
  const url = new URL('/index.html', window.location.origin)
  url.searchParams.set('tree', String(currentTreeId))
  url.searchParams.set('node', String(nodeId))
  return url.toString()
}

/**
 * ツリーの詳細を取得する。開けない（削除済み・権限なし・通信失敗）ときは null
 * @param {number} treeId
 * @returns {Promise<object|null>}
 */
async function fetchTreeDetail(treeId) {
  try {
    const treeRes = await axios.get(`/api/trees/${treeId}`)
    return treeRes.data.success ? treeRes.data.data : null
  } catch (error) {
    console.error('Failed to load tree context:', error)
    return null
  }
}

/**
 * Load tree information and check access
 *
 * 着地先の決め方（マイページ廃止後）:
 * - URL の ?tree= が開けるツリーならそれを開く
 * - 開けない（存在しない・権限なし）ならエラーを出して、最後に開いたツリーへ切り替える
 * - ?tree= が無ければ、最後に開いたツリー → 一覧の先頭
 * - ツリーが0件なら 'empty' を返し、作成を促す空画面を出す
 * @returns {Promise<'ok'|'empty'|'error'>}
 */
async function loadTreeContext() {
  let trees
  try {
    const treesRes = await axios.get('/api/trees')
    if (!treesRes.data.success || !Array.isArray(treesRes.data.data)) {
      showToast(t('editor.treeInfoFetchFailed'), 'error')
      return 'error'
    }
    trees = treesRes.data.data
  } catch (error) {
    console.error('Failed to load tree list:', error)
    showToast(t('editor.treeInfoLoadFailed'), 'error')
    return 'error'
  }

  const requestedTreeId = getTreeIdFromURL()
  const requestedTree = requestedTreeId ? trees.find(tree => tree.id === requestedTreeId) : null
  let unavailableNotified = false
  const notifyUnavailable = () => {
    if (unavailableNotified) return
    unavailableNotified = true
    showToast(t('mypage.treeUnavailable'), 'error')
  }
  if (requestedTreeId && !requestedTree) notifyUnavailable()

  // 一覧に出ていても、直前の削除・権限変更で詳細を開けないことがある。
  // そのときも決めたこと A に従い、エラーを出して次の着地先へ切り替える
  let candidates = trees
  let targetTree = requestedTree || window.ZeetaTreeRail.pickLandingTree(candidates)
  let loadedTree = null
  let fetchFailed = false
  while (targetTree && !loadedTree) {
    loadedTree = await fetchTreeDetail(targetTree.id)
    if (loadedTree) break
    fetchFailed = true
    notifyUnavailable()
    candidates = candidates.filter(tree => tree.id !== targetTree.id)
    targetTree = window.ZeetaTreeRail.pickLandingTree(candidates)
  }

  window.ZeetaTreeRail.init({ trees, currentTreeId: targetTree?.id ?? null, currentUser })
  if (!targetTree) {
    currentTreeId = null
    currentTree = null
    if (requestedTreeId) {
      // 開けないツリー ID を URL に残さない
      window.history.replaceState(window.history.state, '', '/index.html')
    }
    // 一覧はあるのに1件も開けなかった場合は空画面ではなくエラー扱いにする
    return fetchFailed ? 'error' : 'empty'
  }

  if (targetTree.id !== requestedTreeId) {
    // 着地先へ切り替えたことが URL でも分かるようにする（共有・再読み込み用）
    const landingUrl = new URL(window.location.href)
    landingUrl.pathname = '/index.html'
    landingUrl.search = `?tree=${targetTree.id}`
    window.history.replaceState(window.history.state, '', landingUrl.toString())
  }

  currentTreeId = targetTree.id
  currentUserRole = targetTree.role
  currentTree = loadedTree

  window.ZeetaTreeRail.markLastAccessed(currentTreeId)
  updateTreeHeader()
  return 'ok'
}

/**
 * Update header with tree information
 */
function updateTreeHeader() {
  // Add header if it doesn't exist
  let header = document.getElementById('tree-header')
  if (!header) {
    header = document.createElement('div')
    header.id = 'tree-header'
    document.body.insertBefore(header, document.body.firstChild)
  }
  // Apply header style even when #tree-header already exists in HTML.
  header.style.cssText = `
    padding: 2px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 100;
    box-sizing: border-box;
  `

  const roleLabels = {
    owner: t('mypage.roleOwner'),
    editor: t('mypage.roleEditor'),
    viewer: t('mypage.roleViewer')
  }
  const roleLabelsShort = {
    owner: 'O',
    editor: 'E',
    viewer: 'V'
  }
  const canGoBack = nodeNavHistoryIndex > 0
  const canGoForward = nodeNavHistoryIndex >= 0 && nodeNavHistoryIndex < nodeNavHistory.length - 1
  // ロールバッジの色はダークテーマ上書きが効くようTailwindクラスで指定する
  const roleBadgeClass = currentUserRole === 'owner'
    ? 'border-blue-300 text-blue-700'
    : currentUserRole === 'editor'
      ? 'border-green-300 text-green-700'
      : 'border-gray-300 text-gray-600'

  // ツリーが0件の空画面ではツリー名・ロール・ノード操作を出さない
  const hasTree = !!currentTree
  const treeOnly = (html) => (hasTree ? html : '')

  header.innerHTML = `
    <div style="display: flex; align-items: center; gap: 0.85rem; min-width: 0; padding-left: 6px;">
      ${window.ZeetaTreeRail.menuButtonHtml()}
      <h1 id="tree-header-title" class="text-gray-800" style="margin: 0; font-size: 1.25rem; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0;">${hasTree ? escapeHtml(currentTree.name) : 'Zeeta Web'}</h1>
      ${treeOnly(`<span class="bg-white border ${roleBadgeClass}" style="
        padding: 0.22rem 0.7rem;
        border-radius: 9999px;
        font-size: 0.75rem;
        font-weight: 600;
        line-height: 1.1;
        white-space: nowrap;
      ">
        <span class="role-label-full">${roleLabels[currentUserRole] || currentUserRole}</span>
        <span class="role-label-short">${roleLabelsShort[currentUserRole] || ''}</span>
      </span>`)}
      <span id="update-badge-slot"></span>
      ${hasTree && currentUserRole === 'viewer' ? `<span class="text-gray-500" style="font-size: 0.8rem; font-weight: 500; white-space: nowrap;">${t('editor.viewOnly')}</span>` : ''}
    </div>
    <div style="display: flex; align-items: center; gap: 4px; padding-right: 12px; flex-shrink: 0;">
      ${treeOnly(`<button id="history-back-btn" onclick="navigateNodeHistoryBack()" ${canGoBack ? '' : 'disabled'} class="text-gray-500 ${canGoBack ? 'hover:text-indigo-500 hover:bg-gray-100' : ''}" style="
        border: none;
        cursor: ${canGoBack ? 'pointer' : 'not-allowed'};
        opacity: ${canGoBack ? '1' : '0.45'};
        padding: 6px;
        border-radius: 6px;
        transition: color 0.2s, background 0.2s;
      " title="${t('editor.historyBackTitle')}">
        <i class="fas fa-circle-arrow-left"></i>
      </button>
      <button id="history-forward-btn" onclick="navigateNodeHistoryForward()" ${canGoForward ? '' : 'disabled'} class="text-gray-500 ${canGoForward ? 'hover:text-indigo-500 hover:bg-gray-100' : ''}" style="
        border: none;
        cursor: ${canGoForward ? 'pointer' : 'not-allowed'};
        opacity: ${canGoForward ? '1' : '0.45'};
        padding: 6px;
        border-radius: 6px;
        transition: color 0.2s, background 0.2s;
      " title="${t('editor.historyForwardTitle')}">
        <i class="fas fa-circle-arrow-right"></i>
      </button>
      <label title="${t('editor.markdownPreviewOnNavigation')}" aria-label="${t('editor.markdownPreviewOnNavigation')}" class="text-gray-600" style="
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 13px;
        user-select: none;
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 6px;
      ">
        <input id="md-preview-toggle" type="checkbox" ${isMarkdownPreviewPreferred() ? 'checked' : ''} />
        <span>preview</span>
      </label>`)}
      <span class="header-account-sep" aria-hidden="true"></span>
      <a href="/help.html?tab=editor" target="_blank" rel="noopener noreferrer" title="${t('common.help')}" class="text-gray-500 hover:text-indigo-500 hover:bg-gray-100" style="
        text-decoration: none;
        font-size: 18px;
        line-height: 1;
        padding: 6px;
        border-radius: 6px;
      ">
        <i class="fas fa-circle-question"></i>
      </a>
      ${window.ZeetaTreeRail.headerAccountHtml()}
    </div>
  `
  window.ZeetaTreeRail.bindHeaderEvents()
  const reloadTreeBtn = document.getElementById('reload-tree-btn')
  if (reloadTreeBtn) {
    reloadTreeBtn.addEventListener('click', async () => {
      await reloadTreeData()
    })
  }
  const treeSearchBtn = document.getElementById('tree-search-btn')
  if (treeSearchBtn) {
    treeSearchBtn.addEventListener('click', () => {
      openSearchPopup()
    })
  }
  const previewToggle = document.getElementById('md-preview-toggle')
  if (previewToggle) {
    previewToggle.addEventListener('change', (event) => {
      const enabled = !!event.target.checked
      setMarkdownPreviewPreferred(enabled)
      applyMarkdownPreviewPreference()
    })
  }
  updateNodeHistoryButtonsState()
  syncMainContainerWithHeaderHeight()
  if (!headerHeightSyncInitialized) {
    window.addEventListener('resize', syncMainContainerWithHeaderHeight)
    headerHeightSyncInitialized = true
  }

  // Disable editing controls if viewer
  if (currentUserRole === 'viewer') {
    disableEditingForViewer()
  }

  document.dispatchEvent(new CustomEvent('zeeta:tree-header-rendered'))
}

/**
 * Disable editing controls for viewer role
 */
function disableEditingForViewer() {
  // Disable all input fields and buttons related to editing
  const editControls = [
    '#node-title',
    '#node-content',
    '#node-author',
    '#new-node-title',
    '#new-node-content',
    '#save-node-btn',
    '#create-node-btn',
    '#update-node-btn',
    '#delete-node-btn',
    '.add-child-btn',
    '.delete-relation-btn'
  ]

  editControls.forEach(selector => {
    const elements = document.querySelectorAll(selector)
    elements.forEach(el => {
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        el.disabled = true
        el.classList.add('bg-gray-50')
      } else if (el.tagName === 'BUTTON') {
        el.disabled = true
        el.style.opacity = '0.5'
        el.style.cursor = 'not-allowed'
      }
    })
  })

  // Show viewer notice
  showToast(t('editor.viewOnlyModeNotice'), 'info', 8000)
}

/**
 * Check if user can edit (owner or editor)
 */
function canEdit() {
  return currentUserRole === 'owner' || currentUserRole === 'editor'
}

function closeNodeDetailDialog() {
  const dialog = document.getElementById('node-detail-dialog')
  if (!dialog) return
  nodeDetailLoadRequestId += 1
  nodeDetailSelectedVersion = null
  nodeDetailSelectedIsCurrent = false
  nodeDetailCurrentVersion = null
  nodeDetailPreviewCache = new Map()
  nodeDetailRestoreInFlight = false
  nodeDetailNodeId = null
  nodeDetailHistoryItems = []
  nodeDetailCompareVersion = null
  nodeDetailCompareInFlight = false
  closeNodeCompareOverlay()
  const copyBtn = document.getElementById('node-detail-copy-btn')
  if (copyBtn) copyBtn.disabled = true
  dialog.classList.remove('flex')
  dialog.classList.add('hidden')
}

function nodeHistoryActorLabel(actor) {
  const person = actor?.display_name || actor?.email || 'Unknown'
  return actor?.client_name ? `${person}（${actor.client_name}）` : person
}

function formatHistoryVersionLabel(item) {
  return [formatDate(item.authored_at), nodeHistoryActorLabel(item.actor)].filter(Boolean).join(' ')
}

async function selectNodeDetailHistoryVersion(nodeId, item, requestId) {
  if (requestId !== nodeDetailLoadRequestId) return
  nodeDetailSelectedVersion = item.node_version
  nodeDetailSelectedIsCurrent = item.is_current === true
  document.querySelectorAll('#node-detail-history-list .node-detail-history-row').forEach(row => {
    const isSelected = Number(row.dataset.nodeVersion) === item.node_version
    row.setAttribute('aria-selected', String(isSelected))
    row.closest('.node-detail-history-item')?.classList.toggle('is-selected', isSelected)
  })
  // 選択行が比較対象そのものになった場合は比較を成立させられないので解除する
  if (nodeDetailCompareVersion === item.node_version) nodeDetailCompareVersion = null
  syncNodeDetailCompareControls()
  // 現在行は「現状へ戻す」操作が無意味なため「戻す」を有効化しない
  const restoreBtn = document.getElementById('node-detail-restore-btn')
  if (restoreBtn && canEdit() && !nodeDetailRestoreInFlight && !nodeDetailSelectedIsCurrent) restoreBtn.disabled = false
  const copyBtn = document.getElementById('node-detail-copy-btn')
  if (copyBtn) copyBtn.disabled = false
  const preview = document.getElementById('node-detail-preview')
  if (!preview) return
  if (nodeDetailPreviewCache.has(item.node_version)) {
    preview.textContent = nodeDetailPreviewCache.get(item.node_version)
    return
  }
  preview.textContent = t('editor.previewLoading')
  try {
    const response = await axios.get(`/api/trees/${currentTreeId}/nodes/${nodeId}/history/${item.node_version}`)
    if (requestId !== nodeDetailLoadRequestId || nodeDetailSelectedVersion !== item.node_version) return
    const content = response.data.data?.content || ''
    nodeDetailPreviewCache.set(item.node_version, content)
    preview.textContent = content
  } catch (error) {
    if (requestId !== nodeDetailLoadRequestId || nodeDetailSelectedVersion !== item.node_version) return
    preview.textContent = error.response?.data?.error || t('editor.historyPreviewFailed')
  }
}

// ラジオと「比較」ボタンの状態を行選択・比較選択に同期する
function syncNodeDetailCompareControls() {
  const compareBtn = document.getElementById('node-detail-compare-btn')
  if (compareBtn) compareBtn.disabled = nodeDetailCompareVersion == null || nodeDetailCompareInFlight
  document.querySelectorAll('#node-detail-history-list input[name="node-detail-compare"]').forEach(input => {
    const version = Number(input.dataset.nodeVersion)
    input.checked = version === nodeDetailCompareVersion
    input.disabled = version === nodeDetailSelectedVersion
  })
}

function createNodeDetailHistoryItem(nodeId, item, requestId) {
  const itemEl = document.createElement('div')
  itemEl.className = 'node-detail-history-item'
  const radioCell = document.createElement('span')
  radioCell.className = 'node-detail-history-radio-cell'
  const radio = document.createElement('input')
  radio.type = 'radio'
  radio.name = 'node-detail-compare'
  radio.dataset.nodeVersion = String(item.node_version)
  radio.setAttribute('aria-label', t('editor.compareRadioAriaLabel'))
  radio.title = t('editor.compareRadioTooltip')
  radio.addEventListener('change', () => {
    if (requestId !== nodeDetailLoadRequestId) return
    if (radio.disabled) return
    nodeDetailCompareVersion = Number(radio.dataset.nodeVersion)
    syncNodeDetailCompareControls()
  })
  radioCell.appendChild(radio)
  itemEl.append(radioCell, createNodeDetailHistoryRow(nodeId, item, requestId))
  return itemEl
}

function createNodeDetailHistoryRow(nodeId, item, requestId) {
  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'node-detail-history-row text-sm text-gray-700'
  row.dataset.nodeVersion = String(item.node_version)
  if (item.is_current) row.dataset.isCurrent = 'true'
  row.setAttribute('aria-selected', 'false')
  const authoredAt = document.createElement('span')
  authoredAt.textContent = formatDate(item.authored_at)
  authoredAt.title = item.is_current ? t('editor.currentVersionHelp') : t('editor.authoredAtHelp')
  const actor = document.createElement('span')
  const actorLabel = nodeHistoryActorLabel(item.actor)
  actor.textContent = actorLabel
  actor.title = actorLabel
  if (item.is_current) {
    // 現在行はアイコンを追加せず、日時と更新者の値を太字で示す
    authoredAt.classList.add('font-bold')
    actor.classList.add('font-bold')
  }
  row.append(authoredAt, actor)
  row.addEventListener('click', () => selectNodeDetailHistoryVersion(nodeId, item, requestId))
  return row
}

async function loadNodeDetailHistory(nodeId) {
  const requestId = ++nodeDetailLoadRequestId
  nodeDetailSelectedVersion = null
  nodeDetailSelectedIsCurrent = false
  nodeDetailCurrentVersion = null
  nodeDetailPreviewCache = new Map()
  nodeDetailHistoryItems = []
  nodeDetailCompareVersion = null
  nodeDetailCompareInFlight = false
  const list = document.getElementById('node-detail-history-list')
  const preview = document.getElementById('node-detail-preview')
  const restoreBtn = document.getElementById('node-detail-restore-btn')
  const copyBtn = document.getElementById('node-detail-copy-btn')
  if (!list || !preview || !restoreBtn) return
  list.replaceChildren()
  if (copyBtn) copyBtn.disabled = true
  const loading = document.createElement('div')
  loading.className = 'p-4 text-sm text-gray-500'
  loading.textContent = t('editor.historyLoading')
  list.appendChild(loading)
  preview.textContent = t('editor.selectHistoryVersion')
  restoreBtn.disabled = true
  try {
    // 現在行の content は snapshot に存在しない（snapshot は置き換え前の版のみ）ため
    // node を取得して使う。履歴一覧と並行取得し、クロージャの古い node 参照は使わない
    const [response, currentNode] = await Promise.all([
      axios.get(`/api/trees/${currentTreeId}/nodes/${nodeId}/history`, { params: { limit: 100 } }),
      fetchNodeById(nodeId),
    ])
    if (requestId !== nodeDetailLoadRequestId) return
    const items = response.data.items || []
    nodeDetailCurrentVersion = response.data.current_version
    const current = response.data.current
    list.replaceChildren()
    if (!current || !currentNode) {
      // 現在状態が取れない異常系のみ空表示。通常は snapshot 0件でも現在行が1行出る
      const empty = document.createElement('div')
      empty.className = 'p-4 text-sm text-gray-500'
      empty.textContent = t('editor.noContentHistory')
      list.appendChild(empty)
      preview.textContent = t('editor.noContentHistory')
      return
    }
    const currentItem = {
      node_version: current.version,
      authored_at: current.updated_at,
      actor: current.actor,
      is_current: true,
    }
    // 現在行の content を cache に先行投入。以降は snapshot 行と同じ選択フローで動く
    nodeDetailPreviewCache.set(current.version, currentNode.content || '')
    const rows = [currentItem, ...items.map((item) => ({ ...item, is_current: false }))]
    nodeDetailHistoryItems = rows
    for (const item of rows) {
      list.appendChild(createNodeDetailHistoryItem(nodeId, item, requestId))
    }
    await selectNodeDetailHistoryVersion(nodeId, rows[0], requestId)
    // 比較相手（ラジオ）は初期未選択。ユーザがラジオを選ぶまで「比較」は無効のまま
  } catch (error) {
    if (requestId !== nodeDetailLoadRequestId) return
    list.replaceChildren()
    const failure = document.createElement('div')
    failure.className = 'p-4 text-sm text-red-600'
    failure.textContent = error.response?.data?.error || t('editor.historyLoadFailed')
    list.appendChild(failure)
    preview.textContent = t('editor.historyLoadFailed')
  }
}

function closeNodeCompareOverlay() {
  const overlay = document.getElementById('node-compare-overlay')
  if (!overlay) return
  overlay.classList.remove('flex')
  overlay.classList.add('hidden')
}

// ユニファイド差分行と、右端の差分ナビ帯を描く。行はそのまま、連続する added/removed の
// 区間（hunk）は div.node-compare-diff-hunk で包む。帯の目盛は hunk 単位で作る
function renderNodeCompareDiff(container, stripEl, oldContent, newContent) {
  container.replaceChildren()
  stripEl?.replaceChildren()
  if (!window.Diff || typeof window.Diff.diffLines !== 'function') {
    const missing = document.createElement('div')
    missing.className = 'p-4 text-sm text-red-600'
    missing.textContent = t('editor.compareLoadFailed')
    container.appendChild(missing)
    return
  }
  const fragment = document.createDocumentFragment()
  const hunks = []
  let hunk = null
  for (const part of window.Diff.diffLines(oldContent, newContent)) {
    const state = part.added ? ' added' : part.removed ? ' removed' : ''
    if (state) {
      // added/removed が連続する区間を1ブロックにまとめる。共通行で区切られたら次のブロック
      if (!hunk) {
        hunk = document.createElement('div')
        hunk.className = 'node-compare-diff-hunk'
        hunks.push({ el: hunk, addedLines: 0, removedLines: 0 })
        fragment.appendChild(hunk)
      }
      const entry = hunks[hunks.length - 1]
      if (part.added) entry.addedLines += 1
      if (part.removed) entry.removedLines += 1
    } else {
      hunk = null
    }
    // diffLines の各 block は末尾に改行を含む。最後の改行だけ落としてから行に分割する
    const lines = part.value.replace(/\n$/, '').split('\n')
    for (const line of lines) {
      const row = document.createElement('div')
      row.className = `node-compare-diff-line${state}`
      // pre-wrap では空文字列の行が高さ0になるため、空白を入れて行を保つ
      row.textContent = line.length ? line : ' '
      if (hunk) hunk.appendChild(row)
      else fragment.appendChild(row)
    }
  }
  container.appendChild(fragment)
  if (stripEl && hunks.length) buildNodeCompareStrip(stripEl, container, hunks)
}

// 差分ナビ帯を作る。目盛クリックで該当 hunk へ jump、ホバー/フォーカスで本文側を強調する。
// 目盛位置は行番号でなく DOM 実測（offsetTop / scrollHeight）から出す。pre-wrap の折返しで
// 行番号換算はズレるため
function buildNodeCompareStrip(stripEl, diffEl, hunks) {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  const ticks = []
  hunks.forEach((hunk, index) => {
    const tick = document.createElement('button')
    tick.type = 'button'
    tick.className = 'node-compare-tick'
    tick.setAttribute('aria-label', t('editor.compareTickAriaLabel', { n: index + 1 }))
    if (hunk.addedLines && hunk.removedLines) {
      // 追加と削除の混在ブロックは行数比で2色に分割する（unified 表示の並びに合わせ削除が上）
      const removedRatio = hunk.removedLines / (hunk.addedLines + hunk.removedLines) * 100
      tick.style.background = `linear-gradient(to bottom, #e7868c 0 ${removedRatio}%, #80bf92 ${removedRatio}% 100%)`
    } else {
      tick.classList.add(hunk.addedLines ? 'added' : 'removed')
    }
    tick.addEventListener('click', () => {
      const maxScroll = diffEl.scrollHeight - diffEl.clientHeight
      const top = Math.max(0, Math.min(hunk.el.offsetTop - 12, maxScroll))
      diffEl.scrollTo({ top, behavior: reducedMotion.matches ? 'auto' : 'smooth' })
      // アニメーションは付与のたびに1回だけ流す。連打されたら再付与でやり直す
      hunk.el.classList.remove('is-flash')
      void hunk.el.offsetWidth
      hunk.el.classList.add('is-flash')
    })
    const setHunkEmphasis = on => hunk.el.classList.toggle('is-hover', on)
    tick.addEventListener('mouseenter', () => setHunkEmphasis(true))
    tick.addEventListener('mouseleave', () => setHunkEmphasis(false))
    tick.addEventListener('focus', () => setHunkEmphasis(true))
    tick.addEventListener('blur', () => setHunkEmphasis(false))
    ticks.push({ tick, el: hunk.el })
    stripEl.appendChild(tick)
  })
  const positionTicks = () => {
    const total = diffEl.scrollHeight
    const stripHeight = stripEl.clientHeight
    if (!total || !stripHeight) return
    for (const { tick, el } of ticks) {
      // px 指定にして帯の下端からのはみ出しを防ぐ（min-height 4px の分も top を抑える）
      const top = el.offsetTop / total * stripHeight
      const height = el.offsetHeight / total * stripHeight
      tick.style.top = `${Math.min(top, Math.max(stripHeight - 4, 0))}px`
      tick.style.height = `${height}px`
    }
  }
  positionTicks()
  // 目盛位置は本文の折返しに依存する。パネル幅は vw/vh 由来なので window resize で再計算する。
  // 帯は再 render のたびに作り直すので、前回のリスナーを外してから登録し直す（window 側に溜めない）
  if (stripEl.compareResizeHandler) window.removeEventListener('resize', stripEl.compareResizeHandler)
  let resizeTimer = null
  stripEl.compareResizeHandler = () => {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(positionTicks, 150)
  }
  window.addEventListener('resize', stripEl.compareResizeHandler)
}

async function openNodeCompareOverlay() {
  const overlay = document.getElementById('node-compare-overlay')
  const diffEl = document.getElementById('node-compare-diff')
  const stripEl = document.getElementById('node-compare-diff-strip')
  const statusEl = document.getElementById('node-compare-status')
  if (!overlay || !diffEl || !statusEl) return
  if (nodeDetailNodeId == null || nodeDetailSelectedVersion == null || nodeDetailCompareVersion == null) return
  if (nodeDetailCompareInFlight) return

  // 表示は常に古い版→新しい版。行選択/ラジオのどちらが新でも向きは変わらない
  const requestOld = Math.min(nodeDetailCompareVersion, nodeDetailSelectedVersion)
  const requestNew = Math.max(nodeDetailCompareVersion, nodeDetailSelectedVersion)
  const oldItem = nodeDetailHistoryItems.find(item => item.node_version === requestOld)
  const newItem = nodeDetailHistoryItems.find(item => item.node_version === requestNew)
  if (!oldItem || !newItem) return

  const requestId = nodeDetailLoadRequestId
  const nodeId = nodeDetailNodeId
  const isStale = () =>
    requestId !== nodeDetailLoadRequestId ||
    nodeDetailNodeId !== nodeId ||
    nodeDetailSelectedVersion == null ||
    nodeDetailCompareVersion == null ||
    Math.min(nodeDetailCompareVersion, nodeDetailSelectedVersion) !== requestOld ||
    Math.max(nodeDetailCompareVersion, nodeDetailSelectedVersion) !== requestNew

  nodeDetailCompareInFlight = true
  syncNodeDetailCompareControls()
  document.getElementById('node-compare-old-label').textContent = formatHistoryVersionLabel(oldItem)
  document.getElementById('node-compare-new-label').textContent = formatHistoryVersionLabel(newItem)
  statusEl.textContent = t('editor.compareLoading')
  statusEl.classList.remove('hidden')
  diffEl.replaceChildren()
  stripEl?.replaceChildren()
  overlay.classList.remove('hidden')
  overlay.classList.add('flex')

  // content は preview 選択と同じ cache を共有。現在行は load 時に cache 済み
  const fetchVersionContent = async version => {
    if (nodeDetailPreviewCache.has(version)) return nodeDetailPreviewCache.get(version)
    const response = await axios.get(`/api/trees/${currentTreeId}/nodes/${nodeId}/history/${version}`)
    const content = response.data.data?.content || ''
    nodeDetailPreviewCache.set(version, content)
    return content
  }

  try {
    const [oldContent, newContent] = await Promise.all([
      fetchVersionContent(requestOld),
      fetchVersionContent(requestNew),
    ])
    if (isStale()) return
    renderNodeCompareDiff(diffEl, stripEl, oldContent, newContent)
    statusEl.classList.add('hidden')
  } catch (error) {
    if (isStale()) return
    statusEl.textContent = error.response?.data?.error || t('editor.compareLoadFailed')
  } finally {
    if (requestId === nodeDetailLoadRequestId && nodeDetailNodeId === nodeId) {
      nodeDetailCompareInFlight = false
      syncNodeDetailCompareControls()
    }
  }
}

async function openNodeDetailDialog(node, authorName) {
  const dialog = document.getElementById('node-detail-dialog')
  const restoreBtn = document.getElementById('node-detail-restore-btn')
  if (!dialog || !restoreBtn) return
  nodeDetailNodeId = node.id
  document.getElementById('node-detail-author').textContent = authorName
  document.getElementById('node-detail-created-at').textContent = formatDate(node.created_at)
  document.getElementById('node-detail-updated-at').textContent = formatDate(node.updated_at)
  // 更新者 = 最終更新した人。MCP経由ならクライアント名を併記。不明な場合は (none)
  const updatedBy = node.updated_by_display_name || node.updated_by_email
  document.getElementById('node-detail-updated-by').textContent = updatedBy
    ? nodeHistoryActorLabel({ display_name: node.updated_by_display_name, email: node.updated_by_email, client_name: node.updated_by_client_name })
    : '(none)'
  restoreBtn.classList.toggle('hidden', !canEdit())
  restoreBtn.disabled = true
  restoreBtn.onclick = async () => {
    if (!canEdit() || nodeDetailRestoreInFlight || nodeDetailSelectedVersion == null || nodeDetailCurrentVersion == null || nodeDetailSelectedIsCurrent) return
    const proceed = await runWithUnsavedGuard(async () => {})
    if (!proceed || !confirm(t('editor.restoreContentConfirm'))) return
    nodeDetailRestoreInFlight = true
    restoreBtn.disabled = true
    try {
      await axios.post(
        `/api/trees/${currentTreeId}/nodes/${node.id}/history/${nodeDetailSelectedVersion}/restore`,
        { if_version: nodeDetailCurrentVersion }
      )
      closeNodeDetailDialog()
      await fetchNodes()
      await selectNode(node.id)
      showToast(t('editor.restoreContentSuccess'), 'success')
    } catch (error) {
      if (error.response?.status === 409) {
        showToast(t('editor.restoreVersionConflict'), 'error')
        await fetchNodes()
        await selectNode(node.id)
        await loadNodeDetailHistory(node.id)
      } else {
        showToast(error.response?.data?.error || t('editor.restoreContentFailed'), 'error')
      }
    } finally {
      nodeDetailRestoreInFlight = false
      // 409 再読込後は現在行が選択されている。そのまま有効化し直さない
      if (!dialog.classList.contains('hidden') && nodeDetailSelectedVersion != null && !nodeDetailSelectedIsCurrent) restoreBtn.disabled = false
    }
  }
  dialog.classList.remove('hidden')
  dialog.classList.add('flex')
  await loadNodeDetailHistory(node.id)
}

/**
 * Logout
 */
async function logout() {
  try {
    await axios.post('/auth/logout')
    window.location.href = '/login.html'
  } catch (error) {
    console.error('Logout failed:', error)
    window.location.href = '/login.html'
  }
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
  return (text === null || text === undefined ? '' : String(text))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Toggle parents accordion
 */
function closeParentsAccordion(nodeId) {
  if (!nodeId) return
  const content = document.getElementById(`parents-accordion-content-${nodeId}`)
  const icon = document.getElementById(`parents-accordion-icon-${nodeId}`)
  const overlay = document.getElementById('parents-accordion-overlay')
  if (content) {
    content.style.display = 'none'
  }
  if (icon) {
    icon.style.transform = 'rotate(0deg)'
  }
  if (overlay) {
    overlay.remove()
  }
}

function openParentsAccordion(nodeId) {
  const content = document.getElementById(`parents-accordion-content-${nodeId}`)
  const icon = document.getElementById(`parents-accordion-icon-${nodeId}`)
  if (!content || !icon) return

  const existingOverlay = document.getElementById('parents-accordion-overlay')
  if (!existingOverlay) {
    const overlay = document.createElement('div')
    overlay.id = 'parents-accordion-overlay'
    overlay.style.cssText = `
      position: fixed;
      inset: 0;
      background: rgba(15, 23, 42, 0.08);
      z-index: 35;
    `
    overlay.addEventListener('click', () => {
      closeParentsAccordion(nodeId)
    })
    document.body.appendChild(overlay)
  }

  content.style.display = 'block'
  adjustParentsAccordionViewport(content)
  icon.style.transform = 'rotate(180deg)'
}

function toggleParentsAccordion(nodeId) {
  if (!nodeId) return
  const content = document.getElementById(`parents-accordion-content-${nodeId}`)
  if (content) {
    if (content.style.display === 'none' || content.style.display === '') {
      openParentsAccordion(nodeId)
    } else {
      closeParentsAccordion(nodeId)
    }
  }
}

function adjustParentsAccordionViewport(contentEl) {
  if (!contentEl) return

  const viewportPadding = 12
  const rect = contentEl.getBoundingClientRect()
  const availableHeight = Math.floor(window.innerHeight - rect.top - viewportPadding)
  const maxHeight = Math.max(120, availableHeight)
  contentEl.style.maxHeight = `${maxHeight}px`
  contentEl.style.overflowY = 'auto'
}

// ===============================
// API呼び出し
// ===============================

/**
 * Reload tree data (nodes and relations)
 */
async function reloadTreeData() {
  const okToProceed = await runWithUnsavedGuard(async () => {})
  if (!okToProceed) return false

  showLoading()
  try {
    await Promise.all([
      fetchNodes(),
      fetchTreeMembers()
    ])
    // 選択中のノードがあれば、最新データで再読み込み
    if (selectedNodeId) {
      await selectNode(selectedNodeId, selectedNodePath)
    }
    return true
  } catch (error) {
    console.error('Failed to reload tree:', error)
    showToast(t('editor.reloadFailed'), 'error')
    return false
  } finally {
    hideLoading()
  }
}

async function fetchTreeMembers() {
  if (!currentTreeId) return

  try {
    const membersRes = await axios.get(`/api/trees/${currentTreeId}/members`)
    if (membersRes.data.success) {
      treeMembers = membersRes.data.data.filter(m => m.role === 'owner' || m.role === 'editor')
    }
  } catch (error) {
    console.error('Failed to fetch tree members:', error)
  }
}

async function fetchRelationTypes() {
  try {
    const response = await axios.get('/api/relation-types')
    if (response.data.success && Array.isArray(response.data.data)) {
      relationTypes = response.data.data
      relationTypesLoadFailed = false
      return true
    }
  } catch (error) {
    console.error('Failed to fetch relation types:', error)
  }

  relationTypesLoadFailed = true
  if (!relationTypesErrorShown) {
    showToast(t('editor.relationTypesFetchFailed'), 'error')
    relationTypesErrorShown = true
  }
  return false
}

async function fetchNodes() {
  if (!currentTreeId) {
    console.error('No tree ID set')
    return
  }

  try {
    const [nodesRes, relationsRes] = await Promise.all([
      axios.get(`/api/trees/${currentTreeId}/nodes-lite`),
      axios.get(`/api/trees/${currentTreeId}/relations`)
    ])

    if (nodesRes.data.success && relationsRes.data.success) {
      nodes = nodesRes.data.data
      setRelations(relationsRes.data.data)
      if (nodesRes.data.root_node_id) {
        currentRootNodeId = nodesRes.data.root_node_id
      }
      currentTrashRootNodeId = nodesRes.data.trash_root_node_id || null
      renderTree()
    }

  } catch (error) {
    console.error('Failed to fetch nodes:', error)
    if (error.response?.status === 403) {
      showToast(t('editor.treeAccessDenied'), 'error')
      // 権限を失ったツリーは /api/trees から消えるので、着地処理で別のツリーへ移る
      setTimeout(() => {
        window.location.href = '/index.html'
      }, 2000)
    } else {
      showToast(t('editor.nodesFetchFailed'), 'error')
    }
  }
}

async function addRelation(parentId, childId, options = {}) {
  if (!canEdit()) {
    showToast(t('editor.editPermissionRequired'), 'error')
    return false
  }

  const { reload = true, relation_type_id = 3 } = options

  showLoading()
  try {
    const response = await axios.post(`/api/trees/${currentTreeId}/relations`, {
      parent_node_id: parentId,
      child_node_id: childId,
      relation_type_id
    })

    if (response.data.success) {
      if (reload) {
        await fetchNodes()
      }
      return true
    }
  } catch (error) {
    console.error('Failed to add relation:', error)
    console.error('Error details:', error.response?.data)
    if (error.response?.data?.error === 'Circular reference detected') {
      showToast(t('editor.circularReferenceOperationDenied'), 'error')
    } else if (error.response?.data?.error === 'Relation already exists') {
      showToast(t('editor.relationAlreadyExists'), 'error')
    } else if (error.response?.data?.error) {
      showToast(t('editor.addRelationFailedWithReason', { reason: error.response.data.error }), 'error')
    } else {
      showToast(t('editor.addRelationFailed'), 'error')
    }
    return false
  } finally {
    hideLoading()
  }
}

async function moveRelation(childId, oldParentId, newParentId, newSiblingOrder = null, options = {}) {
  if (!canEdit()) {
    showToast(t('editor.editPermissionRequired'), 'error')
    return false
  }

  const { reload = true } = options

  showLoading()
  try {
    const response = await axios.post(`/api/trees/${currentTreeId}/relations/move`, {
      child_node_id: childId,
      old_parent_id: oldParentId,
      new_parent_id: newParentId,
      new_sibling_order: newSiblingOrder
    })

    if (response.data.success) {
      if (response.data.data?.nodes && response.data.data?.relations) {
        nodes = response.data.data.nodes
        setRelations(response.data.data.relations)
        renderTree()
      } else if (reload) {
        await fetchNodes()
      }
      return true
    }
  } catch (error) {
    console.error('Failed to move relation:', error)
    if (error.response?.data?.error === 'Circular reference detected') {
      showToast(t('editor.circularReferenceOperationDenied'), 'error')
    } else if (error.response?.data?.error) {
      showToast(t('editor.moveParentFailedWithReason', { reason: error.response.data.error }), 'error')
    } else {
      showToast(t('editor.moveParentFailed'), 'error')
    }
    return false
  } finally {
    hideLoading()
  }
}

async function removeRelation(parentId, childId) {
  if (!canEdit()) {
    showToast(t('editor.editPermissionRequired'), 'error')
    return false
  }

  showLoading()
  try {
    const response = await axios.delete(`/api/trees/${currentTreeId}/relations/${parentId}/${childId}`)
    if (response.data.success) {
      await fetchNodes()
      return true
    }
  } catch (error) {
    console.error('Failed to remove relation:', error)
    if (error.response?.data?.error?.startsWith('Cannot remove the last parent from a node')) {
      showToast(t('editor.lastParentRemovalDenied'), 'error')
    } else if (error.response?.data?.error) {
      showToast(t('editor.removeRelationFailedWithReason', { reason: error.response.data.error }), 'error')
    } else {
      showToast(t('editor.removeRelationFailed'), 'error')
    }
    return false
  } finally {
    hideLoading()
  }
}

async function updateRelationType(parentId, childId, relationTypeId) {
  if (!canEdit()) {
    showToast(t('editor.editPermissionRequired'), 'error')
    return false
  }

  try {
    const response = await axios.patch(`/api/trees/${currentTreeId}/relations/${parentId}/${childId}/type`, {
      relation_type_id: relationTypeId
    })
    const demotedCount = response.data.data?.demoted_parent_ids?.length || 0
    if (response.data.success && demotedCount > 0) {
      showToast(t('editor.relationTypeOthersDemoted', { count: demotedCount }), 'info')
    }
    return !!response.data.success
  } catch (error) {
    console.error('Failed to update relation type:', error)
    if (error.response?.data?.error?.startsWith('Cannot change the last STRUCTURAL parent')) {
      showToast(t('editor.lastStructuralParentChangeDenied'), 'error')
    } else if (error.response?.data?.error) {
      showToast(t('editor.relationTypeUpdateFailedWithReason', { reason: error.response.data.error }), 'error')
    } else {
      showToast(t('editor.relationTypeUpdateFailed'), 'error')
    }
    return false
  }
}

async function fetchNodeById(id) {
  try {
    const response = await axios.get(`/api/trees/${currentTreeId}/nodes/${id}`)
    if (response.data.success) {
      return response.data.data
    }
  } catch (error) {
    console.error('Failed to fetch node:', error)
    return null
  }
}

async function fetchNodeImages(nodeId) {
  try {
    const response = await axios.get(`/api/trees/${currentTreeId}/nodes/${nodeId}/images`)
    if (response.data.success) {
      return Array.isArray(response.data.data) ? response.data.data : []
    }
  } catch (error) {
    console.error('Failed to fetch node images:', error)
  }
  return []
}

async function uploadNodeImage(nodeId, file) {
  if (!canEdit()) {
    showToast(t('editor.editPermissionRequired'), 'error')
    return null
  }
  const formData = new FormData()
  formData.append('file', file)
  try {
    const response = await axios.post(`/api/trees/${currentTreeId}/nodes/${nodeId}/images`, formData)
    if (response.data.success) {
      return response.data.data
    }
  } catch (error) {
    console.error('Failed to upload node image:', error)
    const message = error.response?.data?.error || t('editor.imageUploadFailed')
    showToast(message, 'error')
  }
  return null
}

// 現在のエディタ内容を渡すと、サーバーが対象のタグを除いた文字列を editor_content で返す（DB には保存しない）。
// 成功時は応答の data、失敗時は null を返す
async function deleteNodeImage(nodeId, imageId, editorContent = null) {
  if (!canEdit()) {
    showToast(t('editor.editPermissionRequired'), 'error')
    return null
  }
  try {
    const requestConfig = typeof editorContent === 'string' ? { data: { content: editorContent } } : undefined
    const response = await axios.delete(`/api/trees/${currentTreeId}/nodes/${nodeId}/images/${imageId}`, requestConfig)
    if (response.data.success) return response.data.data || {}
  } catch (error) {
    console.error('Failed to delete node image:', error)
    const message = error.response?.data?.error || t('editor.imageDeleteFailed')
    showToast(message, 'error')
  }
  return null
}

async function createNode(nodeData, options = {}) {
  if (!canEdit()) {
    showToast(t('editor.editPermissionRequired'), 'error')
    return null
  }

  const { reload = true } = options

  try {
    const response = await axios.post(`/api/trees/${currentTreeId}/nodes`, nodeData)
    if (response.data.success) {
      if (reload) {
        await fetchNodes()
      }
      return response.data.data
    }
  } catch (error) {
    console.error('Failed to create node:', error)
    showToast(error.response?.data?.error === 'Node quota exceeded' ? t('editor.nodeQuotaExceeded') : t('editor.nodeCreateFailed'), 'error')
    return null
  }
}

async function createNodeWithParent(parentId, nodeData, options = {}) {
  if (!canEdit()) {
    showToast(t('editor.editPermissionRequired'), 'error')
    return null
  }

  const { reload = true } = options

  try {
    const response = await axios.post(`/api/trees/${currentTreeId}/nodes/with-parent`, {
      ...nodeData,
      parent_node_id: parentId
    })
    if (response.data.success) {
      if (reload) {
        await fetchNodes()
      }
      return response.data.data?.node || null
    }
  } catch (error) {
    console.error('Failed to create node with parent:', error)
    showToast(error.response?.data?.error === 'Node quota exceeded' ? t('editor.nodeQuotaExceeded') : t('editor.nodeCreateFailed'), 'error')
    return null
  }
}

async function updateNode(id, nodeData) {
  if (!canEdit()) {
    showToast(t('editor.editPermissionRequired'), 'error')
    return null
  }

  try {
    const response = await axios.put(`/api/trees/${currentTreeId}/nodes/${id}`, nodeData)
    if (response.data.success) {
      await fetchNodes()
      return response.data.data
    }
  } catch (error) {
    console.error('Failed to update node:', error)

    // Handle version conflict (409)
    if (error.response && error.response.status === 409) {
      const conflictData = error.response.data
      await handleVersionConflict(id, nodeData, conflictData)
      return null
    }

    showToast(t('editor.nodeUpdateFailed'), 'error')
    return null
  }
}

async function deleteNode(id) {
  if (!canEdit()) {
    showToast(t('editor.editPermissionRequired'), 'error')
    return false
  }
  if (treeViewMode === 'trash') {
    showToast(t('editor.operationUnavailableInTrash'), 'error')
    return false
  }

  if (id === currentRootNodeId) {
    showToast(t('editor.rootNodeDeleteDenied'), 'error')
    return false
  }
  if (id === currentTrashRootNodeId) {
    showToast(t('editor.trashRootDeleteDenied'), 'error')
    return false
  }

  const visibleParentMeta = getVisibleParentMetaForNode(id, selectedNodePath)
  if (visibleParentMeta && visibleParentMeta.parentCount > 1) {
    const action = await showDeleteNodeChoiceDialog(visibleParentMeta.parentTitle)
    if (!action) return false

    if (action === 'unlink-parent') {
      const wasSelected = selectedNodeId === id
      if (wasSelected) {
        // removeRelation内のfetchNodes→restoreSelectionが別親にジャンプするのを防ぐため事前クリア
        selectedNodeId = null
        selectedNodePath = null
        selectedNodeElement = null
      }
      const success = await removeRelation(visibleParentMeta.parentId, id)
      if (success && wasSelected) {
        currentEditorNodeId = null
        document.querySelectorAll('.tree-item.active, .tree-item.duplicate-active').forEach(el => {
          el.classList.remove('active', 'duplicate-active')
        })
        renderEditor()
      }
      return success
    }
  }

  if (!confirm(t('editor.moveToTrashConfirm'))) {
    return false
  }

  try {
    const response = await axios.delete(`/api/trees/${currentTreeId}/nodes/${id}`)
    if (response.data.success) {
      if (selectedNodeId === id) {
        selectedNodeId = null
        renderEditor()
      }
      await fetchNodes()
      return true
    }
  } catch (error) {
    console.error('Failed to delete node:', error)
    showToast(t('editor.moveToTrashFailed'), 'error')
    return false
  }
}

async function restoreNodeFromTrash(id) {
  if (!canEdit()) {
    showToast(t('editor.editPermissionRequired'), 'error')
    return false
  }
  if (!confirm(t('editor.restoreNodeConfirm'))) {
    return false
  }
  try {
    const response = await axios.post(`/api/trees/${currentTreeId}/nodes/${id}/restore`)
    if (response.data.success) {
      await fetchNodes()
      selectedNodeId = null
      selectedNodePath = null
      renderEditor()
      return true
    }
  } catch (error) {
    console.error('Failed to restore node:', error)
    showToast(error.response?.data?.error || t('editor.restoreNodeFailed'), 'error')
  }
  return false
}

async function permanentlyDeleteNode(id) {
  if (!canEdit()) {
    showToast(t('editor.editPermissionRequired'), 'error')
    return false
  }
  if (!confirm(t('editor.permanentDeleteConfirm'))) {
    return false
  }
  try {
    const response = await axios.delete(`/api/trees/${currentTreeId}/nodes/${id}/permanent`)
    if (response.data.success) {
      const deletedCount = Number(response.data.deleted_count || 0)
      const skippedCount = Number(response.data.skipped_count || 0)
      showToast(t('editor.permanentDeleteSuccess', { deletedCount, skippedCount }), 'success')
      await fetchNodes()
      selectedNodeId = null
      selectedNodePath = null
      renderEditor()
      return true
    }
  } catch (error) {
    console.error('Failed to permanently delete node:', error)
    showToast(error.response?.data?.error || t('editor.permanentDeleteFailed'), 'error')
  }
  return false
}

// Handle version conflict
async function handleVersionConflict(nodeId, yourData, conflictData) {
  // saveCurrentNode() で表示したローディングが残ると競合ダイアログを操作できなくなるため、
  // 競合ハンドリング開始時点で必ず解除する。
  hideLoading()

  const dialog = document.getElementById('conflict-dialog')
  const serverData = conflictData.server_data

  // Fill in your changes
  document.getElementById('conflict-your-title').textContent = yourData.title
  document.getElementById('conflict-your-content').textContent = yourData.content || ''

  // Fill in server version
  document.getElementById('conflict-server-title').textContent = serverData.title
  document.getElementById('conflict-server-content').textContent = serverData.content || ''
  document.getElementById('conflict-server-author').textContent = serverData.author_display_name || serverData.author_email || 'Unknown'
  document.getElementById('conflict-server-version').textContent = conflictData.current_version

  // Show dialog
  dialog.classList.remove('hidden')
  dialog.classList.add('flex')

  // Wait for user choice
  return new Promise((resolve) => {
    const cleanup = () => {
      dialog.classList.remove('flex')
      dialog.classList.add('hidden')
      useServerBtn.removeEventListener('click', handleUseServer)
      useMineBtn.removeEventListener('click', handleUseMine)
      cancelBtn.removeEventListener('click', handleCancel)
      closeBtn.removeEventListener('click', handleCancel)
    }

    const handleUseServer = async () => {
      cleanup()
      hideLoading()
      // Reload the node to get server version
      await selectNode(nodeId)
      showToast(t('editor.latestServerVersionLoaded'), 'info')
      resolve('server')
    }

    const handleUseMine = async () => {
      cleanup()
      // Force update with server version number
      showLoading()
      try {
        const response = await axios.put(`/api/trees/${currentTreeId}/nodes/${nodeId}`, {
          ...yourData,
          version: conflictData.current_version
        })
        if (response.data.success) {
          await fetchNodes()
          await selectNode(nodeId)
          showToast(t('editor.yourChangesSaved'), 'success')
          resolve('mine')
        }
      } catch (error) {
        console.error('Failed to force update:', error)
        showToast(t('editor.saveFailed'), 'error')
        resolve('error')
      } finally {
        hideLoading()
      }
    }

    const handleCancel = () => {
      cleanup()
      hideLoading()
      showToast(t('editor.saveCancelled'), 'info')
      resolve('cancel')
    }

    const useServerBtn = document.getElementById('conflict-use-server')
    const useMineBtn = document.getElementById('conflict-use-mine')
    const cancelBtn = document.getElementById('conflict-cancel')
    const closeBtn = document.getElementById('conflict-dialog-close')

    useServerBtn.addEventListener('click', handleUseServer)
    useMineBtn.addEventListener('click', handleUseMine)
    cancelBtn.addEventListener('click', handleCancel)
    closeBtn.addEventListener('click', handleCancel)
  })
}

async function moveNode(nodeId, newParentId, newPosition) {
  try {
    const response = await axios.patch(`/api/nodes/${nodeId}/parent`, {
      parent_id: newParentId,
      position: newPosition
    })
    if (response.data.success) {
      await fetchNodes()
      return true
    }
  } catch (error) {
    console.error('Failed to move node:', error)
    if (error.response?.data?.error === 'Circular reference detected') {
      showToast(t('editor.circularReferenceNotAllowed'), 'error')
    } else {
      showToast(t('editor.nodeMoveFailed'), 'error')
    }
    return false
  }
}

function normalizeParentNodeId(parentNodeId) {
  if (parentNodeId === null || parentNodeId === undefined || parentNodeId === '') return currentRootNodeId
  return parentNodeId
}

function updateSiblingOrderInRelations(parentNodeId, orderedChildIds) {
  const effectiveParentId = normalizeParentNodeId(parentNodeId)
  if (!effectiveParentId || !Array.isArray(orderedChildIds) || orderedChildIds.length === 0) {
    return false
  }

  const positionMap = new Map()
  orderedChildIds.forEach((childId, index) => {
    if (childId) {
      positionMap.set(childId, index)
    }
  })

  let changed = false
  relations = relations.map(rel => {
    if (rel.parent_node_id !== effectiveParentId || !positionMap.has(rel.child_node_id)) {
      return rel
    }
    changed = true
    return { ...rel, position: positionMap.get(rel.child_node_id) }
  })
  if (changed) rebuildRelationIndexes()

  return changed
}

function applySiblingOrderToContainer(parentContainer, orderedChildIds) {
  if (!parentContainer || !Array.isArray(orderedChildIds) || orderedChildIds.length === 0) return

  const wrappers = Array.from(parentContainer.querySelectorAll(':scope > [data-node-group]'))
  const wrapperById = new Map()
  wrappers.forEach(wrapper => {
    const item = wrapper.querySelector(':scope > .tree-item')
    const nodeId = item?.dataset?.nodeId
    if (nodeId) {
      wrapperById.set(nodeId, wrapper)
    }
  })

  const fragment = document.createDocumentFragment()
  orderedChildIds.forEach((childId) => {
    const wrapper = wrapperById.get(childId)
    if (wrapper) fragment.appendChild(wrapper)
  })
  parentContainer.appendChild(fragment)
}

function restoreSelectionAfterLocalReorder() {
  if (!selectedNodeId) return
  document.querySelectorAll('.tree-item.active').forEach(item => item.classList.remove('active'))
  document.querySelectorAll('.tree-item.duplicate-active').forEach(item => item.classList.remove('duplicate-active'))
  restoreSelection()
  if (selectedNodeElement) {
    selectedNodeElement.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }
}

async function recoverTreeAfterReorderFailure() {
  try {
    showLoading()
    await fetchNodes()
    renderTree()
  } finally {
    hideLoading()
  }
}

// 同じ階層の全ノードの position を一括更新
async function reorderNodes(container) {
  if (!currentTreeId) {
    console.error('No tree selected')
    return false
  }

  showLoading()
  try {
    const nodeElements = container.querySelectorAll(':scope > [data-node-group]')

    let parentId = currentRootNodeId
    if (container.id !== 'tree-container') {
      parentId = container.dataset.parent
    }

    // DOM順でノードIDを収集
    const orderedIds = Array.from(nodeElements).map(el =>
      el.querySelector('.tree-item').dataset.nodeId
    )

    const response = await axios.put(`/api/trees/${currentTreeId}/relations/batch-reorder`, {
      parent_node_id: parentId,
      ordered_child_ids: orderedIds
    })

    if (response.data.success && response.data.data) {
      const data = response.data.data
      if (Array.isArray(data.nodes) && Array.isArray(data.relations)) {
        nodes = data.nodes
        setRelations(data.relations)
        renderTree()
      } else {
        const updated = updateSiblingOrderInRelations(parentId, orderedIds)
        if (!updated) {
          throw new Error('Local relation update failed after reorder')
        }
      }
    }
    return true
  } catch (error) {
    console.error('Failed to reorder nodes:', error)
    showToast(t('editor.reorderFailed'), 'error')
    return false
  } finally {
    hideLoading()
  }
}

async function moveNodeInSiblings(direction, targetNodeElement) {
  if (!canEdit()) return
  if (isSiblingReorderInFlight) return

  const el = targetNodeElement || selectedNodeElement
  if (!el) return

  const parentNodeId = getParentNodeIdFromElement(el)
  if (!isManualSortForParent(parentNodeId)) {
    showToast(t('editor.manualSortMoveOnly'), 'error')
    return
  }

  const wrapper = el.closest('[data-node-group]')
  if (!wrapper) return
  const parentContainer = wrapper.parentElement
  const siblings = Array.from(parentContainer.querySelectorAll(':scope > [data-node-group]'))
  const currentIndex = siblings.indexOf(wrapper)
  const newIndex = currentIndex + direction

  if (newIndex < 0 || newIndex >= siblings.length) return

  const orderedIds = siblings.map(s => s.querySelector('.tree-item').dataset.nodeId)
  ;[orderedIds[currentIndex], orderedIds[newIndex]] = [orderedIds[newIndex], orderedIds[currentIndex]]

  let parentId = null
  if (parentContainer.id !== 'tree-container') {
    parentId = parentContainer.dataset.parent
  }

  isSiblingReorderInFlight = true
  try {
    const response = await axios.put(`/api/trees/${currentTreeId}/relations/batch-reorder`, {
      parent_node_id: parentId,
      ordered_child_ids: orderedIds
    })

    if (response.data.success && response.data.data) {
      const data = response.data.data
      if (Array.isArray(data.nodes) && Array.isArray(data.relations)) {
        nodes = data.nodes
        setRelations(data.relations)
        renderTree()
      } else {
        const updated = updateSiblingOrderInRelations(parentId, orderedIds)
        if (!updated) {
          throw new Error('Local relation update failed after sibling move')
        }
        applySiblingOrderToContainer(parentContainer, orderedIds)
        restoreSelectionAfterLocalReorder()
      }
    }
  } catch (error) {
    console.error('Failed to move node:', error)
    showToast(t('editor.nodeMoveFailed'), 'error')
    await recoverTreeAfterReorderFailure()
  } finally {
    isSiblingReorderInFlight = false
  }
}

async function searchNodes(query, options = {}) {
  const { parentNodeId = null, matchMode = 'and', onlyTitle = false } = options
  try {
    const params = new URLSearchParams()
    params.set('q', query)
    params.set('match_mode', matchMode === 'or' ? 'or' : 'and')
    if (onlyTitle) {
      params.set('title_only', 'true')
    }
    if (parentNodeId) {
      params.set('parent_node_id', String(parentNodeId))
    }
    const response = await axios.get(`/api/search?${params.toString()}`)
    if (response.data.success) {
      return response.data.data
    }
  } catch (error) {
    console.error('Failed to search nodes:', error)
    return []
  }
}

function normalizeSearchKeyword(input) {
  return String(input || '')
    .replace(/　/g, ' ')
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
}

function extractSearchHighlightTerms(rawQuery) {
  const normalized = normalizeSearchKeyword(rawQuery)
    .replace(/(?:^|\s)id\s*:\s*[a-zA-Z0-9]+(?=\s|$)/ig, ' ')
    .trim()
  if (!normalized) return []
  const unique = new Set()
  normalized
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .forEach((t) => unique.add(t))
  return Array.from(unique)
}

function clearSearchHighlight() {
  if (Array.isArray(activeSearchMarks)) {
    activeSearchMarks.forEach((mark) => {
      if (mark && typeof mark.clear === 'function') {
        mark.clear()
      }
    })
  }
  activeSearchMarks = []
  if (Array.isArray(activeSearchPreviewMarks)) {
    activeSearchPreviewMarks.forEach((markEl) => {
      if (!markEl || !markEl.parentNode) return
      const textNode = document.createTextNode(markEl.textContent || '')
      markEl.parentNode.replaceChild(textNode, markEl)
    })
  }
  activeSearchPreviewMarks = []
  currentSearchHitIndex = 0
  if (typeof updateActiveSearchHitCount === 'function') {
    updateActiveSearchHitCount()
  }
}

function findFirstSearchHitInContent(content, terms) {
  const source = String(content || '')
  const sourceLower = source.toLowerCase()
  let best = null
  terms.forEach((term) => {
    const needle = String(term || '').toLowerCase()
    if (!needle) return
    const index = sourceLower.indexOf(needle)
    if (index < 0) return
    if (!best || index < best.start) {
      best = { start: index, end: index + needle.length }
    }
  })
  return best
}

function findAllSearchHitsInContent(content, terms, maxHits = 50) {
  const source = String(content || '')
  const sourceLower = source.toLowerCase()
  const hits = []

  terms.forEach((term) => {
    const needle = String(term || '').toLowerCase()
    if (!needle) return
    let startIndex = 0
    while (startIndex < sourceLower.length) {
      const index = sourceLower.indexOf(needle, startIndex)
      if (index < 0) break
      hits.push({ start: index, end: index + needle.length })
      if (hits.length >= maxHits) return
      startIndex = index + needle.length
    }
  })

  hits.sort((a, b) => a.start - b.start || a.end - b.end)
  return hits
}

function applySearchHighlightInPreview(terms) {
  if (!Array.isArray(terms) || terms.length === 0) return false
  const previewPane =
    document.querySelector('.bytemd-preview') ||
    document.querySelector('.editor-preview-active') ||
    document.querySelector('.editor-preview-side')
  if (!previewPane) return false

  let firstMarked = null
  let markedCount = 0
  const maxMarks = 80

  const walker = document.createTreeWalker(previewPane, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parentTag = node.parentNode?.nodeName
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT
      if (parentTag === 'SCRIPT' || parentTag === 'STYLE') return NodeFilter.FILTER_REJECT
      if (node.parentNode?.classList?.contains('search-hit-preview-highlight')) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    }
  })

  const textNodes = []
  while (walker.nextNode()) {
    textNodes.push(walker.currentNode)
  }

  for (const textNode of textNodes) {
    if (markedCount >= maxMarks) break
    if (!textNode?.parentNode) continue
    const text = textNode.nodeValue || ''
    const textLower = text.toLowerCase()
    const ranges = []

    terms.forEach((term) => {
      const needle = String(term || '').toLowerCase()
      if (!needle) return
      let startIndex = 0
      while (startIndex < textLower.length) {
        const idx = textLower.indexOf(needle, startIndex)
        if (idx < 0) break
        ranges.push({ start: idx, end: idx + needle.length })
        startIndex = idx + needle.length
      }
    })

    if (ranges.length === 0) continue

    ranges.sort((a, b) => a.start - b.start || a.end - b.end)
    const merged = []
    ranges.forEach((r) => {
      const last = merged[merged.length - 1]
      if (!last || r.start > last.end) {
        merged.push({ ...r })
      } else if (r.end > last.end) {
        last.end = r.end
      }
    })

    const fragment = document.createDocumentFragment()
    let cursor = 0
    merged.forEach((r) => {
      if (markedCount >= maxMarks) return
      if (r.start > cursor) {
        fragment.appendChild(document.createTextNode(text.slice(cursor, r.start)))
      }
      const mark = document.createElement('span')
      mark.className = 'search-hit-preview-highlight'
      mark.textContent = text.slice(r.start, r.end)
      fragment.appendChild(mark)
      activeSearchPreviewMarks.push(mark)
      if (!firstMarked) firstMarked = mark
      markedCount += 1
      cursor = r.end
    })

    if (cursor < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(cursor)))
    }

    textNode.parentNode.replaceChild(fragment, textNode)
  }

  if (firstMarked) {
    currentSearchHitIndex = 0
    focusSearchHit(0)
    return true
  }

  return false
}

function applySearchHighlightInEditor(terms) {
  if (!Array.isArray(terms) || terms.length === 0) return false
  if (!window.currentEditor) return false

  // ByteMD ではプレビュー側でのハイライトを試みる
  const content = window.currentEditor.value()
  const hit = findFirstSearchHitInContent(content, terms)
  if (!hit) {
    clearSearchHighlight()
    return false
  }
  clearSearchHighlight()
  return applySearchHighlightInPreview(terms)
}

function applyPendingSearchHighlight(nodeId) {
  if (!pendingSearchHighlight) return
  const pending = { ...pendingSearchHighlight }
  if (!pending || pending.nodeId !== nodeId) return

  const reinforcePreviewHighlight = (terms, repeats = 4, delayMs = 120) => {
    const run = (count) => {
      if (count <= 0) return
      if (selectedNodeId !== nodeId) return
      if (!window.currentEditor) return
      const previewActive =
        !!document.querySelector('.bytemd-preview') ||
        (typeof window.currentEditor.isPreviewActive === 'function' && window.currentEditor.isPreviewActive())
      if (!previewActive) return
      applySearchHighlightInEditor(terms)
      setTimeout(() => run(count - 1), delayMs)
    }
    setTimeout(() => run(repeats), delayMs)
  }

  const tryApply = (retry = 0) => {
    if (!pendingSearchHighlight || pendingSearchHighlight.nodeId !== nodeId) return
    const applied = applySearchHighlightInEditor(pending.terms || [])
    if (applied) {
      pendingSearchHighlight = null
      reinforcePreviewHighlight(pending.terms || [])
      return
    }
    if (retry >= 5) {
      pendingSearchHighlight = null
      return
    }
    setTimeout(() => tryApply(retry + 1), 80)
  }

  tryApply()
}

function extractNodeIdKeyword(rawQuery) {
  const normalized = normalizeSearchKeyword(rawQuery)
  const match = normalized.match(/(?:^|\s)id\s*:\s*([a-zA-Z0-9]+)(?=\s|$)/i)
  if (!match) return null
  const nodeId = match[1]
  return nodeId || null
}

// ===============================
// 検索機能
// ===============================
function getCurrentTreeNodeIdSet() {
  return new Set(nodes.map(n => n.id))
}

async function performSearch(query, options = {}) {
  const { updatePopup = false, scope = searchScope, matchMode = searchMatchMode, onlyTitle = searchOnlyTitle } = options
  const trimmedQuery = String(query || '').trim()
  searchScope = scope === 'selected' ? 'selected' : 'root'
  searchMatchMode = matchMode === 'or' ? 'or' : 'and'
  searchOnlyTitle = onlyTitle === true
  searchQuery = trimmedQuery

  if (!trimmedQuery) {
    searchResults = []
    pendingSearchHighlight = null
    clearSearchHighlight()
    renderTree()
    if (updatePopup) renderSearchPopupResults()
    return
  }

  let parentNodeId = null
  if (searchScope === 'selected') {
    if (selectedNodeId) {
      parentNodeId = selectedNodeId
    } else if (currentRootNodeId) {
      // 選択ノード未指定時はrootスコープにフォールバック
      parentNodeId = currentRootNodeId
    }
  }

  // 「id:xxxxx」はそのノードへ飛ぶ指定。本文検索は混ぜず、ツリー内のそのノード1件（無ければ0件）だけを返す。
  // 本文に「id:xxxxx」を書いたノードを探したいときは「xxxxx」だけで検索する。
  const idKeywordNodeId = extractNodeIdKeyword(trimmedQuery)
  if (idKeywordNodeId) {
    const idNode = nodes.find(n => n.id === idKeywordNodeId)
    searchResults = idNode ? [idNode] : []
  } else {
    const rawResults = await searchNodes(trimmedQuery, { parentNodeId, matchMode: searchMatchMode, onlyTitle: searchOnlyTitle })
    const currentNodeIds = getCurrentTreeNodeIdSet()
    searchResults = rawResults.filter(node => currentNodeIds.has(node.id))
  }

  // Keep current tree expansion state unchanged while searching.
  renderTree()
  if (updatePopup) renderSearchPopupResults()
}

function createSearchPopup() {
  let modal = document.getElementById('search-popup-modal')
  if (modal) return modal

  modal = document.createElement('div')
  modal.id = 'search-popup-modal'
  modal.innerHTML = `
    <div class="search-popup-overlay"></div>
    <div class="search-popup-dialog">
      <div class="search-popup-header">
        <span class="search-popup-title">${t('editor.search')}</span>
        <button type="button" class="search-popup-close" aria-label="close">
          <i class="fas fa-times"></i>
        </button>
      </div>
      <div class="search-popup-input-row">
        <input type="text" class="search-popup-input" placeholder="${t('editor.searchPlaceholder')}">
        <button type="button" class="search-popup-submit" aria-label="search">
          <i class="fas fa-search"></i>
        </button>
      </div>
      <div class="search-popup-scope-row">
        <div class="search-popup-scope-group">
          <label class="search-popup-scope-option">
            <input type="radio" name="search-popup-scope" value="root" checked>
            <span>${t('editor.searchScopeRoot')}</span>
          </label>
          <label class="search-popup-scope-option">
            <input type="radio" name="search-popup-scope" value="selected">
            <span>${t('editor.searchScopeSelected')}</span>
          </label>
          <label class="search-popup-scope-option">
            <input type="checkbox" class="search-popup-title-only-toggle">
            <span>only title</span>
          </label>
        </div>
        <label class="search-popup-match-toggle" title="${t('editor.searchMatchCondition')}">
          <span class="search-popup-match-label">AND</span>
          <span class="search-popup-switch">
            <input type="checkbox" class="search-popup-match-switch">
            <span class="search-popup-switch-slider"></span>
          </span>
          <span class="search-popup-match-label">OR</span>
        </label>
      </div>
      <div class="search-popup-result-meta"></div>
      <div class="search-popup-results"></div>
    </div>
  `
  document.body.appendChild(modal)

  const style = document.createElement('style')
  style.textContent = `
    #search-popup-modal {
      display: none;
      position: fixed;
      inset: 0;
      z-index: 10020;
      pointer-events: none;
    }
    #search-popup-modal.active {
      display: block;
    }
    #search-popup-modal .search-popup-overlay {
      position: absolute;
      inset: 0;
      display: block;
      background: rgba(15, 23, 42, 0.18);
      pointer-events: none;
    }
    #search-popup-modal .search-popup-dialog {
      position: absolute;
      top: 88px;
      left: 24px;
      width: 520px;
      height: 420px;
      min-width: 320px;
      min-height: 220px;
      max-width: calc(100vw - 24px);
      max-height: calc(100vh - 120px);
      display: flex;
      flex-direction: column;
      background: #fff;
      border-radius: 10px;
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.2);
      border: 1px solid #e5e7eb;
      overflow: hidden;
      resize: both;
      pointer-events: auto;
    }
    #search-popup-modal .search-popup-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      border-bottom: 1px solid #e5e7eb;
      background: #f9fafb;
      cursor: move;
    }
    #search-popup-modal .search-popup-title {
      font-size: 14px;
      font-weight: 700;
      color: #374151;
    }
    #search-popup-modal .search-popup-close {
      border: none;
      background: none;
      color: #6b7280;
      cursor: pointer;
      padding: 4px;
      width: 24px;
      height: 24px;
      border-radius: 4px;
    }
    #search-popup-modal .search-popup-close:hover {
      background: #f3f4f6;
      color: #374151;
    }
    #search-popup-modal .search-popup-input-row {
      display: flex;
      gap: 8px;
      padding: 12px 14px;
      border-bottom: 1px solid #e5e7eb;
    }
    #search-popup-modal .search-popup-input {
      flex: 1;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      padding: 8px 10px;
      font-size: 14px;
      outline: none;
    }
    #search-popup-modal .search-popup-input:focus {
      border-color: #3b82f6;
      box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
    }
    #search-popup-modal .search-popup-submit {
      border: none;
      background: #2563eb;
      color: #fff;
      border-radius: 8px;
      padding: 0 12px;
      min-width: 38px;
      cursor: pointer;
    }
    #search-popup-modal .search-popup-submit:hover {
      background: #1d4ed8;
    }
    #search-popup-modal .search-popup-result-meta {
      margin: 0;
      padding: 2px 14px;
      font-size: 12px;
      line-height: 14px;
      color: #9d174d;
      background: #fdf2f8;
      border-bottom: 1px solid #e5e7eb;
    }
    #search-popup-modal .search-popup-scope-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 6px 14px 8px;
      border-bottom: 1px solid #e5e7eb;
      background: #f9fafb;
      font-size: 12px;
      color: #4b5563;
    }
    #search-popup-modal .search-popup-scope-group {
      display: inline-flex;
      align-items: center;
      gap: 14px;
      min-width: 0;
      flex-wrap: wrap;
    }
    #search-popup-modal .search-popup-scope-option {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      user-select: none;
    }
    #search-popup-modal .search-popup-scope-option input {
      margin: 0;
      cursor: pointer;
    }
    #search-popup-modal .search-popup-match-toggle {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      user-select: none;
      color: #374151;
      font-weight: 600;
      white-space: nowrap;
    }
    #search-popup-modal .search-popup-match-label {
      font-size: 11px;
      letter-spacing: 0.02em;
    }
    #search-popup-modal .search-popup-switch {
      position: relative;
      width: 36px;
      height: 20px;
      display: inline-block;
    }
    #search-popup-modal .search-popup-match-switch {
      opacity: 0;
      width: 0;
      height: 0;
      position: absolute;
    }
    #search-popup-modal .search-popup-switch-slider {
      position: absolute;
      inset: 0;
      background: #d1d5db;
      border-radius: 9999px;
      transition: background-color 0.15s ease;
      cursor: pointer;
    }
    #search-popup-modal .search-popup-switch-slider::before {
      content: '';
      position: absolute;
      width: 16px;
      height: 16px;
      left: 2px;
      top: 2px;
      background: #fff;
      border-radius: 9999px;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
      transition: transform 0.15s ease;
    }
    #search-popup-modal .search-popup-match-switch:checked + .search-popup-switch-slider {
      background: #2563eb;
    }
    #search-popup-modal .search-popup-match-switch:checked + .search-popup-switch-slider::before {
      transform: translateX(16px);
    }
    #search-popup-modal .search-popup-results {
      flex: 1;
      overflow: auto;
      padding: 8px 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    #search-popup-modal .search-popup-item {
      border: 1px solid transparent;
      background: #fff;
      color: #1f2937;
      text-align: left;
      font-size: 14px;
      padding: 4px 8px;
      border-radius: 6px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    #search-popup-modal .search-popup-item:hover {
      background: #f5f9ff;
    }
    #search-popup-modal .search-popup-item.active {
      background: #dbeafe;
      box-shadow: inset 0 0 0 1px #60a5fa;
    }
    #search-popup-modal .search-popup-item-title {
      min-width: 0;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #search-popup-modal .search-popup-item-hit-nav {
      display: none;
      align-items: center;
      gap: 4px;
      flex: 0 0 auto;
    }
    #search-popup-modal .search-popup-item.active .search-popup-item-hit-nav {
      display: inline-flex;
    }
    #search-popup-modal .search-popup-item-hit-count {
      font-size: 11px;
      color: #1d4ed8;
      min-width: 32px;
      text-align: center;
      font-variant-numeric: tabular-nums;
    }
    #search-popup-modal .search-popup-item-hit-btn {
      border: 1px solid #93c5fd;
      background: #fff;
      color: #1d4ed8;
      border-radius: 4px;
      width: 22px;
      height: 22px;
      line-height: 1;
      font-size: 13px;
      padding: 0;
      cursor: pointer;
    }
    #search-popup-modal .search-popup-item-hit-btn:hover {
      background: #eff6ff;
    }
    #search-popup-modal .search-popup-item-hit-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    #search-popup-modal .search-popup-item-badge-trash {
      flex: 0 0 auto;
      font-size: 11px;
      font-weight: 700;
      color: #7f1d1d;
      background: #fee2e2;
      border: 1px solid #fecaca;
      border-radius: 9999px;
      padding: 2px 8px;
      line-height: 1.2;
    }
    #search-popup-modal .search-popup-empty {
      color: #9ca3af;
      font-size: 13px;
      padding: 8px 10px;
    }
    #search-popup-modal .search-popup-vector-divider {
      text-align: center;
      color: #9ca3af;
      font-size: 11px;
      padding: 6px 0;
      border-top: 1px solid #f3f4f6;
      margin-top: 4px;
    }
    #search-popup-modal .search-popup-item--vector {
      opacity: 0.85;
      background: #fafafa;
    }
    #search-popup-modal .search-popup-item--vector:hover {
      opacity: 1;
      background: #f0f4ff;
    }
    #search-popup-modal .search-popup-vhit-btn {
      background: none;
      border: none;
      color: #6366f1;
      font-size: inherit;
      font-family: inherit;
      cursor: pointer;
      padding: 0 2px;
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    #search-popup-modal .search-popup-vhit-btn:hover {
      color: #4f46e5;
    }
    /* ダークテーマ上書き */
    html.theme-dark #search-popup-modal .search-popup-dialog {
      background: #1f2937;
      border-color: #374151;
    }
    html.theme-dark #search-popup-modal .search-popup-header {
      border-bottom-color: #374151;
      background: #111827;
    }
    html.theme-dark #search-popup-modal .search-popup-title { color: #e5e7eb; }
    html.theme-dark #search-popup-modal .search-popup-close { color: #9ca3af; }
    html.theme-dark #search-popup-modal .search-popup-close:hover {
      background: rgba(255, 255, 255, 0.08);
      color: #e5e7eb;
    }
    html.theme-dark #search-popup-modal .search-popup-input-row { border-bottom-color: #374151; }
    html.theme-dark #search-popup-modal .search-popup-input {
      background: #111827;
      border-color: #4b5563;
      color: #e5e7eb;
    }
    html.theme-dark #search-popup-modal .search-popup-result-meta {
      color: #f9a8d4;
      background: rgba(236, 72, 153, 0.15);
      border-bottom-color: #374151;
    }
    html.theme-dark #search-popup-modal .search-popup-scope-row {
      border-bottom-color: #374151;
      background: #111827;
      color: #d1d5db;
    }
    html.theme-dark #search-popup-modal .search-popup-match-toggle { color: #e5e7eb; }
    html.theme-dark #search-popup-modal .search-popup-switch-slider { background: #4b5563; }
    html.theme-dark #search-popup-modal .search-popup-item {
      background: #1f2937;
      color: #e5e7eb;
    }
    html.theme-dark #search-popup-modal .search-popup-item:hover { background: #111827; }
    html.theme-dark #search-popup-modal .search-popup-item.active {
      background: rgba(59, 130, 246, 0.25);
      box-shadow: inset 0 0 0 1px #60a5fa;
    }
    html.theme-dark #search-popup-modal .search-popup-item-hit-count { color: #93c5fd; }
    html.theme-dark #search-popup-modal .search-popup-item-hit-btn {
      border-color: rgba(96, 165, 250, 0.45);
      background: #1f2937;
      color: #93c5fd;
    }
    html.theme-dark #search-popup-modal .search-popup-item-hit-btn:hover {
      background: rgba(59, 130, 246, 0.25);
    }
    html.theme-dark #search-popup-modal .search-popup-item-badge-trash {
      color: #fecaca;
      background: rgba(248, 113, 113, 0.16);
      border-color: rgba(248, 113, 113, 0.4);
    }
    html.theme-dark #search-popup-modal .search-popup-vector-divider {
      border-top-color: #374151;
    }
    html.theme-dark #search-popup-modal .search-popup-item--vector { background: #111827; }
    html.theme-dark #search-popup-modal .search-popup-item--vector:hover {
      background: rgba(59, 130, 246, 0.15);
    }
  `
  document.head.appendChild(style)

  const inputEl = modal.querySelector('.search-popup-input')
  const submitEl = modal.querySelector('.search-popup-submit')
  const closeEl = modal.querySelector('.search-popup-close')
  const dialogEl = modal.querySelector('.search-popup-dialog')
  const headerEl = modal.querySelector('.search-popup-header')
  const scopeInputs = modal.querySelectorAll('input[name="search-popup-scope"]')
  const matchSwitchEl = modal.querySelector('.search-popup-match-switch')

  scopeInputs.forEach((scopeInput) => {
    scopeInput.checked = scopeInput.value === searchScope
    scopeInput.addEventListener('change', async () => {
      if (!scopeInput.checked) return
      searchScope = scopeInput.value === 'selected' ? 'selected' : 'root'
      if (scopeInput.value === 'selected' && !selectedNodeId) {
        showToast(t('editor.searchSelectedNodeMissing'), 'error')
      }
      await performSearch(inputEl.value, { updatePopup: true, scope: searchScope, matchMode: searchMatchMode })
    })
  })
  if (matchSwitchEl) {
    matchSwitchEl.checked = searchMatchMode === 'or'
    matchSwitchEl.addEventListener('change', async () => {
      searchMatchMode = matchSwitchEl.checked ? 'or' : 'and'
      await performSearch(inputEl.value, { updatePopup: true, scope: searchScope, matchMode: searchMatchMode })
    })
  }
  const titleOnlyToggleEl = modal.querySelector('.search-popup-title-only-toggle')
  if (titleOnlyToggleEl) {
    titleOnlyToggleEl.checked = searchOnlyTitle === true
    titleOnlyToggleEl.addEventListener('change', async () => {
      searchOnlyTitle = titleOnlyToggleEl.checked === true
      await performSearch(inputEl.value, { updatePopup: true, scope: searchScope, matchMode: searchMatchMode, onlyTitle: searchOnlyTitle })
    })
  }

  // Draggable popup (drag by header)
  let dragActive = false
  let dragOffsetX = 0
  let dragOffsetY = 0

  const startDrag = (clientX, clientY) => {
    const rect = dialogEl.getBoundingClientRect()
    dragActive = true
    dragOffsetX = clientX - rect.left
    dragOffsetY = clientY - rect.top
  }

  const moveDrag = (clientX, clientY) => {
    if (!dragActive) return
    const dialogRect = dialogEl.getBoundingClientRect()
    const maxLeft = Math.max(0, window.innerWidth - dialogRect.width)
    const maxTop = Math.max(0, window.innerHeight - dialogRect.height)
    const nextLeft = Math.min(Math.max(0, clientX - dragOffsetX), maxLeft)
    const nextTop = Math.min(Math.max(0, clientY - dragOffsetY), maxTop)
    dialogEl.style.left = `${nextLeft}px`
    dialogEl.style.top = `${nextTop}px`
  }

  const endDrag = () => {
    dragActive = false
  }

  headerEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return
    // close button drag start should be ignored
    if (e.target.closest('.search-popup-close')) return
    e.preventDefault()
    startDrag(e.clientX, e.clientY)
  })
  document.addEventListener('mousemove', (e) => moveDrag(e.clientX, e.clientY))
  document.addEventListener('mouseup', endDrag)

  const runSearch = async () => {
    const checkedScope = modal.querySelector('input[name="search-popup-scope"]:checked')?.value
    const scope = checkedScope === 'selected' ? 'selected' : 'root'
    const matchMode = matchSwitchEl && matchSwitchEl.checked ? 'or' : 'and'
    const onlyTitle = titleOnlyToggleEl ? titleOnlyToggleEl.checked === true : searchOnlyTitle === true
    await performSearch(inputEl.value, { updatePopup: true, scope, matchMode, onlyTitle })
  }

  submitEl.addEventListener('click', runSearch)
  inputEl.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault()
      await runSearch()
    }
  })
  closeEl.addEventListener('click', closeSearchPopup)
  document.addEventListener('keydown', (e) => {
    if (!searchPopupVisible) return
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    closeSearchPopup()
  }, true)

  return modal
}

function getReachableNodeIdSet(rootId, excludedNodeId = null) {
  const reachable = new Set()
  if (!rootId || rootId === excludedNodeId) {
    return reachable
  }

  const adjacency = new Map()
  relations.forEach((rel) => {
    const children = adjacency.get(rel.parent_node_id) || []
    children.push(rel.child_node_id)
    adjacency.set(rel.parent_node_id, children)
  })

  const stack = [rootId]
  reachable.add(rootId)

  while (stack.length > 0) {
    const parentId = stack.pop()
    const children = adjacency.get(parentId) || []
    children.forEach((childId) => {
      if (childId === excludedNodeId || reachable.has(childId)) return
      reachable.add(childId)
      stack.push(childId)
    })
  }

  return reachable
}

function getTrashReachableNodeIdSet() {
  return getReachableNodeIdSet(currentTrashRootNodeId)
}

function getNormalReachableNodeIdSet() {
  // 参照リンクを含む通常側の全経路をたどり、ゴミ箱rootは除外する。
  return getReachableNodeIdSet(currentRootNodeId, currentTrashRootNodeId)
}

function getSharedTrashNodeIdSet(trashReachableNodeIds) {
  const shared = new Set()
  if (!trashReachableNodeIds || trashReachableNodeIds.size === 0) return shared

  const normalReachableNodeIds = getNormalReachableNodeIdSet()
  trashReachableNodeIds.forEach((nodeId) => {
    if (normalReachableNodeIds.has(nodeId)) shared.add(nodeId)
  })

  return shared
}

function renderSearchPopupResults() {
  const modal = document.getElementById('search-popup-modal')
  if (!modal) return

  const listEl = modal.querySelector('.search-popup-results')
  const metaEl = modal.querySelector('.search-popup-result-meta')
  const trashReachableNodeIds = getTrashReachableNodeIdSet()
  const sharedTrashNodeIds = getSharedTrashNodeIdSet(trashReachableNodeIds)

  const queryText = searchQuery || ''
  const scopeLabel = searchScope === 'selected' ? t('editor.searchScopeSelected') : t('editor.searchScopeRoot')
  const matchLabel = searchMatchMode === 'or' ? 'OR' : 'AND'
  if (!queryText) {
    metaEl.textContent = t('editor.searchMetaPrompt', { scope: scopeLabel, match: matchLabel })
    listEl.innerHTML = `<div class="search-popup-empty">${t('editor.searchResultsPlaceholder')}</div>`
    return
  }

  if (searchResults.length === 0) {
    metaEl.textContent = t('editor.searchMetaNoHits', { scope: scopeLabel, match: matchLabel })
    listEl.innerHTML = `<div class="search-popup-empty">${t('editor.searchNoMatchingNodes')}</div>`
    return
  }

  const wordResults = searchResults.filter(n => !n.is_vector_match)
  const vectorResults = searchResults.filter(n => n.is_vector_match)
  const wordHitLabel = wordResults.length === 1
    ? t('editor.searchHitCountOne', { count: wordResults.length })
    : t('editor.searchHitCountOther', { count: wordResults.length })

  if (vectorResults.length > 0) {
    const vectorHitLabel = vectorResults.length === 1
      ? t('editor.vectorHitCountOne', { count: vectorResults.length })
      : t('editor.vectorHitCountOther', { count: vectorResults.length })
    metaEl.innerHTML = `${scopeLabel} | ${matchLabel} | ${wordHitLabel} + <button class="search-popup-vhit-btn" title="${t('editor.vectorSearch')}">${vectorHitLabel}</button>`
    metaEl.querySelector('.search-popup-vhit-btn').addEventListener('click', () => {
      const divider = listEl.querySelector('.search-popup-vector-divider')
      if (divider) divider.scrollIntoView({ block: 'start', behavior: 'smooth' })
    })
  } else {
    metaEl.textContent = `${scopeLabel} | ${matchLabel} | ${wordHitLabel}`
  }

  const renderItem = (node, isVector) => {
    const isInTrashSubtree = trashReachableNodeIds.has(node.id) && node.id !== currentTrashRootNodeId
    const isSharedTrashNode = isInTrashSubtree && sharedTrashNodeIds.has(node.id)
    const isTrashOnlyNode = isInTrashSubtree && !isSharedTrashNode
    const locationClass = isTrashOnlyNode ? 'trash' : (isSharedTrashNode ? 'shared' : 'normal')
    const vectorClass = isVector ? ' search-popup-item--vector' : ''
    return `
      <button type="button" class="search-popup-item${vectorClass}" data-node-id="${node.id}" data-location-class="${locationClass}">
        <span class="search-popup-item-title">${escapeHtml(node.title || t('editor.untitled'))}</span>
        <span class="search-popup-item-hit-nav" aria-hidden="true">
          <button type="button" class="search-popup-item-hit-btn" data-hit-dir="prev" title="${t('editor.previousHit')}" aria-label="${t('editor.previousHit')}">&lsaquo;</button>
          <span class="search-popup-item-hit-count">-/-</span>
          <button type="button" class="search-popup-item-hit-btn" data-hit-dir="next" title="${t('editor.nextHit')}" aria-label="${t('editor.nextHit')}">&rsaquo;</button>
        </span>
        ${isTrashOnlyNode ? `<span class="search-popup-item-badge-trash">🗑 ${t('editor.trash')}</span>` : ''}
      </button>
    `
  }

  const wordHtml = wordResults.map(n => renderItem(n, false)).join('')
  const vectorHtml = vectorResults.length > 0
    ? `<div class="search-popup-vector-divider"><span>— Vhit —</span></div>` +
      vectorResults.map(n => renderItem(n, true)).join('')
    : ''
  listEl.innerHTML = wordHtml + vectorHtml

  listEl.querySelectorAll('.search-popup-item').forEach(btn => {
    btn.addEventListener('click', async (event) => {
      if (event.target.closest('.search-popup-item-hit-btn')) return
      const nodeId = btn.dataset.nodeId
      if (!nodeId) return
      const locationClass = btn.dataset.locationClass || 'normal'
      const shouldShowTrashView = locationClass === 'trash'
      if (shouldShowTrashView && treeViewMode !== 'trash') {
        hideNormalViewMenu()
        treeViewMode = 'trash'
        document.querySelectorAll('.tree-view-tab').forEach(t => t.classList.remove('active'))
        document.querySelector('.tree-view-tab[data-view="trash"]')?.classList.add('active')
        renderTree()
      } else if (!shouldShowTrashView && treeViewMode === 'trash') {
        hideNormalViewMenu()
        treeViewMode = 'normal'
        document.querySelectorAll('.tree-view-tab').forEach(t => t.classList.remove('active'))
        document.querySelector('.tree-view-tab[data-view="normal"]')?.classList.add('active')
        renderTree()
      }
      setActiveSearchPopupItem(btn)
      pendingSearchHighlight = {
        nodeId,
        terms: extractSearchHighlightTerms(searchQuery)
      }
      await selectNode(nodeId, null)
    })

    btn.querySelectorAll('.search-popup-item-hit-btn').forEach(navBtn => {
      navBtn.addEventListener('click', (event) => {
        event.stopPropagation()
        if (!btn.classList.contains('active')) return
        const dir = navBtn.dataset.hitDir === 'prev' ? -1 : 1
        navigateSearchHit(dir)
      })
    })
  })
}

function setActiveSearchPopupItem(btn) {
  const listEl = document.querySelector('.search-popup-results')
  if (!listEl) return
  listEl.querySelectorAll('.search-popup-item.active').forEach(el => {
    if (el !== btn) {
      el.classList.remove('active')
      const countEl = el.querySelector('.search-popup-item-hit-count')
      if (countEl) countEl.textContent = '-/-'
    }
  })
  if (btn) btn.classList.add('active')
}

function updateActiveSearchHitCount() {
  const listEl = document.querySelector('.search-popup-results')
  if (!listEl) return
  const activeBtn = listEl.querySelector('.search-popup-item.active')
  if (!activeBtn) return
  const countEl = activeBtn.querySelector('.search-popup-item-hit-count')
  if (!countEl) return
  const total = Array.isArray(activeSearchPreviewMarks) ? activeSearchPreviewMarks.length : 0
  if (total === 0) {
    countEl.textContent = '0/0'
  } else {
    const idx = Math.min(total - 1, Math.max(0, currentSearchHitIndex))
    countEl.textContent = `${idx + 1}/${total}`
  }
  const prevBtn = activeBtn.querySelector('.search-popup-item-hit-btn[data-hit-dir="prev"]')
  const nextBtn = activeBtn.querySelector('.search-popup-item-hit-btn[data-hit-dir="next"]')
  if (prevBtn) prevBtn.disabled = total <= 1
  if (nextBtn) nextBtn.disabled = total <= 1
}

function focusSearchHit(index) {
  if (!Array.isArray(activeSearchPreviewMarks) || activeSearchPreviewMarks.length === 0) {
    currentSearchHitIndex = 0
    updateActiveSearchHitCount()
    return
  }
  const total = activeSearchPreviewMarks.length
  const safeIndex = ((index % total) + total) % total
  currentSearchHitIndex = safeIndex
  activeSearchPreviewMarks.forEach((mark, i) => {
    if (!mark) return
    mark.classList.toggle('current', i === safeIndex)
  })
  const target = activeSearchPreviewMarks[safeIndex]
  if (target && typeof target.scrollIntoView === 'function') {
    target.scrollIntoView({ block: 'center', behavior: 'auto' })
  }
  updateActiveSearchHitCount()
}

function navigateSearchHit(direction) {
  if (!Array.isArray(activeSearchPreviewMarks) || activeSearchPreviewMarks.length === 0) return
  const dir = direction < 0 ? -1 : 1
  focusSearchHit(currentSearchHitIndex + dir)
}

// ===============================
// コンテンツ内検索（現在表示中のノード内容のみを対象）
// ===============================
function clearContentSearchHighlight() {
  const affectedParents = new Set()
  if (Array.isArray(contentSearchMarks)) {
    contentSearchMarks.forEach((markEl) => {
      if (!markEl || !markEl.parentNode) return
      affectedParents.add(markEl.parentNode)
      const textNode = document.createTextNode(markEl.textContent || '')
      markEl.parentNode.replaceChild(textNode, markEl)
    })
  }
  affectedParents.forEach((parent) => parent.normalize())
  contentSearchMarks = []
  contentSearchHitIndex = 0
  updateContentSearchHitCountUI()
}

function applyContentSearchHighlight(terms) {
  if (!Array.isArray(terms) || terms.length === 0) return false
  const previewPane = document.querySelector('#node-content-editor .bytemd-preview')
  if (!previewPane) return false

  let firstMarked = null
  let markedCount = 0
  const maxMarks = 200

  const walker = document.createTreeWalker(previewPane, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parentTag = node.parentNode?.nodeName
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT
      if (parentTag === 'SCRIPT' || parentTag === 'STYLE') return NodeFilter.FILTER_REJECT
      if (node.parentNode?.classList?.contains('content-search-hit-highlight')) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    }
  })

  const textNodes = []
  while (walker.nextNode()) {
    textNodes.push(walker.currentNode)
  }

  for (const textNode of textNodes) {
    if (markedCount >= maxMarks) break
    if (!textNode?.parentNode) continue
    const text = textNode.nodeValue || ''
    const textLower = text.toLowerCase()
    const ranges = []

    terms.forEach((term) => {
      const needle = String(term || '').toLowerCase()
      if (!needle) return
      let startIndex = 0
      while (startIndex < textLower.length) {
        const idx = textLower.indexOf(needle, startIndex)
        if (idx < 0) break
        ranges.push({ start: idx, end: idx + needle.length })
        startIndex = idx + needle.length
      }
    })

    if (ranges.length === 0) continue

    ranges.sort((a, b) => a.start - b.start || a.end - b.end)
    const merged = []
    ranges.forEach((r) => {
      const last = merged[merged.length - 1]
      if (!last || r.start > last.end) {
        merged.push({ ...r })
      } else if (r.end > last.end) {
        last.end = r.end
      }
    })

    const fragment = document.createDocumentFragment()
    let cursor = 0
    merged.forEach((r) => {
      if (markedCount >= maxMarks) return
      if (r.start > cursor) {
        fragment.appendChild(document.createTextNode(text.slice(cursor, r.start)))
      }
      const mark = document.createElement('span')
      mark.className = 'content-search-hit-highlight'
      mark.textContent = text.slice(r.start, r.end)
      fragment.appendChild(mark)
      contentSearchMarks.push(mark)
      if (!firstMarked) firstMarked = mark
      markedCount += 1
      cursor = r.end
    })

    if (cursor < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(cursor)))
    }

    textNode.parentNode.replaceChild(fragment, textNode)
  }

  if (firstMarked) {
    contentSearchHitIndex = 0
    focusContentSearchHit(0)
    return true
  }

  return false
}

function updateContentSearchHitCountUI() {
  const countEl = document.getElementById('content-search-hit-count')
  const navEl = document.getElementById('content-search-hit-nav')
  const prevBtn = document.getElementById('content-search-prev-btn')
  const nextBtn = document.getElementById('content-search-next-btn')
  const total = Array.isArray(contentSearchMarks) ? contentSearchMarks.length : 0
  if (navEl) navEl.style.display = total > 0 ? 'inline-flex' : 'none'
  if (countEl) {
    const idx = total === 0 ? 0 : Math.min(total - 1, Math.max(0, contentSearchHitIndex))
    countEl.textContent = total === 0 ? '0/0' : `${idx + 1}/${total}`
  }
  if (prevBtn) prevBtn.disabled = total <= 1
  if (nextBtn) nextBtn.disabled = total <= 1
}

function focusContentSearchHit(index) {
  if (!Array.isArray(contentSearchMarks) || contentSearchMarks.length === 0) {
    contentSearchHitIndex = 0
    updateContentSearchHitCountUI()
    return
  }
  const total = contentSearchMarks.length
  const safeIndex = ((index % total) + total) % total
  contentSearchHitIndex = safeIndex
  contentSearchMarks.forEach((mark, i) => {
    if (!mark) return
    mark.classList.toggle('current', i === safeIndex)
  })
  const target = contentSearchMarks[safeIndex]
  if (target && typeof target.scrollIntoView === 'function') {
    target.scrollIntoView({ block: 'center', behavior: 'auto' })
  }
  updateContentSearchHitCountUI()
}

function navigateContentSearchHit(direction) {
  if (!Array.isArray(contentSearchMarks) || contentSearchMarks.length === 0) return
  const dir = direction < 0 ? -1 : 1
  focusContentSearchHit(contentSearchHitIndex + dir)
}

function performContentSearch(rawQuery) {
  clearContentSearchHighlight()
  const terms = extractSearchHighlightTerms(rawQuery)
  if (terms.length === 0) return
  const applied = applyContentSearchHighlight(terms)
  if (!applied) {
    showToast(t('editor.contentNotFound'), 'info')
  }
}

function openSearchPopup() {
  const modal = createSearchPopup()
  const inputEl = modal.querySelector('.search-popup-input')
  modal.querySelectorAll('input[name="search-popup-scope"]').forEach((radio) => {
    radio.checked = radio.value === searchScope
  })
  const matchSwitchEl = modal.querySelector('.search-popup-match-switch')
  if (matchSwitchEl) {
    matchSwitchEl.checked = searchMatchMode === 'or'
  }
  const titleOnlyToggleEl = modal.querySelector('.search-popup-title-only-toggle')
  if (titleOnlyToggleEl) {
    titleOnlyToggleEl.checked = searchOnlyTitle === true
  }
  inputEl.value = searchQuery || ''
  modal.classList.add('active')
  searchPopupVisible = true
  renderSearchPopupResults()
  setTimeout(() => inputEl.focus(), 0)
}

function closeSearchPopup() {
  const modal = document.getElementById('search-popup-modal')
  if (modal) {
    modal.classList.remove('active')
  }
  searchPopupVisible = false
}

function expandParents(nodeId) {
  if (!nodeId) return
  const visited = new Set()
  const stack = [nodeId]
  while (stack.length > 0) {
    const currentId = stack.pop()
    if (visited.has(currentId)) continue
    visited.add(currentId)
    const parentRelations = relationParentsByChild.get(currentId) || []
    parentRelations.forEach(rel => {
      const parentId = rel.parent_node_id
      if (!parentId) return
      expandedNodes.add(parentId)
      if (!visited.has(parentId)) stack.push(parentId)
    })
  }
}

// 通常ツリー上で nodeId を表示する経路（例: "Z-A"）。STRUCTURAL の親を優先して辿り、
// ルート直下で止める。ルートへ辿れない（ゴミ箱のみ・循環など）ときは null
function buildPreferredTreePath(nodeId) {
  if (!nodeId || !currentRootNodeId) return null
  const rootId = String(currentRootNodeId)
  const visited = new Set()
  const isStructural = (rel) => Number(rel.relation_type_id) === 1
  const climb = (id) => {
    if (id === rootId) return []
    if (visited.has(id)) return null
    visited.add(id)
    const parentRelations = relationParentsByChild.get(id) || []
    const ordered = [...parentRelations.filter(isStructural), ...parentRelations.filter(rel => !isStructural(rel))]
    for (const rel of ordered) {
      const chain = rel.parent_node_id ? climb(String(rel.parent_node_id)) : null
      if (chain) return [...chain, id]
    }
    return null
  }
  const chain = climb(String(nodeId))
  return chain && chain.length > 0 ? chain.join('-') : null
}

// nodePath（例: "X-A"）が今のツリーで成り立つか。先頭がルート直下、各段が親子関係、末尾が nodeId
function isValidTreePath(nodePath, nodeId) {
  if (typeof nodePath !== 'string' || !nodePath || !currentRootNodeId) return false
  const ids = nodePath.split('-')
  if (ids[ids.length - 1] !== String(nodeId)) return false
  const isChildOf = (parentId, childId) =>
    (relationParentsByChild.get(childId) || []).some(rel => String(rel.parent_node_id) === parentId)
  return ids.every((id, i) => isChildOf(i === 0 ? String(currentRootNodeId) : ids[i - 1], id))
}

const RELOAD_SELECTION_STORAGE_KEY = 'zeeta:reload-selection'

// 「new ver.」のリロード直前に、通常表示の選択位置を同じタブの sessionStorage へ残す
// （URL は共有URLと同じ形のままにするため、パスは URL に載せない）
function rememberSelectionForReload() {
  if (treeViewMode !== 'normal' || !currentTreeId || !selectedNodeId || !selectedNodePath) return
  try {
    sessionStorage.setItem(RELOAD_SELECTION_STORAGE_KEY, JSON.stringify({
      treeId: String(currentTreeId),
      nodeId: String(selectedNodeId),
      nodePath: String(selectedNodePath)
    }))
  } catch (error) {
    // 保存できなければ、リロード後は STRUCTURAL の経路で開く
  }
}

// 保存された選択位置を1回だけ取り出す。URL のツリー・ノードと一致し、今のツリーで成り立つパスのときだけ返す
function takeReloadSelectionPath(nodeId) {
  let saved = null
  try {
    saved = JSON.parse(sessionStorage.getItem(RELOAD_SELECTION_STORAGE_KEY) || 'null')
    sessionStorage.removeItem(RELOAD_SELECTION_STORAGE_KEY)
  } catch (error) {
    return null
  }
  if (!saved || !nodeId || saved.treeId !== String(currentTreeId) || saved.nodeId !== String(nodeId)) return null
  return isValidTreePath(saved.nodePath, nodeId) ? saved.nodePath : null
}

// URL・ノードリンクからノードを開く。全ての祖先ではなく、優先経路上の祖先だけを展開して選ぶ。
// options.nodePath があればその経路（呼び出し側で検証済み）を使う
async function openNodeAlongPreferredPath(nodeId, options = {}) {
  const { nodePath: requestedPath = null, ...selectOptions } = options
  const nodePath = treeViewMode === 'normal' ? (requestedPath || buildPreferredTreePath(nodeId)) : null
  if (nodePath) {
    const ids = nodePath.split('-')
    for (let i = 1; i < ids.length; i += 1) {
      expandedNodePaths.add(ids.slice(0, i).join('-'))
    }
    renderTree()
  }
  return selectNode(nodeId, nodePath, selectOptions)
}

// ===============================
// 通常タブメニュー（root操作 + rootソート）
// ===============================
function createNormalViewMenu() {
  let menu = document.getElementById('normal-view-menu')
  if (menu) return menu

  menu = document.createElement('div')
  menu.id = 'normal-view-menu'
  menu.innerHTML = `
    <div class="normal-menu-section-title">${t('editor.rootOperations')}</div>
    <div class="normal-menu-item" data-action="root-add-top-node">
      <i class="fas fa-plus"></i>
      <span>${t('editor.createTopNode')}</span>
    </div>
    <div class="normal-menu-item" data-action="root-collapse-descendants">
      <i class="fas fa-folder"></i>
      <span>${t('editor.collapseChildNodes')}</span>
    </div>
    <div class="normal-menu-separator"></div>
    <div class="normal-menu-section-title">${t('editor.rootSort')}</div>
    <div class="normal-menu-item" data-action="root-sort-mode-manual">
      <i class="fas fa-check normal-menu-check"></i>
      <span>${t('editor.sortManualDefault')}</span>
    </div>
    <div class="normal-menu-item" data-action="root-sort-mode-created_at">
      <i class="fas fa-check normal-menu-check"></i>
      <span>${t('editor.sortCreatedAt')}</span>
    </div>
    <div class="normal-menu-item" data-action="root-sort-mode-updated_at">
      <i class="fas fa-check normal-menu-check"></i>
      <span>${t('editor.sortUpdatedAt')}</span>
    </div>
    <div class="normal-menu-item" data-action="root-sort-mode-title">
      <i class="fas fa-check normal-menu-check"></i>
      <span>${t('editor.sortTitle')}</span>
    </div>
    <div class="normal-menu-separator"></div>
    <div class="normal-menu-item" data-action="root-sort-direction-asc">
      <i class="fas fa-check normal-menu-check"></i>
      <span>${t('editor.sortAscending')}</span>
    </div>
    <div class="normal-menu-item" data-action="root-sort-direction-desc">
      <i class="fas fa-check normal-menu-check"></i>
      <span>${t('editor.sortDescending')}</span>
    </div>
  `
  document.body.appendChild(menu)

  const style = document.createElement('style')
  style.textContent = `
    #normal-view-menu {
      display: none;
      position: fixed;
      background: white;
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14);
      padding: 6px 0;
      min-width: 200px;
      z-index: 10015;
      border: 1px solid #e5e7eb;
    }
    #normal-view-menu.active { display: block; }
    .normal-menu-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 14px;
      cursor: pointer;
      font-size: 14px;
      color: #374151;
      line-height: 1.2;
    }
    .normal-menu-item:hover { background: #f3f4f6; }
    .normal-menu-item i { width: 16px; color: #6b7280; text-align: center; }
    .normal-menu-check { opacity: 0; color: #2563eb !important; }
    .normal-menu-item.active-sort .normal-menu-check { opacity: 1; }
    .normal-menu-section-title {
      font-size: 11px;
      font-weight: 600;
      color: #6b7280;
      padding: 4px 14px 2px;
      text-transform: uppercase;
    }
    .normal-menu-separator {
      height: 1px;
      background: #e5e7eb;
      margin: 4px 0;
    }
    /* ダークテーマ上書き */
    html.theme-dark #normal-view-menu {
      background: #1f2937;
      border-color: #374151;
    }
    html.theme-dark .normal-menu-item {
      color: #e5e7eb;
    }
    html.theme-dark .normal-menu-item:hover { background: #111827; }
    html.theme-dark .normal-menu-item i { color: #9ca3af; }
    html.theme-dark .normal-menu-check { color: #60a5fa !important; }
    html.theme-dark .normal-menu-section-title {
      color: #9ca3af;
    }
    html.theme-dark .normal-menu-separator {
      background: #374151;
    }
  `
  document.head.appendChild(style)

  menu.querySelectorAll('.normal-menu-item').forEach(item => {
    item.addEventListener('click', async (e) => {
      e.stopPropagation()
      const action = item.dataset.action
      const keepMenuOpen = action?.startsWith('root-sort-mode-') || action?.startsWith('root-sort-direction-')
      await handleNormalViewMenuAction(action)
      if (keepMenuOpen) {
        updateNormalViewMenuSortState(menu)
      } else {
        hideNormalViewMenu()
      }
    })
  })

  document.addEventListener('click', hideNormalViewMenu)
  return menu
}

function hideNormalViewMenu() {
  const menu = document.getElementById('normal-view-menu')
  if (menu) menu.classList.remove('active')
}

function toggleNormalViewMenu(anchor) {
  const menu = createNormalViewMenu()
  updateNormalViewMenuSortState(menu)

  const isActive = menu.classList.contains('active')
  if (isActive) {
    hideNormalViewMenu()
    return
  }

  const rect = anchor.getBoundingClientRect()
  menu.style.left = `${rect.left}px`
  menu.style.top = `${rect.bottom + 4}px`
  menu.classList.add('active')
}

function updateNormalViewMenuSortState(menu) {
  const sortConfig = getChildSortConfig(currentRootNodeId)
  const sortModeActions = ['manual', 'created_at', 'updated_at', 'title']
  sortModeActions.forEach(mode => {
    const item = menu.querySelector(`[data-action="root-sort-mode-${mode}"]`)
    if (!item) return
    item.classList.toggle('active-sort', sortConfig.mode === mode)
  })
  const ascItem = menu.querySelector('[data-action="root-sort-direction-asc"]')
  const descItem = menu.querySelector('[data-action="root-sort-direction-desc"]')
  if (ascItem) ascItem.classList.toggle('active-sort', sortConfig.direction === 'asc')
  if (descItem) descItem.classList.toggle('active-sort', sortConfig.direction === 'desc')
}

async function applyRootSort(nextMode, nextDirection) {
  if (!currentRootNodeId) {
    showToast(t('editor.rootNodeNotFound'), 'error')
    return false
  }
  const current = getChildSortConfig(currentRootNodeId)
  const mode = normalizeSortMode(nextMode || current.mode)
  const direction = normalizeSortDirection(nextDirection || current.direction)
  const success = await updateNodeSortSettings(currentRootNodeId, mode, direction)
  if (!success) return false
  await fetchNodes()
  return true
}

function applyRootDescendantsCollapse() {
  if (!currentRootNodeId) {
    showToast(t('editor.rootNodeNotFound'), 'error')
    return false
  }

  expandedNodePaths.clear()
  expandedNodes.clear()
  renderTree()
  return true
}

async function handleNormalViewMenuAction(action) {
  switch (action) {
    case 'root-add-top-node':
      hideNormalViewMenu()
      await addChildNode(currentRootNodeId)
      return
    case 'root-collapse-descendants':
      applyRootDescendantsCollapse()
      return
    case 'root-sort-mode-manual':
      if (!(await applyRootSort('manual', null))) showToast(t('editor.rootSortSaveFailed'), 'error')
      return
    case 'root-sort-mode-created_at':
      if (!(await applyRootSort('created_at', null))) showToast(t('editor.rootSortSaveFailed'), 'error')
      return
    case 'root-sort-mode-updated_at':
      if (!(await applyRootSort('updated_at', null))) showToast(t('editor.rootSortSaveFailed'), 'error')
      return
    case 'root-sort-mode-title':
      if (!(await applyRootSort('title', null))) showToast(t('editor.rootSortSaveFailed'), 'error')
      return
    case 'root-sort-direction-asc':
      if (!(await applyRootSort(null, 'asc'))) showToast(t('editor.rootSortSaveFailed'), 'error')
      return
    case 'root-sort-direction-desc':
      if (!(await applyRootSort(null, 'desc'))) showToast(t('editor.rootSortSaveFailed'), 'error')
      return
  }
}

// ===============================
// ツリー表示
// ===============================
function buildTree() {
  const nodeMap = new Map()
  const rootNodes = []
  const childNodeIds = new Set()

  // ノードをマップに格納
  nodes.forEach(node => {
    nodeMap.set(node.id, { ...node, children: [], parents: [] })
  })

  // リレーションベースで親子関係を構築
  // 各リレーションのpositionを子ノードに保持
  relations.forEach(rel => {
    const parent = nodeMap.get(rel.parent_node_id)
    const child = nodeMap.get(rel.child_node_id)

    if (parent && child) {
      // 子ノードにこのリレーション固有のpositionを付与
      const childWithPosition = {
        ...child,
        relationPosition: rel.position || 0,
        relationParentId: rel.parent_node_id,
        relation_type_id: Number(rel.relation_type_id) || 1,
        relation_type_name: rel.relation_type_name || 'STRUCTURAL'
      }
      parent.children.push(childWithPosition)
      child.parents.push(parent)
      childNodeIds.add(rel.child_node_id)
    }
  })

  // 各親ノードの children を親ノードのソート設定でソート
  nodeMap.forEach(node => {
    if (node.children.length > 0) {
      const sortConfig = getChildSortConfig(node.id)
      node.children.sort((a, b) => compareNodesBySortMode(a, b, sortConfig.mode, sortConfig.direction))
    }
  })

  // rootノードの子をトップレベルとして返す
  if (currentRootNodeId) {
    const rootNode = nodeMap.get(currentRootNodeId)
    if (rootNode) {
      return rootNode.children || []
    }
  }

  // フォールバック: 親を持たないノードをルートとする
  nodes.forEach(node => {
    if (!childNodeIds.has(node.id)) {
      rootNodes.push(nodeMap.get(node.id))
    }
  })

  const rootSort = getChildSortConfig(currentRootNodeId)
  rootNodes.sort((a, b) => compareNodesBySortMode(a, b, rootSort.mode, rootSort.direction))

  return rootNodes
}

function buildTrashTree() {
  if (!currentTrashRootNodeId) return []

  const nodeMap = new Map()
  nodes.forEach(node => {
    nodeMap.set(node.id, { ...node, children: [], parents: [] })
  })

  relations.forEach(rel => {
    const parent = nodeMap.get(rel.parent_node_id)
    const child = nodeMap.get(rel.child_node_id)
    if (parent && child) {
      const childWithPosition = {
        ...child,
        relationPosition: rel.position || 0,
        relationParentId: rel.parent_node_id,
        relation_type_id: Number(rel.relation_type_id) || 1,
        relation_type_name: rel.relation_type_name || 'STRUCTURAL'
      }
      parent.children.push(childWithPosition)
      child.parents.push(parent)
    }
  })

  nodeMap.forEach(node => {
    if (node.children.length > 0) {
      const sortConfig = getChildSortConfig(node.id)
      node.children.sort((a, b) => compareNodesBySortMode(a, b, sortConfig.mode, sortConfig.direction))
    }
  })

  const reachable = getTrashReachableNodeIdSet()
  const normalReachable = getNormalReachableNodeIdSet()

  const markMeta = (node) => {
    if (!node) return null
    const next = { ...node, has_non_trash_parent: normalReachable.has(node.id) }
    if (next.children && next.children.length > 0) {
      next.children = next.children
        .filter(child => reachable.has(child.id))
        .map(child => markMeta(child))
        .filter(Boolean)
    }
    return next
  }

  const trashRoot = nodeMap.get(currentTrashRootNodeId)
  if (!trashRoot) return []

  const topLevel = (trashRoot.children || [])
    .filter(child => reachable.has(child.id))
    .sort((a, b) => parseDateValue(b.deleted_at) - parseDateValue(a.deleted_at))
    .map(child => markMeta(child))
    .filter(Boolean)

  return topLevel
}

// 逆ツリー構築（選択ノード→親の方向）
function buildReverseTree() {
  // 選択されたノードがない場合は空配列を返す
  if (!selectedNodeId) {
    return []
  }

  const nodeMap = new Map()

  // ノードをマップに格納
  nodes.forEach(node => {
    nodeMap.set(node.id, { ...node, children: [], parents: [] })
  })

  // リレーションベースで親子関係を構築（逆向き）
  // root/trash rootノードは実装詳細なのでスキップ
  relations.forEach(rel => {
    if (rel.parent_node_id === currentRootNodeId || rel.parent_node_id === currentTrashRootNodeId) return
    const parent = nodeMap.get(rel.parent_node_id)
    const child = nodeMap.get(rel.child_node_id)

    if (parent && child) {
      // 逆ツリーでは、子ノードの children に親ノードを追加
      // リレーション作成順を保持
      const parentWithOrder = {
        ...parent,
        relationCreatedAt: rel.created_at,
        relation_type_id: Number(rel.relation_type_id) || 1,
        relation_type_name: rel.relation_type_name || 'STRUCTURAL'
      }
      child.children.push(parentWithOrder)
      parent.parents.push(child)
    }
  })

  // 各ノードの children をリレーション作成順でソート（逆ツリーの親ノード表示順）
  nodeMap.forEach(node => {
    if (node.children.length > 0) {
      node.children.sort((a, b) => {
        return new Date(a.relationCreatedAt || a.created_at) - new Date(b.relationCreatedAt || b.created_at)
      })
    }
  })

  // 選択されたノードのみをルートとする
  const selectedNode = nodeMap.get(selectedNodeId)
  return selectedNode ? [selectedNode] : []
}

function materializeExpandedPathsFromNodeIds(tree) {
  if (!tree || tree.length === 0 || expandedNodes.size === 0) return

  const usedNodeIds = new Set()
  const visitedNodeIds = new Set()
  const stack = tree.map(node => ({ node, path: String(node.id) }))
  while (stack.length > 0) {
    const entry = stack.pop()
    if (!entry || !entry.node) continue
    const { node, path } = entry
    if (visitedNodeIds.has(node.id)) continue
    visitedNodeIds.add(node.id)
    if (expandedNodes.has(node.id) && !usedNodeIds.has(node.id)) {
      expandedNodePaths.add(path)
      usedNodeIds.add(node.id)
      if (usedNodeIds.size === expandedNodes.size) break
    }
    if (!node.children || node.children.length === 0) continue
    for (let i = node.children.length - 1; i >= 0; i -= 1) {
      const child = node.children[i]
      stack.push({ node: child, path: `${path}-${child.id}` })
    }
  }
  expandedNodes.clear()
}

function renderTree() {
  const treeContainer = document.getElementById('tree-container')
  const tree = treeViewMode === 'reverse'
    ? buildReverseTree()
    : (treeViewMode === 'trash' ? buildTrashTree() : buildTree())
  currentDisplayTree = tree
  const renderState = {
    totalRenderedItems: 0,
    truncatedByGlobalLimit: 0,
    renderedCountByNodeId: new Map(),
    truncatedByPathLimit: 0
  }
  materializeExpandedPathsFromNodeIds(tree)

  if (tree.length === 0) {
    if (treeViewMode === 'reverse') {
      treeContainer.innerHTML = `
        <div class="text-center text-gray-400 py-8">
          <i class="fas fa-arrow-left text-3xl mb-2"></i>
          <p>${t('editor.reverseTree')}</p>
          <p class="text-sm">${t('editor.selectNodePrompt')}</p>
          <p class="text-xs mt-2">${t('editor.reverseTreeEmptyHelp')}</p>
        </div>
      `
    } else if (treeViewMode === 'trash') {
      treeContainer.innerHTML = `
        <div class="text-center text-gray-400 py-8">
          <i class="fas fa-trash text-3xl mb-2"></i>
          <p>${t('editor.trashEmpty')}</p>
        </div>
      `
    } else {
      treeContainer.innerHTML = `
        <div class="text-center text-gray-400 py-8">
          <i class="fas fa-folder-open text-3xl mb-2"></i>
          <p>${t('editor.noNodes')}</p>
          <p class="text-sm">${t('editor.noNodesHelp')}</p>
        </div>
      `
    }
    return
  }

  treeContainer.innerHTML = tree.map(node => renderTreeNode(node, 0, new Set(), String(node.id), renderState, renderConfig.preloadDescendantDepth)).join('')

  // イベントリスナーを再設定
  attachTreeEventListeners()

  // 選択状態の復元
  restoreSelection()

}

function findRenderedTreeNodeByPath(nodePath) {
  if (!nodePath || !Array.isArray(currentDisplayTree) || currentDisplayTree.length === 0) return null
  const pathIds = String(nodePath).split('-').filter(Boolean)
  if (pathIds.length === 0) return null
  let current = currentDisplayTree.find(node => node.id === pathIds[0]) || null
  if (!current) return null
  for (let i = 1; i < pathIds.length; i += 1) {
    const targetId = pathIds[i]
    current = (current.children || []).find(child => child.id === targetId) || null
    if (!current) return null
  }
  return current
}

function buildVisitedSetFromPath(nodePath) {
  const visited = new Set()
  String(nodePath).split('-').forEach(id => {
    if (id) visited.add(id)
  })
  return visited
}

function renderTreeNode(node, level, visitedNodes = new Set(), currentPath, renderState = null, preloadDepth = 0) {
  // 循環参照防止
  if (visitedNodes.has(node.id)) {
    return `<div class="text-xs text-gray-400 ml-${level * 5}">${t('editor.circularReferenceMarker')}</div>`
  }
  if (renderState) {
    if (renderState.totalRenderedItems >= renderConfig.maxRenderItemsPerTree) {
      renderState.truncatedByGlobalLimit += 1
      return `
        <div class="tree-item-omitted text-xs text-gray-400 px-2 py-1 cursor-pointer hover:text-gray-700"
             style="padding-left: ${level * 20 + 28}px;"
             data-node-id="${node.id}"
             data-node-path="${currentPath}"
             title="${t('editor.clickToNavigateNode')}">
          ${t('editor.omittedByDisplayLimit')}
        </div>
      `
    }
    renderState.totalRenderedItems += 1
  }

  if (renderState?.renderedCountByNodeId) {
    const renderedCount = renderState.renderedCountByNodeId.get(node.id) || 0
    const shouldAlwaysRender = selectedNodePath === currentPath
    if (!shouldAlwaysRender && renderedCount >= renderConfig.maxRenderPathsPerNode) {
      renderState.truncatedByPathLimit += 1
      const omittedTitle = escapeHtml(node.title || '(untitled)')
      return `
        <div class="tree-item-omitted text-xs text-gray-400 px-2 py-1 cursor-pointer hover:text-gray-700"
             style="padding-left: ${level * 20 + 28}px;"
             data-node-id="${node.id}"
             data-node-path="${currentPath}"
             title="${t('editor.clickToNavigateNode')}">
          [omit child: ${omittedTitle}]
        </div>
      `
    }
    renderState.renderedCountByNodeId.set(node.id, renderedCount + 1)
  }

  visitedNodes.add(node.id)

  // パスが渡されていない場合はIDを使用（ルートの場合など）
  if (!currentPath) currentPath = String(node.id)

  const hasChildren = node.children.length > 0
  const isExpanded = expandedNodePaths.has(currentPath)
  const shouldRenderChildren = hasChildren && (isExpanded || preloadDepth > 0)
  const expandedPreloadDepth = (treeViewMode === 'reverse') ? 0 : (isExpanded ? 1 : 0)
  const nextPreloadDepth = Math.max(preloadDepth - 1, expandedPreloadDepth)
  // パスが一致する場合のみ選択状態とする
  const isSelected = selectedNodePath === currentPath
  // 同じIDだがパスが違う場合は重複ノード
  const isDuplicate = selectedNodeId === node.id && !isSelected

  // 通常モードのみ複数親バッジを表示
  const hasMultipleParents = treeViewMode === 'normal' && node.parents && node.parents.length > 1
  const isSharedInTrash = treeViewMode === 'trash' && !!node.has_non_trash_parent
  const indent = level * 20
  const guideLinesHtml = Array.from({ length: level }, (_, index) => {
    const left = 20.5 + index * 20
    return `<span class="tree-guide-line" style="left:${left}px;"></span>`
  }).join('')

  const title = escapeHtml(node.title)
  const relationTypeId = Number(node.relation_type_id) || 1
  const relationIcon = getRelationTypeIcon(relationTypeId)
  const isStructuralRelation = relationTypeId === 1 || String(node.relation_type_name || '').toUpperCase() === 'STRUCTURAL'
  const isBoldInReverse = treeViewMode === 'reverse' && level > 0 && isStructuralRelation

  // モードによるUI制御
  const showAddChildBtn = true

  let html = `
    <div class="tree-node-wrapper" data-node-group="${node.id}">
      <div class="tree-item flex items-center px-2 rounded ${isSelected ? 'active' : ''} ${isDuplicate ? 'duplicate-active' : ''}"
           style="padding-left: ${indent + 12}px; padding-top: 2px; padding-bottom: 2px;"
           data-node-id="${node.id}"
           data-node-path="${currentPath}">
        ${guideLinesHtml ? `<span class="tree-guides" aria-hidden="true">${guideLinesHtml}</span>` : ''}
        ${hasChildren ? `
          <button type="button"
                  class="toggle-btn"
                  data-node-id="${node.id}"
                  aria-label="${isExpanded ? t('editor.collapseNode') : t('editor.expandNode')}">
            <i class="fas fa-chevron-right toggle-icon${isExpanded ? ' caret-expanded' : ''}"
               data-node-id="${node.id}"></i>
          </button>
        ` : `
          <span class="toggle-spacer" aria-hidden="true"></span>
        `}
        <span class="mr-2 text-xs select-none text-gray-400" style="opacity:0.75; display:inline-block; width:12px; text-align:center; flex:0 0 auto;" title="relation_type_id=${relationTypeId}">${relationIcon}</span>
        <span class="tree-item-title text-sm truncate ${isSharedInTrash ? 'text-gray-400' : ''}" style="${isBoldInReverse ? 'font-weight:700;' : ''}" title="${title}">${title}</span>
        <span class="tree-item-actions">
          ${hasMultipleParents ? `
            <span class="tree-multi-parent-badge" title="${t('editor.multipleParentsNode')}">
              <span>${node.parents.length}</span>
            </span>
          ` : ''}
          ${showAddChildBtn ? `
          <button class="add-child-btn text-gray-400 hover:text-blue-500 text-xs"
                  data-node-id="${node.id}"
                  title="${t('editor.showMenu')}">
            <i class="fas fa-ellipsis-v"></i>
          </button>
          ` : ''}
        </span>
      </div>
      ${hasChildren ? `
        <div class="tree-children ${isExpanded ? 'expanded' : ''}" data-parent="${node.id}">
          ${shouldRenderChildren
            ? node.children.map(child => renderTreeNode(child, level + 1, visitedNodes, `${currentPath}-${child.id}`, renderState, nextPreloadDepth)).join('')
            : ''}
        </div>
      ` : ''}
    </div>
  `

  visitedNodes.delete(node.id)
  return html
}

function attachTreeEventListeners() {
  // ノード選択
  document.querySelectorAll('.tree-item').forEach(item => {
    if (item.dataset.clickBound === '1') return
    item.dataset.clickBound = '1'
    item.addEventListener('click', async (e) => {
      if (e.target.classList.contains('toggle-icon') ||
        e.target.classList.contains('toggle-btn') ||
        e.target.closest('.toggle-btn') ||
        e.target.classList.contains('add-child-btn') ||
        e.target.closest('.add-child-btn')) {
        return
      }

      const nodeId = item.dataset.nodeId
      const nodePath = item.dataset.nodePath

      // 同じノードを選択した場合は何もしない
      if (selectedNodePath === nodePath) {
        return
      }

      const okToProceed = await runWithUnsavedGuard(async () => {})
      if (!okToProceed) return

      // 逆ツリーモードでは、ルートノード（selectedNodeId）を変更しない
      // 選択したノードは詳細表示のためだけに選択状態にする
      if (treeViewMode === 'reverse') {
        const editorLoadRequestId = beginEditorLoad()
        const previousSelectedNodePath = selectedNodePath
        const previousSelectedNodeElement = selectedNodeElement
        // ルートノードを変更せず、選択状態のみ更新
        selectedNodeElement = item
        selectedNodePath = nodePath

        // 選択状態を更新
        document.querySelectorAll('.tree-item.active').forEach(el => el.classList.remove('active'))
        document.querySelectorAll('.tree-item.duplicate-active').forEach(el => el.classList.remove('duplicate-active'))
        item.classList.add('active')

        // エディタにノード情報を表示
        fetchNodeById(nodeId).then(node => {
          if (!node) {
            throw new Error('Failed to fetch node')
          }
          return axios.get(`/api/trees/${currentTreeId}/nodes/${nodeId}/parents`).then(parentsRes => {
            if (!isLatestEditorLoad(editorLoadRequestId)) return
            const parents = parentsRes.data.success ? parentsRes.data.data : []
            renderEditor(node, parents)
            if (!isHistoryNavigating) {
              pushNodeHistory({
                viewMode: 'reverse',
                nodeId,
                nodePath,
                reverseRootNodeId: selectedNodeId
              })
            }
          })
        }).catch(error => {
          if (isLatestEditorLoad(editorLoadRequestId)) {
            restoreTreeSelection(undefined, previousSelectedNodePath, previousSelectedNodeElement, {
              restoreNodeId: false,
              applyDuplicateActive: false
            })
          }
          console.error('Failed to select reverse-tree node:', error)
        }).finally(() => {
          finishEditorLoad(editorLoadRequestId)
        })
      } else {
        // 通常モードでは従来通り
        selectedNodeElement = item
        selectNode(nodeId, nodePath)
      }
    })

    // 右クリックではブラウザ標準メニューを使う（カスタムメニューは出さない）
  })

  // ツリー展開/折りたたみ
  document.querySelectorAll('.toggle-btn').forEach(button => {
    if (button.dataset.toggleBound === '1') return
    button.dataset.toggleBound = '1'
    button.addEventListener('click', (e) => {
      e.stopPropagation()
      const nodeId = button.dataset.nodeId
      const icon = button.querySelector('.toggle-icon')
      if (!icon) return
      toggleNode(nodeId, icon)
    })
  })

  // ノード右端メニュー（縦三点）: クリックでコンテキストメニューを表示
  document.querySelectorAll('.add-child-btn').forEach(btn => {
    if (btn.dataset.menuBound === '1') return
    btn.dataset.menuBound = '1'
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const item = btn.closest('.tree-item')
      if (!item) return
      const nodeId = item.dataset.nodeId
      const nodePath = item.dataset.nodePath
      showContextMenu(e, nodeId, nodePath)
    })
  })

  // 省略行クリック: 対象ノードへ移動
  document.querySelectorAll('.tree-item-omitted').forEach(item => {
    if (item.dataset.omittedBound === '1') return
    item.dataset.omittedBound = '1'
    item.addEventListener('click', async (e) => {
      e.preventDefault()
      e.stopPropagation()
      const nodeId = item.dataset.nodeId
      if (!nodeId) return
      await selectNode(nodeId)
    })
  })
}

function toggleNode(nodeId, clickedElement = null) {
  // クリックされた要素が渡された場合はそれを使用、なければquerySelectorで探す
  let toggleIcon = clickedElement

  if (!toggleIcon) {
    // フォールバック: IDで最初に見つかった要素を使用
    toggleIcon = document.querySelector(`.toggle-icon[data-node-id="${nodeId}"]`)
  }

  if (!toggleIcon) return

  const treeItem = toggleIcon.closest('.tree-item')
  if (!treeItem) return
  const nodePath = treeItem.dataset.nodePath
  if (!nodePath) return

  const wrapper = treeItem.closest('[data-node-group]')
  if (!wrapper) return

  // tree-childrenはwrapperの直接の子要素
  const childrenContainer = wrapper.querySelector(':scope > .tree-children')
  if (!childrenContainer) return

  // 展開/折りたたみの切り替え
  if (expandedNodePaths.has(nodePath)) {
    // 折りたたみ
    expandedNodePaths.delete(nodePath)
    childrenContainer.classList.remove('expanded')
    toggleIcon.classList.remove('caret-expanded')
  } else {
    // 展開
    expandedNodePaths.add(nodePath)
    childrenContainer.classList.add('expanded')
    toggleIcon.classList.add('caret-expanded')
    const targetNode = findRenderedTreeNodeByPath(nodePath)
    if (!targetNode) {
      // パス解決に失敗した場合は安全側で全体再描画にフォールバック
      renderTree()
      return
    }
    if (Array.isArray(targetNode.children) && targetNode.children.length > 0) {
      const pathDepth = String(nodePath).split('-').length - 1
      const visited = buildVisitedSetFromPath(nodePath)
      const childHtml = targetNode.children.map(child =>
        renderTreeNode(child, pathDepth + 1, visited, `${nodePath}-${child.id}`, null, 1)
      ).join('')
      childrenContainer.innerHTML = childHtml
      attachTreeEventListeners()
    } else {
      childrenContainer.innerHTML = ''
    }
  }

  // 折りたたみはDOM操作のみ、展開時のみrenderTree()で必要な子孫を生成する
}

// ===============================
// ユーティリティ（DOM操作関連）
// ===============================
function getNodePath(element) {
  const path = []
  if (!element) return path

  // 自分自身のID
  if (element.dataset && element.dataset.nodeId) {
    path.unshift(element.dataset.nodeId)
  }

  // 親を遡ってパスを構築
  let current = element.parentElement
  while (current && current.id !== 'tree-container') {
    // tree-childrenのdata-parent属性を使用
    if (current.classList.contains('tree-children') && current.dataset.parent) {
      path.unshift(current.dataset.parent)
    }
    current = current.parentElement
  }
  return path
}

function isTreeItemVisible(el) {
  return !el.closest('.tree-children:not(.expanded)')
}

// 選択状態を復元する関数
function restoreSelection() {
  if (!selectedNodePath && !selectedNodeId) return

  // 逆ツリーモードでは、ルートノード（selectedNodeId）を絶対に変更せず維持し、
  // selectedNodePathで指定されたノードを選択状態にする
  if (treeViewMode === 'reverse') {
    // 逆ツリーモードでは、selectedNodeIdはルートノードのIDであり、絶対に変更してはいけない
    const rootNodeId = selectedNodeId // ルートノードのIDを保存（変更を防ぐため）

    // ルートノードを選択状態にする（selectedNodePathが指定されていない場合）
    if (!selectedNodePath && rootNodeId) {
      const rootItem = document.querySelector(`.tree-item[data-node-id="${rootNodeId}"][data-node-path="${rootNodeId}"]`)
      if (rootItem) {
        selectedNodeElement = rootItem
        selectedNodePath = String(rootNodeId)
        selectedNodeId = rootNodeId // 念のため再設定
        rootItem.classList.add('active')

        loadEditorForNode(rootNodeId)
        return
      }
    }

    // selectedNodePathが指定されている場合、そのノードを選択
    if (selectedNodePath) {
      const item = document.querySelector(`.tree-item[data-node-path="${selectedNodePath}"]`)
      if (item) {
        selectedNodeElement = item
        selectedNodeId = rootNodeId // ルートノードのIDを必ず維持
        item.classList.add('active')

        // エディタに表示（パスの最後のノードIDを使用）
        const nodeIdFromPath = selectedNodePath.split('-').pop()
        loadEditorForNode(nodeIdFromPath)
        return
      }
    }

    // 見つからない場合は、ルートノードを選択
    if (rootNodeId) {
      const rootItem = document.querySelector(`.tree-item[data-node-id="${rootNodeId}"]`)
      if (rootItem) {
        selectedNodeElement = rootItem
        selectedNodePath = rootItem.dataset.nodePath
        selectedNodeId = rootNodeId // ルートノードのIDを必ず維持
        rootItem.classList.add('active')

        loadEditorForNode(rootNodeId)
      }
    }
    return
  }

  // 通常モードの処理
  let item = null

  // まずパスで検索
  if (selectedNodePath) {
    item = document.querySelector(`.tree-item[data-node-path="${selectedNodePath}"]`)
  }

  // パスで見つからない場合、IDで検索
  if (!item && selectedNodeId) {
    // 同じIDのノードが複数ある場合、selectedNodePathに最も近いものを選ぶ
    // または最初に見つかったものを選ぶ
    const allItems = document.querySelectorAll(`.tree-item[data-node-id="${selectedNodeId}"]`)
    if (allItems.length > 0) {
      // パスが指定されていて、そのパスに近いものを優先
      if (selectedNodePath) {
        // パスのプレフィックスが一致するものを探す
        for (let i = 0; i < allItems.length; i++) {
          const itemPath = allItems[i].dataset.nodePath
          if (itemPath && itemPath.startsWith(selectedNodePath.split('-')[0])) {
            item = allItems[i]
            selectedNodePath = itemPath
            break
          }
        }
      }
      // 見つからなければ見えているもの、それも無ければ最初のものを選ぶ
      // （閉じた親の中の先読み要素を選ぶと、ツリー上で見えない選択になる）
      if (!item) {
        item = Array.from(allItems).find(isTreeItemVisible) || allItems[0]
        selectedNodePath = item.dataset.nodePath
      }
    }
  }

  if (item) {
    selectedNodeElement = item
    item.classList.add('active')

    // 同一ノードのハイライト（選択中のノード以外で同じIDを持つもの）
    if (selectedNodeId) {
      document.querySelectorAll(`.tree-item[data-node-id="${selectedNodeId}"]`).forEach(el => {
        if (el !== item && el.dataset.nodePath !== selectedNodePath) {
          el.classList.add('duplicate-active')
        }
      })
    }
  }
}

function restoreTreeSelection(nodeId, nodePath, element, options = {}) {
  const {
    restoreNodeId = nodeId !== undefined,
    applyDuplicateActive = treeViewMode === 'normal'
  } = options

  if (restoreNodeId) {
    selectedNodeId = nodeId ?? null
  }
  selectedNodePath = nodePath ?? null

  let restoredElement = null
  if (element?.isConnected && (!nodePath || element.dataset.nodePath === nodePath)) {
    restoredElement = element
  }

  if (!restoredElement) {
    const items = Array.from(document.querySelectorAll('.tree-item'))
    if (nodePath) {
      restoredElement = items.find(item => item.dataset.nodePath === nodePath) || null
    }
    if (!restoredElement && nodeId !== undefined && nodeId !== null) {
      restoredElement = items.find(item => item.dataset.nodeId === String(nodeId)) || null
    }
  }

  selectedNodeElement = restoredElement
  document.querySelectorAll('.tree-item.active').forEach(item => item.classList.remove('active'))
  document.querySelectorAll('.tree-item.duplicate-active').forEach(item => item.classList.remove('duplicate-active'))

  if (restoredElement) {
    restoredElement.classList.add('active')
  }

  if (applyDuplicateActive && selectedNodeId !== null && selectedNodeId !== undefined) {
    document.querySelectorAll(`.tree-item[data-node-id="${selectedNodeId}"]`).forEach(item => {
      if (item !== restoredElement && item.dataset.nodePath !== selectedNodePath) {
        item.classList.add('duplicate-active')
      }
    })
  }
}

async function selectNode(nodeId, nodePath = null, options = {}) {
  const { recordHistory = true } = options
  const editorLoadRequestId = beginEditorLoad()
  const pickBestTreeItem = (targetNodeId, preferredPath = null) => {
    const items = Array.from(document.querySelectorAll(`.tree-item[data-node-id="${targetNodeId}"]`))
    if (items.length === 0) return null

    const isVisibleItem = isTreeItemVisible
    const rootPathPrefix = currentRootNodeId
      ? `${currentRootNodeId}-`
      : null
    const withPath = (path) => items.find((el) => el.dataset.nodePath === path) || null

    if (preferredPath) {
      const exactPreferred = withPath(preferredPath)
      if (exactPreferred) return exactPreferred
    }
    if (selectedNodePath) {
      const exactCurrent = withPath(selectedNodePath)
      if (exactCurrent) return exactCurrent
    }

    const visibleItems = items.filter(isVisibleItem)
    if (treeViewMode === 'normal' && rootPathPrefix) {
      const rootVisible = visibleItems.find((el) => (el.dataset.nodePath || '').startsWith(rootPathPrefix))
      if (rootVisible) return rootVisible
      const rootAny = items.find((el) => (el.dataset.nodePath || '').startsWith(rootPathPrefix))
      if (rootAny) return rootAny
    }

    return visibleItems[0] || items[0]
  }

  const previousSelectedNodeId = selectedNodeId
  const previousSelectedNodePath = selectedNodePath
  const previousSelectedNodeElement = selectedNodeElement
  selectedNodeId = nodeId
  if (!pendingSearchHighlight || pendingSearchHighlight.nodeId !== nodeId) {
    clearSearchHighlight()
  }
  if (treeViewMode === 'normal' && previousSelectedNodeId !== nodeId) {
    reverseInitialExpandedForNodeId = null
  }

  if (treeViewMode === 'normal') {
    const targetElement = pickBestTreeItem(nodeId, nodePath)
    const targetVisible = !!(targetElement && !targetElement.closest('.tree-children:not(.expanded)'))
    if (!targetVisible) {
      expandParents(nodeId)
      renderTree()
    }
  }

  let targetElement = pickBestTreeItem(nodeId, nodePath)
  if (!targetElement && treeViewMode === 'normal') {
    expandParents(nodeId)
    renderTree()
    targetElement = pickBestTreeItem(nodeId, nodePath)
  }

  if (targetElement) {
    selectedNodePath = targetElement.dataset.nodePath || null
    selectedNodeElement = targetElement
  } else if (nodePath) {
    selectedNodePath = nodePath
    selectedNodeElement = null
  } else {
    selectedNodePath = null
    selectedNodeElement = null
  }

  // 再描画せずDOM上の選択状態のみ更新
  // (通常モード: カーソル飛び防止, 逆ツリーモード: ルート維持のため)
  document.querySelectorAll('.tree-item.active').forEach(item => item.classList.remove('active'))
  document.querySelectorAll('.tree-item.duplicate-active').forEach(item => item.classList.remove('duplicate-active'))

  const activeElement = pickBestTreeItem(nodeId, selectedNodePath || nodePath)
  if (activeElement) {
    activeElement.classList.add('active')
    selectedNodeElement = activeElement
    selectedNodePath = activeElement.dataset.nodePath || selectedNodePath || nodePath || null
    activeElement.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  // 同一ノードのハイライト（選択中のノード以外で同じIDを持つもの）
  if (selectedNodeId) {
    document.querySelectorAll(`.tree-item[data-node-id="${selectedNodeId}"]`).forEach(item => {
      if (item !== selectedNodeElement && item.dataset.nodePath !== selectedNodePath) {
        item.classList.add('duplicate-active')
      }
    })
  }

  try {
    const node = await fetchNodeById(nodeId)
    if (node) {
      // 親ノードを取得
      const parentsRes = await axios.get(`/api/trees/${currentTreeId}/nodes/${nodeId}/parents`)
      if (!isLatestEditorLoad(editorLoadRequestId)) return null // 後続の操作に追い越された（未検出ではない）

      const parents = parentsRes.data.success ? parentsRes.data.data : []
      renderEditor(node, parents)
      if (recordHistory && !isHistoryNavigating) {
        pushNodeHistory({
          viewMode: treeViewMode,
          nodeId,
          nodePath: selectedNodePath || nodePath || String(nodeId),
          reverseRootNodeId: treeViewMode === 'reverse' ? selectedNodeId : null
        })
      }
      return true
    }
    if (isLatestEditorLoad(editorLoadRequestId)) {
      restoreTreeSelection(previousSelectedNodeId, previousSelectedNodePath, previousSelectedNodeElement)
    }
    return false
  } catch (error) {
    if (isLatestEditorLoad(editorLoadRequestId)) {
      restoreTreeSelection(previousSelectedNodeId, previousSelectedNodePath, previousSelectedNodeElement)
    }
    console.error('Failed to select node:', error)
    return false
  } finally {
    finishEditorLoad(editorLoadRequestId)
  }
}

function canOperateNodeImages() {
  return canEdit() && treeViewMode !== 'trash'
}

function insertMarkdownToEditor(markdown, cursorPos = null) {
  if (!window.currentEditor?.codemirror) return
  window.currentEditor.codemirror.focus()
  if (typeof window.currentEditor.insertText === 'function') {
    window.currentEditor.insertText(markdown, cursorPos)
    return
  }
  window.currentEditor.codemirror.getDoc().replaceSelection(markdown)
}

function isSupportedMarkdownLinkUrl(text) {
  if (!text || /\s/.test(text)) return false

  try {
    const url = new URL(text)
    return ['http:', 'https:'].includes(url.protocol)
  } catch (_error) {
    return false
  }
}

function escapeMarkdownLinkLabel(label) {
  return String(label || '').replace(/\\/g, '\\\\').replace(/\]/g, '\\]')
}

function buildMarkdownLink(label, url) {
  const safeLabel = escapeMarkdownLinkLabel(label || url)
  return `[${safeLabel}](${url})`
}

const CLIPBOARD_HTML_BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'div', 'figcaption', 'figure',
  'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main',
  'nav', 'p', 'pre', 'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'tr', 'ul', 'ol'
])

function normalizePastedHtmlMarkdown(markdown) {
  return String(markdown || '')
    .replace(/\xA0/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function convertClipboardHtmlNodeToMarkdown(node, state) {
  if (!node) return ''
  if (node.nodeType === 3) return node.nodeValue || ''
  if (node.nodeType !== 1) return ''

  const tagName = node.tagName?.toLowerCase()
  if (tagName === 'br') return '\n'
  if (tagName === 'hr') return '\n'
  if (tagName === 'a') {
    const href = node.getAttribute('href')?.trim() || ''
    if (isSupportedMarkdownLinkUrl(href)) {
      state.hasLink = true
      const label = node.textContent?.trim() || href
      return buildMarkdownLink(label, href)
    }
  }

  return Array.from(node.childNodes || [])
    .map(child => convertClipboardHtmlNodeToMarkdown(child, state))
    .join('') + (CLIPBOARD_HTML_BLOCK_TAGS.has(tagName) ? '\n' : '')
}

function getMarkdownFromClipboardHtml(html) {
  if (!html) return ''
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const state = { hasLink: false }
  const markdown = Array.from(doc.body?.childNodes || [])
    .map(node => convertClipboardHtmlNodeToMarkdown(node, state))
    .join('')
  if (!state.hasLink) return ''
  return normalizePastedHtmlMarkdown(markdown)
}

function getMarkdownLinkFromClipboardData(clipboardData) {
  if (!clipboardData) return ''

  const htmlMarkdown = getMarkdownFromClipboardHtml(clipboardData.getData('text/html'))
  if (htmlMarkdown) return htmlMarkdown

  return ''
}

function renderNodeImageIcons(nodeId) {
  const listEl = document.getElementById('node-image-list')
  const listWrapEl = document.getElementById('node-image-list-wrap')
  if (!listEl) return
  ensureNodeImageUiStyles()
  initializeNodeImageMenuEvents()
  closeNodeImageMenu()

  if (!Array.isArray(nodeImages) || nodeImages.length === 0) {
    listEl.innerHTML = ''
    if (listWrapEl) listWrapEl.style.display = 'none'
    return
  }

  if (listWrapEl) listWrapEl.style.display = 'flex'

  listEl.innerHTML = nodeImages.map(image => `
    <div
      class="node-image-icon-item ${canOperateNodeImages() ? 'is-draggable' : ''}"
      draggable="${canOperateNodeImages() ? 'true' : 'false'}"
      data-image-id="${image.id}"
      role="button"
      tabindex="0"
      title="${t('editor.imageMenuShow')}"
      aria-label="${t('editor.imageMenuShow')}"
      aria-haspopup="menu"
      aria-expanded="false"
    >
      <i class="fas fa-image"></i>
      <div class="node-image-menu" role="menu" aria-label="${t('editor.imageMenuLabel')}">
        <button type="button" class="node-image-menu-action" data-action="open" data-image-id="${image.id}" role="menuitem">
          <i class="fas fa-external-link-alt"></i>
          <span>${t('editor.openInNewTab')}</span>
        </button>
        <button
          type="button"
          class="node-image-menu-action is-danger ${canOperateNodeImages() ? '' : 'is-disabled'}"
          data-action="delete"
          data-image-id="${image.id}"
          role="menuitem"
          ${canOperateNodeImages() ? '' : 'aria-disabled="true"'}
        >
          <i class="fas fa-trash"></i>
          <span>${t('common.delete')}</span>
        </button>
        <div class="node-image-menu-readonly">
          <span class="node-image-menu-label">${t('editor.fileName')}</span>
          <span class="node-image-menu-file-name">${escapeHtml(image.file_name || 'image')}</span>
        </div>
        <div class="node-image-menu-preview-wrap">
          <span class="node-image-menu-label">${t('editor.imageThumbnail')}</span>
          <div class="node-image-menu-preview-frame" data-image-id="${image.id}">
            <img class="node-image-menu-preview" data-image-id="${image.id}" src="${escapeHtml(image.url || '')}" alt="${escapeHtml(image.file_name || 'image')}" loading="lazy">
            <div class="node-image-menu-preview-fallback">${t('editor.imageThumbnailLoadFailed')}</div>
          </div>
        </div>
      </div>
    </div>
  `).join('')

  listEl.querySelectorAll('.node-image-icon-item').forEach(icon => {
    icon.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const imageId = parseInt(icon.dataset.imageId)
      if (!imageId) return
      toggleNodeImageMenu(imageId)
    })

    icon.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      const imageId = parseInt(icon.dataset.imageId)
      if (!imageId) return
      toggleNodeImageMenu(imageId)
    })

    if (!canOperateNodeImages()) return
    icon.addEventListener('dragstart', (event) => {
      const imageId = parseInt(icon.dataset.imageId)
      const image = nodeImages.find(img => img.id === imageId)
      if (!image) return
      event.dataTransfer?.setData('application/x-zeeta-markdown', image.markdown)
      event.dataTransfer.effectAllowed = 'copy'
    })
  })

  listEl.querySelectorAll('.node-image-menu').forEach(menu => {
    menu.addEventListener('click', (event) => {
      event.stopPropagation()
    })
  })

  listEl.querySelectorAll('.node-image-menu-action[data-action="open"]').forEach(btn => {
    btn.addEventListener('click', async (event) => {
      event.preventDefault()
      event.stopPropagation()
      const imageId = parseInt(btn.dataset.imageId)
      const image = nodeImages.find(img => img.id === imageId)
      if (!image?.url) return
      openImageInViewer({ url: image.url, alt: image.file_name })
      closeNodeImageMenu()
    })
  })

  listEl.querySelectorAll('.node-image-menu-action[data-action="delete"]').forEach(btn => {
    btn.addEventListener('click', async (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (btn.classList.contains('is-disabled')) return
      const imageId = parseInt(btn.dataset.imageId)
      await handleNodeImageDelete(nodeId, imageId)
    })
  })

  listEl.querySelectorAll('.node-image-menu-preview').forEach(img => {
    img.addEventListener('error', () => {
      const imageId = parseInt(img.dataset.imageId)
      if (!imageId) return
      setNodeImagePreviewFallback(imageId)
    }, { once: true })
  })
}

function setupNodeImageDropHandlers(nodeId) {
  if (!window.currentEditor?.codemirror) return
  const wrapper = window.currentEditor.codemirror.getWrapperElement()
  if (!wrapper) return

  const getDropPosition = (event) => {
    if (typeof window.currentEditor?.getDropPosition !== 'function') return null
    return window.currentEditor.getDropPosition(event.clientX, event.clientY)
  }
  const clearDropState = () => {
    wrapper.classList.remove('node-image-drop-active', 'node-image-drop-disabled')
  }
  const isSupportedTransfer = (dataTransfer) => {
    const hasFiles = !!(dataTransfer?.files && dataTransfer.files.length > 0)
    const hasMarkdown = !!dataTransfer?.getData('application/x-zeeta-markdown')
    return hasFiles || hasMarkdown
  }
  const isEditorWritable = () => {
    if (!window.currentEditor) return false
    if (typeof window.currentEditor.canEdit === 'function') return window.currentEditor.canEdit()
    return !(typeof window.currentEditor.isPreviewActive === 'function' && window.currentEditor.isPreviewActive())
  }
  const showPreviewOnlyToast = () => {
    showToast(t('editor.imageInsertPreviewDenied'), 'info')
  }
  const getClipboardImageFiles = (clipboardData) => {
    const itemFiles = Array.from(clipboardData?.items || [])
      .filter(item => item.kind === 'file' && item.type && item.type.startsWith('image/'))
      .map(item => item.getAsFile())
      .filter(Boolean)
    if (itemFiles.length > 0) return itemFiles
    return Array.from(clipboardData?.files || []).filter(file => file.type && file.type.startsWith('image/'))
  }
  const getSpreadsheetPlainText = (clipboardData) => {
    const hasPlainText = Array.from(clipboardData?.types || []).includes('text/plain')
    const plainText = clipboardData?.getData('text/plain') || ''
    const html = clipboardData?.getData('text/html') || ''
    if (!hasPlainText || !/<table(?:\s|>)/i.test(html)) return null
    return plainText
  }

  const uploadImagesAndInsertMarkdown = async (files, firstCursorPos = null) => {
    if (!canOperateNodeImages()) {
      showToast(t('editor.imageOperationUnavailable'), 'error')
      return
    }

    const onlyImageFiles = Array.from(files || []).filter(file => file.type && file.type.startsWith('image/'))
    if (onlyImageFiles.length === 0) return

    showLoading()
    try {
      let inserted = 0
      for (const file of onlyImageFiles) {
        const uploaded = await uploadNodeImage(nodeId, file)
        if (!uploaded?.markdown) continue
        insertMarkdownToEditor((inserted > 0 ? '\n' : '') + uploaded.markdown, inserted === 0 ? firstCursorPos : null)
        inserted += 1
      }

      nodeImages = await fetchNodeImages(nodeId)
      renderNodeImageIcons(nodeId)
    } finally {
      hideLoading()
    }
  }

  wrapper.addEventListener('dragover', (event) => {
    if (!isSupportedTransfer(event.dataTransfer)) return
    clearDropState()
    if (!isEditorWritable()) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'none'
      wrapper.classList.add('node-image-drop-disabled')
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    wrapper.classList.add('node-image-drop-active')
  })

  wrapper.addEventListener('dragleave', (event) => {
    if (wrapper.contains(event.relatedTarget)) return
    clearDropState()
  })

  wrapper.addEventListener('drop', async (event) => {
    clearDropState()
    if (!isSupportedTransfer(event.dataTransfer)) return
    if (!isEditorWritable()) {
      showPreviewOnlyToast()
      return
    }

    const dropPos = getDropPosition(event)

    const files = event.dataTransfer?.files
    if (files && files.length > 0) {
      event.preventDefault()
      const onlyImageFiles = Array.from(files).filter(file => file.type && file.type.startsWith('image/'))
      if (onlyImageFiles.length === 0) {
        showToast(t('editor.imageFilesOnly'), 'error')
        return
      }
      await uploadImagesAndInsertMarkdown(onlyImageFiles, dropPos)
      return
    }

    const markdown = event.dataTransfer?.getData('application/x-zeeta-markdown')
    if (markdown) {
      event.preventDefault()
      insertMarkdownToEditor(markdown, dropPos)
    }
  })

  wrapper.addEventListener('paste', async (event) => {
    const spreadsheetText = getSpreadsheetPlainText(event?.clipboardData)
    const hasSpreadsheetText = spreadsheetText !== null
    const files = getClipboardImageFiles(event?.clipboardData)
    const markdownLink = !hasSpreadsheetText && files.length === 0
      ? getMarkdownLinkFromClipboardData(event?.clipboardData)
      : ''
    if (!isEditorWritable()) {
      if (hasSpreadsheetText || files.length > 0 || markdownLink) {
        event.preventDefault()
        showPreviewOnlyToast()
      }
      return
    }

    const cursorPos = typeof window.currentEditor?.getCursorPosition === 'function'
      ? window.currentEditor.getCursorPosition()
      : null

    if (hasSpreadsheetText) {
      event.preventDefault()
      insertMarkdownToEditor(spreadsheetText, cursorPos)
      return
    }

    if (files.length === 0) {
      if (!markdownLink) return
      event.preventDefault()
      insertMarkdownToEditor(markdownLink, cursorPos)
      return
    }

    event.preventDefault()
    await uploadImagesAndInsertMarkdown(files, cursorPos)
  }, true)
}

// ===============================
// エディタ表示
// ===============================
function renderEditor(node = null, parents = []) {
  const editorPanel = document.getElementById('editor-panel')

  if (!node) {
    if (window.currentEditor) {
      cleanupEditorLayoutHooks()
      syncSplitHandleVisibility()
      window.currentEditor.toTextArea()
      window.currentEditor = null
    }
    editorPanel.innerHTML = `
      <div class="text-center text-gray-400 py-12">
        <i class="fas fa-arrow-left text-4xl mb-4"></i>
        <p>${t('editor.selectNodePrompt')}</p>
        <p class="text-sm mt-2">${t('editor.copyPasteShortcutHelp')}</p>
      </div>
    `
    selectedNodeVersion = null
    currentEditorNodeId = null
    initialNodeValues = null
    isDirty = false
    nodeImages = []
    closeNodeImageMenu()
    return
  }

  suppressDirtyCheck()
  try {
    currentEditorNodeId = node.id
    isDirty = false
    nodeImages = []
    closeNodeImageMenu()

    // Store current node version for optimistic locking
    selectedNodeVersion = node.version || 1

    // 検索ポップアップと同じ分類（ゴミ箱専用親にはバッジを表示する）
    const editorTrashReachableNodeIds = getTrashReachableNodeIdSet()
    const editorSharedTrashNodeIds = getSharedTrashNodeIdSet(editorTrashReachableNodeIds)
    const parentsWithMeta = parents.map(p => {
      const isInTrashSubtree = editorTrashReachableNodeIds.has(p.id) && p.id !== currentTrashRootNodeId
      const isTrashOnlyParent = isInTrashSubtree && !editorSharedTrashNodeIds.has(p.id)
      return {
        ...p,
        isRootParent: p.id === currentRootNodeId,
        displayTitle: p.id === currentRootNodeId ? 'root' : p.title,
        relationTypeId: Number(p.relation_type_id) || 1,
        isTrashOnlyParent
      }
    })
    const canRemoveParentRelation = (parent) => {
    // 唯一の親は解除不可（ノードは常に1つ以上の親を持つ。MCP unlink_node と同挙動）。
    // 親が2件以上あるときだけ解除可能。
    return parentsWithMeta.length > 1
    }

  const parentsHtml = parentsWithMeta.length > 0 ? `
    <div class="parents-chip-wrap" style="position: relative; min-width: 0; margin-top: 8px;">
      <button type="button"
              class="parents-chip-toggle bg-white border border-gray-300 text-gray-600"
              onclick="toggleParentsAccordion('${node.id}')"
              style="
                display: inline-flex;
                align-items: center;
                gap: 6px;
                padding: 5px 10px;
                border-radius: 9999px;
                font-size: 13px;
                font-weight: 500;
                cursor: pointer;
                line-height: 1.1;
              ">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><circle cx="5" cy="2.5" r="1.2"></circle><circle cx="2" cy="7.4" r="1.2"></circle><circle cx="8" cy="7.4" r="1.2"></circle><path d="M5 3.7 3 6M5 3.7 7 6" stroke-linecap="round"></path></svg>
        <span>${t('editor.parentNodes')}</span>
        <span class="text-gray-500" style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace;">${parentsWithMeta.length}</span>
        <i id="parents-accordion-icon-${node.id}" class="fas fa-chevron-down text-xs transition-transform text-gray-400"></i>
      </button>
      <div id="parents-accordion-content-${node.id}" class="space-y-1" style="display: none; margin-top: 8px;">
        ${parentsWithMeta.map(p => `
          <div class="flex items-center justify-between text-sm bg-white px-2 py-1 rounded">
            ${p.isRootParent
              ? `<span class="text-gray-700" title="${t('editor.rootNode')}">${escapeHtml(p.displayTitle)}</span>`
              : `<span class="text-gray-700 parent-name-link cursor-pointer hover:underline" data-parent-id="${p.id}" title="${t('editor.clickToDisplayNode')}">${escapeHtml(p.displayTitle)}</span>`
            }
            <div class="flex items-center gap-2">
              ${p.isTrashOnlyParent
                ? `<span class="parent-item-badge-trash text-red-900 bg-red-100 border border-red-200" style="flex: 0 0 auto; font-size: 11px; font-weight: 700; border-radius: 9999px; padding: 2px 8px; line-height: 1.2;">🗑 ${t('editor.trash')}</span>`
                : ''
              }
              ${(!p.isRootParent && !relationTypesLoadFailed && relationTypes.length > 0)
                ? `<select class="relation-type-select border border-gray-300 rounded px-2 py-1 text-xs bg-white"
                         data-parent-id="${p.id}"
                         data-child-id="${node.id}"
                         data-prev-value="${p.relationTypeId}"
                         ${canEdit() ? '' : 'disabled'}>
                    ${relationTypes.map(rt => `
                      <option value="${rt.id}" ${Number(rt.id) === p.relationTypeId ? 'selected' : ''}>
                        ${escapeHtml(getRelationTypeLabel(rt))}
                      </option>
                    `).join('')}
                  </select>`
                : ''
              }
              ${canRemoveParentRelation(p)
                ? `<button class="remove-parent-btn text-red-500 hover:text-red-700 text-xs"
                        data-parent-id="${p.id}"
                        data-parent-title="${escapeHtml(p.displayTitle)}"
                        title="${t('editor.removeParentRelationTitle')}">
                    <i class="fas fa-times"></i>
                  </button>`
                : ''
              }
            </div>
          </div>`
        ).join('')}
      </div>
    </div>
  ` : ''

  const authorRawName = (() => {
    const member = treeMembers.find(m => m.user_id === node.author_user_id)
    return member
      ? (member.display_name || member.email)
      : (node.author_display_name || node.author_email || 'Unknown')
  })()

  editorPanel.innerHTML = `
    <div class="flex flex-col h-full mt-0">
      <div class="flex-shrink-0 mb-4">
        <div class="flex items-start gap-3 w-full">
          <div class="header-parents" style="flex:1; min-width:0;">
            ${parentsHtml}
            <input type="hidden" id="node-author" value="${node.author_user_id || ''}">
          </div>
          <div class="ml-auto flex items-center gap-2" style="flex:0 0 auto;">
            <span id="node-id-copy" role="button" tabindex="0" class="text-xs text-gray-500 font-mono shrink-0 cursor-pointer hover:text-indigo-500" title="${t('editor.copyNodeIdTitle', { id: node.id })}" aria-label="${t('editor.copyNodeIdTitle', { id: node.id })}" style="margin-right: 1ch;">id:${node.id}</span>
            <button id="node-detail-btn" type="button" class="w-6 h-6 text-gray-500 rounded hover:bg-gray-50 flex items-center justify-center" title="node detail" aria-label="node detail">
              <i class="fas fa-circle-info text-base" aria-hidden="true"></i>
            </button>
            <button id="delete-node-btn" class="w-9 h-9 text-gray-500 rounded hover:bg-gray-50 flex items-center justify-center" title="${t('editor.trashShortcutTitle')}">
              <i class="fas fa-trash text-base"></i>
            </button>
            <button id="save-node-btn" class="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 flex items-center" title="${t('editor.saveShortcutTitle', { modifier: navigator.platform.includes('Mac') ? 'cmd' : 'ctrl' })}">
              <span class="text-sm">${t('common.save')}</span>
            </button>
          </div>
        </div>
      </div>

      <div id="editor-scroll-area" class="editor-scroll-area flex-1 overflow-y-auto space-y-4">

        <div>
          <div class="flex items-center justify-between mb-2 gap-3">
            <div class="flex items-center gap-2 flex-1 min-w-0">
              <label class="block text-xs font-medium text-gray-500 tracking-widest uppercase">
                TITLE
              </label>
            </div>
            <div class="flex items-center gap-2 ml-auto">
              <button
                id="copy-title-btn"
                type="button"
                class="w-7 h-7 text-sm border border-gray-200 text-gray-600 rounded hover:bg-gray-50 flex items-center justify-center"
                title="${t('editor.copyTitleWithId', { id: node.id })}"
                aria-label="${t('editor.copyTitleWithId', { id: node.id })}"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <rect x="5" y="5" width="8" height="9" rx="1.5"></rect>
                  <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2H3.5A1.5 1.5 0 0 0 2 3.5v7A1.5 1.5 0 0 0 3.5 12H5"></path>
                </svg>
              </button>
              <button
                id="share-node-btn"
                type="button"
                class="w-7 h-7 text-sm border border-gray-200 text-gray-600 rounded hover:bg-gray-50 flex items-center justify-center"
                title="${t('editor.copyShareUrl')}"
                aria-label="${t('editor.copyShareUrl')}"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <circle cx="4" cy="8" r="1.75"></circle>
                  <circle cx="12" cy="4" r="1.75"></circle>
                  <circle cx="12" cy="12" r="1.75"></circle>
                  <path d="M5.55 7.15 10.4 4.85M5.55 8.85l4.85 2.3"></path>
                </svg>
              </button>
            </div>
          </div>
          <input type="text" id="node-title"
                 value="${escapeHtml(node.title)}"
                 class="w-full px-4 py-2 text-sm font-medium border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                 placeholder="${t('editor.sortTitle')}">
        </div>

        <div id="content-editor-section" class="editor-content-section">
          <div id="content-editor-header" class="editor-content-header flex items-center justify-between mb-2 gap-3">
            <div class="flex items-center gap-2 flex-1 min-w-0">
              <label class="block text-xs font-medium text-gray-500 tracking-widest uppercase">
                CONTENT
              </label>
            </div>
            <div class="flex items-center gap-2 ml-auto">
              <div class="content-search-group">
                <input
                  type="text"
                  id="content-search-input"
                  class="content-search-input"
                  placeholder="${t('editor.searchContent')}"
                  aria-label="${t('editor.searchContent')}"
                >
                <button
                  id="content-search-btn"
                  type="button"
                  class="content-search-submit-btn"
                  title="${t('editor.searchContent')}"
                  aria-label="${t('editor.searchContent')}"
                >
                  <i class="fas fa-search"></i>
                </button>
                <span class="content-search-hit-nav" id="content-search-hit-nav" aria-hidden="true" style="display:none;">
                  <button type="button" class="content-search-hit-btn" id="content-search-prev-btn" data-hit-dir="prev" title="${t('editor.previousHit')}" aria-label="${t('editor.previousHit')}">&lsaquo;</button>
                  <span class="content-search-hit-count" id="content-search-hit-count">-/-</span>
                  <button type="button" class="content-search-hit-btn" id="content-search-next-btn" data-hit-dir="next" title="${t('editor.nextHit')}" aria-label="${t('editor.nextHit')}">&rsaquo;</button>
                </span>
              </div>
              <button
                id="copy-content-btn"
                type="button"
                class="w-7 h-7 text-sm border border-gray-200 text-gray-600 rounded hover:bg-gray-50 flex items-center justify-center"
                title="${t('editor.copyContent')}"
                aria-label="${t('editor.copyContent')}"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <rect x="5" y="5" width="8" height="9" rx="1.5"></rect>
                  <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2H3.5A1.5 1.5 0 0 0 2 3.5v7A1.5 1.5 0 0 0 3.5 12H5"></path>
                </svg>
              </button>
              <button
                id="reload-node-btn"
                type="button"
                class="w-7 h-7 text-sm border border-gray-200 text-gray-600 rounded hover:bg-gray-50 flex items-center justify-center"
                title="${t('editor.reloadCurrentNode')}"
                aria-label="${t('editor.reloadCurrentNode')}"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M13 3v3H10"></path>
                  <path d="M3 13v-3h3"></path>
                  <path d="M12.4 6A5 5 0 0 0 4 4.4"></path>
                  <path d="M3.6 10A5 5 0 0 0 12 11.6"></path>
                </svg>
              </button>
              <button
                id="download-pdf-btn"
                type="button"
                class="w-7 h-7 text-sm border border-gray-200 text-gray-600 rounded hover:bg-gray-50 flex items-center justify-center"
                title="${t('editor.print')}"
                aria-label="${t('editor.print')}"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M4.5 6V2.5h7V6"></path>
                  <rect x="3" y="6" width="10" height="5.5" rx="1.5"></rect>
                  <path d="M5 10.5h6V14H5z"></path>
                </svg>
              </button>
            </div>
          </div>
          <div id="node-image-list-wrap" class="flex justify-end mb-2" style="display:none;">
            <div id="node-image-list" class="node-image-list"></div>
          </div>
          <div class="editor-content-body">
            <div id="node-content-editor"></div>
          </div>
        </div>

        <!-- 下端スペーサー: title ブロックが隠れる分のスクロール余白を担保する。
             高さは syncContentEditorHeight() がスクロール量に連動して制御する -->
        <div id="editor-scroll-spacer" aria-hidden="true"></div>
      </div>
      </div>
    </div>
  `

  // イベントリスナーを設定
  document.getElementById('save-node-btn').addEventListener('click', async () => {
    const saved = await saveCurrentNode()
    if (saved && selectedNodeId) {
      // 保存成功後、現在のノードを再読み込み（新しいバージョンを取得）
      await selectNode(selectedNodeId)
    }
  })
  document.getElementById('delete-node-btn').addEventListener('click', () => deleteCurrentNode())
  document.getElementById('node-detail-btn').addEventListener('click', () => openNodeDetailDialog(node, authorRawName))
  const nodeIdCopy = document.getElementById('node-id-copy')
  const copyNodeId = async () => {
    if (!navigator.clipboard?.writeText) {
      showToast(t('editor.clipboardUnavailable'), 'error')
      return
    }
    try {
      await navigator.clipboard.writeText(`id:${node.id}`)
      showToast(t('editor.nodeIdCopied'))
    } catch (error) {
      console.error('Failed to copy node id:', error)
      showToast(t('editor.copyFailed'), 'error')
    }
  }
  nodeIdCopy.addEventListener('click', copyNodeId)
  nodeIdCopy.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    copyNodeId()
  })
  document.getElementById('copy-title-btn').addEventListener('click', async () => {
    const currentDisplayNodeId = getCurrentDisplayNodeId()
    const targetNodeId = currentDisplayNodeId || node.id
    if (!navigator.clipboard?.writeText) {
      showToast(t('editor.clipboardUnavailable'), 'error')
      return
    }
    try {
      await navigator.clipboard.writeText(buildNodePlainText(targetNodeId))
      showToast(t('editor.titleCopied'))
    } catch (error) {
      console.error('Failed to copy node title:', error)
      showToast(t('editor.copyFailed'), 'error')
    }
  })
  document.getElementById('copy-content-btn').addEventListener('click', async () => {
    const content = window.currentEditor ? window.currentEditor.value() : (node.content || '')
    if (!content) {
      showToast(t('editor.contentEmpty'), 'error')
      return
    }
    try {
      await navigator.clipboard.writeText(content)
      showToast(t('editor.contentCopied'))
    } catch (error) {
      console.error('Failed to copy node content:', error)
      showToast(t('editor.copyFailed'), 'error')
    }
  })
  document.getElementById('share-node-btn').addEventListener('click', async () => {
    const currentDisplayNodeId = getCurrentDisplayNodeId()
    const targetNodeId = currentDisplayNodeId || node.id
    const shareUrl = buildNodeShareUrl(targetNodeId)
    if (!shareUrl) {
      showToast(t('editor.shareUrlCreateFailed'), 'error')
      return
    }
    if (!navigator.clipboard?.writeText) {
      showToast(t('editor.clipboardUnavailable'), 'error')
      return
    }
    try {
      await navigator.clipboard.writeText(shareUrl)
      showToast(t('editor.shareUrlCopied'))
    } catch (error) {
      console.error('Failed to copy share URL:', error)
      showToast(t('editor.shareUrlCopyFailed'), 'error')
    }
  })
  document.getElementById('reload-node-btn').addEventListener('click', async () => {
    const proceed = await confirmProceedWithUnsavedChanges()
    if (!proceed) return

    const currentDisplayNodeId = getCurrentDisplayNodeId()
    if (!currentDisplayNodeId) {
      showToast(t('editor.reloadTargetNotFound'), 'error')
      return
    }

    showLoading()
    try {
      const reloaded = await selectNode(currentDisplayNodeId, selectedNodePath, { recordHistory: false })
      if (reloaded) {
        // success: no toast
      } else {
        showToast(t('editor.nodeReloadFailed'), 'error')
      }
    } catch (error) {
      console.error('Failed to reload current node:', error)
      showToast(t('editor.nodeReloadFailed'), 'error')
    } finally {
      hideLoading()
    }
  })
  document.getElementById('download-pdf-btn').addEventListener('click', async () => {
    const selectedOrientation = await showPrintOrientationDialog(getSavedPrintOrientation())
    if (!selectedOrientation) return
    setSavedPrintOrientation(selectedOrientation)
    openNodePdfPrintWindow(node, selectedOrientation)
  })
  contentSearchMarks = []
  contentSearchHitIndex = 0
  const contentSearchInput = document.getElementById('content-search-input')
  const contentSearchBtn = document.getElementById('content-search-btn')
  if (contentSearchInput && contentSearchBtn) {
    contentSearchBtn.addEventListener('click', () => performContentSearch(contentSearchInput.value))
    contentSearchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        performContentSearch(contentSearchInput.value)
      }
    })
    contentSearchInput.addEventListener('input', () => {
      if (!contentSearchInput.value.trim()) clearContentSearchHighlight()
    })
  }
  const contentSearchPrevBtn = document.getElementById('content-search-prev-btn')
  const contentSearchNextBtn = document.getElementById('content-search-next-btn')
  if (contentSearchPrevBtn) contentSearchPrevBtn.addEventListener('click', () => navigateContentSearchHit(-1))
  if (contentSearchNextBtn) contentSearchNextBtn.addEventListener('click', () => navigateContentSearchHit(1))

  // Keep the compact parent chip trigger while preserving the existing detail panel width
  try {
    const headerParents = editorPanel.querySelector('.header-parents')
    if (headerParents) {
      headerParents.style.display = 'flex'
      headerParents.style.alignItems = 'flex-start'
      headerParents.style.minWidth = '0'

      const accordionContent = headerParents.querySelector(`#parents-accordion-content-${node.id}`)
      if (accordionContent) {
        accordionContent.style.position = 'absolute'
        accordionContent.style.top = '100%'
        accordionContent.style.left = '0'
        accordionContent.style.width = 'min(520px, calc(100vw - 120px))'
        // 背景と枠はダークテーマ上書きが効くようクラスで指定する
        accordionContent.classList.add('bg-white', 'border', 'border-gray-200')
        accordionContent.style.borderRadius = '12px'
        accordionContent.style.boxShadow = '0 12px 32px rgba(15, 23, 42, 0.12)'
        accordionContent.style.padding = '10px'
        accordionContent.style.zIndex = '40'
      }
    }
  } catch (e) {
    console.error('Failed to adjust parents header styles:', e)
  }

  // 変更監視
  document.getElementById('node-title').addEventListener('input', checkDirty)
  document.getElementById('node-author').addEventListener('change', checkDirty)

  // 親削除ボタン
  document.querySelectorAll('.remove-parent-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return
      const parentId = btn.dataset.parentId
      const parentTitle = btn.dataset.parentTitle || t('editor.parentNodeFallback')
      const childTitle = node.title || t('editor.childNodeFallback')
      const message = t('editor.removeParentRelationConfirm', { parent: parentTitle, child: childTitle })
      if (confirm(message)) {
        // 再描画でアコーディオンが閉じてもオーバーレイだけが body に残り、
        // 以降の操作をブロックしてしまうため明示的に閉じる（親リンク遷移と同じ扱い）
        closeParentsAccordion(node.id)
        await removeRelation(parentId, selectedNodeId)
        await selectNode(selectedNodeId) // リロード
      }
    })
  })

  document.querySelectorAll('.relation-type-select').forEach(select => {
    select.addEventListener('change', async () => {
      const parentId = select.dataset.parentId
      const childId = select.dataset.childId
      const prevValue = parseInt(select.dataset.prevValue || '1')
      const nextValue = parseInt(select.value)

      if (!parentId || !childId || !nextValue) return
      if (prevValue === nextValue) return

      const success = await updateRelationType(parentId, childId, nextValue)
      if (success) {
        await fetchNodes()
        await selectNode(childId)
        // 再描画でアコーディオンが初期状態（閉）に戻るため、同じノードのままなら開き直す
        if (selectedNodeId === childId) {
          openParentsAccordion(childId)
        }
      } else {
        select.value = String(prevValue)
      }
    })
  })

  // 親ノード名クリック: ツリーでその親を選択し、エディタに表示
  document.querySelectorAll('.parent-name-link').forEach(link => {
    link.addEventListener('click', async (e) => {
      e.preventDefault()
      const parentId = link.dataset.parentId
      if (!parentId) return

      const okToProceed = await runWithUnsavedGuard(async () => {})
      if (!okToProceed) return

      // 親ノードを選択して遷移する際、開いている親アコーディオンのオーバーレイを閉じる
      closeParentsAccordion(node.id)

      // ゴミ箱専用の親はゴミ箱ビューへ、それ以外は通常ビューへ切り替えてから選択する（node-link と同じ挙動）
      switchViewForNodeOpen(parentId)

      if (treeViewMode === 'reverse') {
        const editorLoadRequestId = beginEditorLoad()
        const item = document.querySelector(`.tree-item[data-node-id="${parentId}"]`)
        if (!item) {
          finishEditorLoad(editorLoadRequestId)
          return
        }
        const nodePath = item.dataset.nodePath
        selectedNodeId = parentId
        selectedNodeElement = item
        selectedNodePath = nodePath
        document.querySelectorAll('.tree-item.active').forEach(el => el.classList.remove('active'))
        document.querySelectorAll('.tree-item.duplicate-active').forEach(el => el.classList.remove('duplicate-active'))
        item.classList.add('active')
        document.querySelectorAll(`.tree-item[data-node-id="${parentId}"]`).forEach(el => {
          if (el.dataset.nodePath !== nodePath) el.classList.add('duplicate-active')
        })
        try {
          const node = await fetchNodeById(parentId)
          if (!node) return
          const parentsRes = await axios.get(`/api/trees/${currentTreeId}/nodes/${parentId}/parents`)
          if (!isLatestEditorLoad(editorLoadRequestId)) return
          const parents = parentsRes.data.success ? parentsRes.data.data : []
          renderEditor(node, parents)
          if (!isHistoryNavigating) {
            pushNodeHistory({
              viewMode: 'reverse',
              nodeId: parentId,
              nodePath,
              reverseRootNodeId: selectedNodeId
            })
          }
        } finally {
          finishEditorLoad(editorLoadRequestId)
        }
      } else {
        // 親ノードが折りたたみ配下にある場合でも、ツリー上に可視化してから選択する
        expandParents(parentId)
        renderTree()

        const item = document.querySelector(`.tree-item[data-node-id="${parentId}"]`)
        const nodePath = item?.dataset?.nodePath || null
        await selectNode(parentId, nodePath)
      }
    })
  })

  // ByteMDを初期化
  if (window.currentEditor) {
    cleanupEditorLayoutHooks()
    syncSplitHandleVisibility()
    window.currentEditor.toTextArea()
    window.currentEditor = null
  }

  const editorContainer = document.getElementById('node-content-editor')
  if (!editorContainer) {
    console.error('[ByteMD] #node-content-editor not found in DOM')
    return
  }
  if (typeof bytemd === 'undefined') {
    console.error('[ByteMD] bytemd global is not defined — CDN may have failed to load')
    editorContainer.innerHTML = `<div style="padding:16px;color:red;">${t('editor.editorLoadFailed')}</div>`
    return
  }

  function remarkBreaksPlugin() {
    return {
      remark: (processor) => processor.use(function() {
        return function(tree) {
          function walk(node) {
            if (!node.children) return
            const next = []
            for (const child of node.children) {
              if (child.type === 'text' && child.value.includes('\n')) {
                const lines = child.value.split('\n')
                for (let i = 0; i < lines.length; i++) {
                  if (i > 0) next.push({ type: 'break' })
                  if (lines[i]) next.push({ type: 'text', value: lines[i] })
                }
              } else {
                walk(child)
                next.push(child)
              }
            }
            node.children = next
          }
          walk(tree)
        }
      })
    }
  }

  const bytemdPlugins = []
  if (typeof bytemdPluginGfm !== 'undefined') {
    try { bytemdPlugins.push(bytemdPluginGfm()) } catch (e) { console.warn('[ByteMD] GFM plugin failed:', e) }
  }
  bytemdPlugins.push(mermaidViewerPlugin())
  bytemdPlugins.push(htmlViewerPlugin())
  bytemdPlugins.push(imageViewerPlugin())
  bytemdPlugins.push(nodeLinkPlugin())
  bytemdPlugins.push(remarkBreaksPlugin())
  if (typeof tableEditorPlugin === 'function') bytemdPlugins.push(tableEditorPlugin())

  try {
    window.currentEditor = new ByteMDWrapper(editorContainer, node.content || '', bytemdPlugins)
  } catch (e) {
    console.error('[ByteMD] ByteMDWrapper init failed:', e)
    editorContainer.innerHTML = `<div style="padding:16px;color:red;">${t('editor.editorInitFailed', { reason: e.message })}</div>`
    return
  }

  const editorWrapper = window.currentEditor.codemirror.getWrapperElement()
  const refreshAndSyncContentLayout = () => {
    if (paneResizeInProgress) return
    syncEditorStickyLayout(editorWrapper)
    window.requestAnimationFrame(() => {
      syncContentEditorHeight(editorContainer)
    })
  }
  if (editorWrapper) {
    editorCodeMirrorWrapper = editorWrapper
    editorFullscreenForcedState = false

    editorResizeObserver = new ResizeObserver(() => {
      if (paneResizeInProgress) return
      syncEditorStickyLayout(editorWrapper)
    })
    editorResizeObserver.observe(editorContainer)

    // ByteMD レンダリング後にツールバーが生成されるため少し待つ
    setTimeout(() => {
      const toolbar = editorContainer.querySelector('.bytemd-toolbar')
      if (toolbar) {
        editorToolbarResizeObserver = new ResizeObserver(() => {
          if (paneResizeInProgress) return
          syncEditorStickyLayout(editorWrapper)
          refreshAndSyncContentLayout()
        })
        editorToolbarResizeObserver.observe(toolbar)
      }
    }, 100)

    editorWindowResizeHandler = () => {
      syncEditorStickyLayout(editorWrapper)
      syncContentEditorHeight(editorContainer)
      syncSplitHandleVisibility()
      refreshAndSyncContentLayout()
      const openParentsAccordion = editorPanel.querySelector('[id^="parents-accordion-content-"][style*="display: block"]')
      if (openParentsAccordion) {
        adjustParentsAccordionViewport(openParentsAccordion)
      }
    }
    window.addEventListener('resize', editorWindowResizeHandler)

    // スクロール連動: 編集ペインのスクロールで本文高さを再計算する。
    // rAF でスロットルし、pane リサイズ中と全画面時は無効化する
    editorScrollSyncHandler = () => {
      if (paneResizeInProgress) return
      if (isContentEditorFullscreen()) return
      if (editorScrollSyncRafId !== null) return
      editorScrollSyncRafId = window.requestAnimationFrame(() => {
        editorScrollSyncRafId = null
        syncContentEditorHeight(editorContainer)
      })
    }
    const editorScrollArea = document.getElementById('editor-scroll-area')
    if (editorScrollArea) {
      editorScrollArea.addEventListener('scroll', editorScrollSyncHandler, { passive: true })
    }

    // ByteMD fullscreen切り替え時にsplit line表示を同期
    let lastFullscreenState = isContentEditorFullscreen()
    editorFullscreenObserver = new MutationObserver(() => {
      // キャッシュ（editorFullscreenForcedState）経由だと古い値が返って変化検出が
      // 不成立になるため、ここでは DOM の真値を直接見る
      const nextFullscreenState = !!document.querySelector('.bytemd-fullscreen')
      if (nextFullscreenState === lastFullscreenState) return
      lastFullscreenState = nextFullscreenState
      editorFullscreenForcedState = nextFullscreenState
      syncSplitHandleVisibility()
      syncContentEditorHeight(editorContainer)
      refreshAndSyncContentLayout()
    })
    editorFullscreenObserver.observe(editorContainer, { attributes: true, subtree: true, attributeFilter: ['class'] })
    editorFullscreenObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] })
    // 全画面中は .bytemd が body 直下へテレポートされるため、コンテナのサブツリー監視では
    // 全画面解除の class除去を拾えない。要素自体も監視対象に加える
    const bytemdFullscreenTarget = editorContainer.querySelector('.bytemd')
    if (bytemdFullscreenTarget) {
      editorFullscreenObserver.observe(bytemdFullscreenTarget, { attributes: true, attributeFilter: ['class'] })
      mobileContentSwipeCleanup = setupMobileContentSwipe(bytemdFullscreenTarget)
    }

    editorKeydownHandler = (event) => {
      if (event.key === 'Escape') {
        editorFullscreenForcedState = false
        syncSplitHandleVisibility()
        syncContentEditorHeight(editorContainer)
        refreshAndSyncContentLayout()
      }
    }
    document.addEventListener('keydown', editorKeydownHandler)

    syncEditorStickyLayout(editorWrapper)
    syncContentEditorHeight(editorContainer)
    syncSplitHandleVisibility()
    refreshAndSyncContentLayout()
  }

  // ByteMDの変更監視
  window.currentEditor.codemirror.on('change', () => {
    clearSearchHighlight()
    checkDirty()
  })
  applyMarkdownPreviewPreference()
  applyPendingSearchHighlight(node.id)

  renderNodeImageIcons(node.id)
  setupNodeImageDropHandlers(node.id)
  fetchNodeImages(node.id).then(images => {
    if (selectedNodeId !== node.id) return
    nodeImages = images
    renderNodeImageIcons(node.id)
  })

  // ゴミ箱タブではゴミ箱/保存を無効化
  if (treeViewMode === 'trash') {
    const deleteBtn = document.getElementById('delete-node-btn')
    const saveBtn = document.getElementById('save-node-btn')
    const titleInput = document.getElementById('node-title')
    const authorSelect = document.getElementById('node-author')
    if (deleteBtn) {
      deleteBtn.disabled = true
      deleteBtn.style.opacity = '0.5'
      deleteBtn.style.cursor = 'not-allowed'
      deleteBtn.title = t('editor.disabledInTrash')
    }
    if (saveBtn) {
      saveBtn.disabled = true
      saveBtn.style.opacity = '0.5'
      saveBtn.style.cursor = 'not-allowed'
      saveBtn.title = t('editor.disabledInTrash')
    }
    if (titleInput) {
      titleInput.disabled = true
      titleInput.classList.add('bg-gray-50')
    }
    if (authorSelect) {
      authorSelect.disabled = true
      authorSelect.classList.add('bg-gray-50')
    }
    if (window.currentEditor?.codemirror) {
      window.currentEditor.codemirror.setOption('readOnly', true)
    }
    document.querySelectorAll('.remove-parent-btn').forEach(btn => {
      btn.disabled = true
      btn.style.opacity = '0.5'
      btn.style.cursor = 'not-allowed'
    })
    document.querySelectorAll('.relation-type-select').forEach(select => {
      select.disabled = true
      select.style.opacity = '0.6'
      select.style.cursor = 'not-allowed'
    })
  }

    // 閲覧者の場合はボタンを無効化
  if (currentUserRole === 'viewer') {
      const deleteBtn = document.getElementById('delete-node-btn')
      const saveBtn = document.getElementById('save-node-btn')
      const titleInput = document.getElementById('node-title')
      const authorSelect = document.getElementById('node-author')

      if (deleteBtn) {
        deleteBtn.disabled = true
        deleteBtn.style.opacity = '0.5'
        deleteBtn.style.cursor = 'not-allowed'
      }
      if (saveBtn) {
        saveBtn.disabled = true
        saveBtn.style.opacity = '0.5'
        saveBtn.style.cursor = 'not-allowed'
      }
      if (titleInput) {
        titleInput.disabled = true
        titleInput.classList.add('bg-gray-50')
      }
      if (authorSelect) {
        authorSelect.disabled = true
        authorSelect.classList.add('bg-gray-50')
      }

      // 親ノード削除ボタンも無効化
      document.querySelectorAll('.remove-parent-btn').forEach(btn => {
        btn.disabled = true
        btn.style.opacity = '0.5'
        btn.style.cursor = 'not-allowed'
      })
    }

    // EasyMDE 初期化後の実際の表示値を基準に未保存判定の初期値を確定する。
    initialNodeValues = captureEditorSnapshot() || {
      title: node.title || '',
      content: window.currentEditor ? window.currentEditor.value() : (node.content || ''),
      author_user_id: parseInt(document.getElementById('node-author')?.value) || node.author_user_id || null
    }
    restoreNodeDraftIfAvailable(node)
  } finally {
    resumeDirtyCheck()
  }
}

async function saveCurrentNode() {
  if (!currentEditorNodeId) return

  const title = document.getElementById('node-title').value.trim()
  // EasyMDEから値を取得
  const content = window.currentEditor ? window.currentEditor.value().trim() : ''
  const author_user_id = parseInt(document.getElementById('node-author').value) || null

  if (!title) {
    showToast(t('editor.titleRequired'), 'error')
    return false
  }

  if (!author_user_id) {
    showToast(t('editor.authorRequired'), 'error')
    return false
  }

  showLoading()
  try {
    const updated = await updateNode(currentEditorNodeId, { title, content, author_user_id, version: selectedNodeVersion })
    if (updated) {
      // 初期値を更新してダーティフラグをリセット
      initialNodeValues = captureEditorSnapshot() || { title, content, author_user_id }
      isDirty = false
      clearNodeDraft()
      // 呼び出し元で新しいノードへの切り替えを制御するため、ここでは再読み込みしない
      return true
    }
    return false
  } finally {
    hideLoading()
  }
}

async function deleteCurrentNode() {
  if (!currentEditorNodeId) return

  const success = await deleteNode(currentEditorNodeId)
  if (success) {
    currentEditorNodeId = null
    selectedNodeId = null
    renderEditor()
  }
}

// ===============================
// ノード追加
// ===============================
async function addChildNode(parentId) {
  const okToProceed = await confirmProceedWithUnsavedChanges()
  if (!okToProceed) return

  const title = await showPrompt(t('editor.childNodeTitlePrompt'))
  if (!title || !title.trim()) return

  showLoading()
  try {
    // ノード作成
    const node = await createNodeWithParent(parentId, {
      title: title.trim(),
      content: '',
      author_user_id: currentUser?.id
    }, { reload: false })

    if (node) {
      if (selectedNodePath) expandedNodePaths.add(selectedNodePath)
      await fetchNodes()
      await selectNode(node.id)
    }
  } finally {
    hideLoading()
  }
}

async function addSiblingNode(targetNodeElement) {
  if (!canEdit()) return

  const okToProceed = await confirmProceedWithUnsavedChanges()
  if (!okToProceed) return

  const el = targetNodeElement || selectedNodeElement
  if (!el) return

  const wrapper = el.closest('[data-node-group]')
  if (!wrapper) return
  const parentContainer = wrapper.parentElement

  const title = await showPrompt(t('editor.siblingNodeTitlePrompt'))
  if (!title || !title.trim()) return

  showLoading()
  try {
    const parentId = parentContainer.id === 'tree-container'
      ? currentRootNodeId
      : parentContainer.dataset.parent

    if (!parentId) return

    const node = await createNodeWithParent(parentId, {
      title: title.trim(),
      content: '',
      author_user_id: currentUser?.id
    }, { reload: false })

    if (node) {
      let parentPath = null
      if (parentContainer.id === 'tree-container') {
        parentPath = String(parentId)
      } else if (el.dataset.nodePath) {
        const parts = el.dataset.nodePath.split('-')
        parentPath = parts.length > 1 ? parts.slice(0, -1).join('-') : String(parentId)
      }
      if (parentPath) expandedNodePaths.add(parentPath)
      await fetchNodes()
      await selectNode(node.id)
    }
  } finally {
    hideLoading()
  }
}

// ===============================
// ユーティリティ
// ===============================
function formatDate(dateString) {
  if (!dateString) return '-'
  // SQLiteのCURRENT_TIMESTAMPはUTCで保存されるため、UTCとして解釈させる
  let normalizedDate = String(dateString).trim()
  // タイムゾーン情報がない場合はUTCとして扱う（末尾にZを追加）
  if (!normalizedDate.endsWith('Z') && !normalizedDate.includes('+') && !normalizedDate.includes('-', 10)) {
    // スペース区切りをTに置換
    normalizedDate = normalizedDate.replace(' ', 'T')
    // Zを追加してUTCとして解釈させる
    normalizedDate = normalizedDate + 'Z'
  }
  const date = new Date(normalizedDate)
  return date.toLocaleString(window.ZeetaI18n.locale === 'ja' ? 'ja-JP' : 'en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function sanitizePdfFileNamePart(value) {
  const raw = String(value || '').trim()
  const normalized = raw
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
  return normalized || 'node'
}

function renderMarkdownHtmlForPdf(markdownText) {
  const source = String(markdownText || '')
  if (!source.trim()) return `<p class="pdf-empty">${t('editor.noContent')}</p>`
  if (typeof marked !== 'undefined' && typeof marked.parse === 'function') {
    marked.setOptions({
      breaks: true,
      gfm: true
    })
    const html = marked.parse(source)
    // markedはサニタイズしない。印刷ウィンドウ（同一オリジン）に渡す前にDOMPurifyを通す。
    // DOMPurifyが読み込めていない場合は生HTMLを出さずエスケープにフォールバックする
    if (typeof DOMPurify !== 'undefined' && typeof DOMPurify.sanitize === 'function') {
      return DOMPurify.sanitize(html)
    }
    return `<pre>${escapeHtml(source)}</pre>`
  }
  return `<pre>${escapeHtml(source)}</pre>`
}

function buildNodePdfHtml(node, renderedContentHtml, orientation = 'portrait') {
  const title = String(node?.title || t('editor.untitled'))
  const titleForFile = sanitizePdfFileNamePart(title)
  const printOrientation = normalizePrintOrientation(orientation)
  const pageSize = printOrientation === 'landscape' ? 'A4 landscape' : 'A4 portrait'

  return `<!DOCTYPE html>
<html lang="${window.ZeetaI18n.locale}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(titleForFile)}.pdf</title>
  <base href="${window.location.origin}/" />
  <style>
    :root { color-scheme: light; }
    html, body {
      margin: 0;
      padding: 0;
      background: #fff;
      color: #111;
      font-family: "Hiragino Sans", "Yu Gothic", "Meiryo", sans-serif;
      line-height: 1.6;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .pdf-container {
      max-width: 840px;
      margin: 24px auto;
      padding: 0 16px 32px;
    }
    .pdf-content {
      font-size: 14px;
      color: #111827;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .pdf-content h1, .pdf-content h2, .pdf-content h3, .pdf-content h4 {
      color: #111827;
      margin-top: 1.2em;
      margin-bottom: 0.4em;
      page-break-after: avoid;
      break-after: avoid-page;
    }
    .pdf-content p, .pdf-content li { margin: 0.4em 0; }
    .pdf-content pre {
      background: #f3f4f6;
      border: 1px solid #d1d5db;
      border-radius: 6px;
      padding: 10px 12px;
      white-space: pre-wrap;
      page-break-inside: avoid;
      break-inside: avoid-page;
    }
    .pdf-content code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
    .pdf-content blockquote {
      margin: 0.8em 0;
      padding: 0.4em 0.8em;
      border-left: 4px solid #9ca3af;
      background: #f9fafb;
      page-break-inside: avoid;
      break-inside: avoid-page;
    }
    .pdf-content table {
      width: 100%;
      border-collapse: collapse;
      margin: 0.8em 0;
      page-break-inside: avoid;
      break-inside: avoid-page;
    }
    .pdf-content th, .pdf-content td {
      border: 1px solid #d1d5db;
      padding: 6px 8px;
      text-align: left;
      vertical-align: top;
    }
    .pdf-content img {
      max-width: 100%;
      height: auto;
      display: block;
      margin: 0.8em 0;
      page-break-inside: avoid;
      break-inside: avoid-page;
    }
    .pdf-empty {
      color: #6b7280;
      font-style: italic;
      margin: 0.5em 0;
    }
    @page { size: ${pageSize}; margin: 14mm 12mm 16mm; }
    @media print {
      html, body { background: #fff !important; color: #000 !important; }
      .pdf-container { margin: 0 auto; padding: 0; max-width: none; }
      .pdf-content a { color: #000; text-decoration: underline; }
    }
  </style>
</head>
<body>
  <main class="pdf-container">
    <section class="pdf-content">${renderedContentHtml}</section>
  </main>
  <script>
    window.addEventListener('load', function () {
      setTimeout(function () { window.print(); }, 500);
    });
    window.addEventListener('afterprint', function () {
      setTimeout(function () { window.close(); }, 150);
    });
  </script>
</body>
</html>`
}

function openNodePdfPrintWindow(node, orientation = 'portrait') {
  const contentRaw = window.currentEditor ? window.currentEditor.value() : (node?.content || '')
  const renderedContentHtml = renderMarkdownHtmlForPdf(contentRaw)
  const html = buildNodePdfHtml(node, renderedContentHtml, orientation)
  const printWindow = window.open('', '_blank')
  if (!printWindow) {
    showToast(t('editor.popupBlocked'), 'error')
    return
  }
  try {
    printWindow.document.open()
    printWindow.document.write(html)
    printWindow.document.close()
  } catch (error) {
    console.error('Failed to open PDF print window:', error)
    showToast(t('editor.pdfOutputStartFailed'), 'error')
    try { printWindow.close() } catch (_closeError) {}
  }
}

// ===============================
// ペインリサイズ
// ===============================
function setupPaneResize() {
  // モバイル幅ではリサイズ機能をスキップ
  if (window.matchMedia('(max-width: 767px)').matches) return

  const resizeHandle = document.getElementById('resize-handle')
  const treePane = document.getElementById('tree-pane')
  const editorPane = document.getElementById('editor-pane')
  const container = document.getElementById('main-container')

  let isResizing = false
  let startX = 0
  let startWidth = 0
  let latestClientX = 0
  let resizeRafId = null

  const applyPaneWidth = () => {
    resizeRafId = null
    if (!isResizing) return
    const containerWidth = container.offsetWidth
    const deltaX = latestClientX - startX
    const newWidth = startWidth + deltaX

    // 最小幅と最大幅を設定（20% - 80%）。最大幅からは左バーの幅を引き、
    // 左バーを追加する前と同じだけ編集ペインの幅を残す
    const railWidth = document.getElementById('tree-rail')?.offsetWidth || 0
    const minWidth = containerWidth * 0.2
    const maxWidth = containerWidth * 0.8 - railWidth

    if (newWidth >= minWidth && newWidth <= maxWidth) {
      const percentage = (newWidth / containerWidth) * 100
      treePane.style.width = `${percentage}%`
    }
  }

  const flushEditorLayoutAfterPaneResize = () => {
    if (!editorCodeMirrorWrapper) return
    window.requestAnimationFrame(() => {
      syncContentEditorHeight(editorCodeMirrorWrapper)
      syncSplitHandleVisibility()
    })
  }

  resizeHandle.addEventListener('mousedown', (e) => {
    isResizing = true
    paneResizeInProgress = true
    startX = e.clientX
    latestClientX = e.clientX
    startWidth = treePane.offsetWidth

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    e.preventDefault()
  })

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return
    latestClientX = e.clientX
    if (resizeRafId !== null) return
    resizeRafId = window.requestAnimationFrame(applyPaneWidth)
  })

  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false
      paneResizeInProgress = false
      if (resizeRafId !== null) {
        window.cancelAnimationFrame(resizeRafId)
        resizeRafId = null
      }
      applyPaneWidth()
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      flushEditorLayoutAfterPaneResize()
    }
  })
}

// ===============================
// クリップボード機能（Command+C/V）
// ===============================
function shouldUseNativeCopy(event) {
  const selectedText = window.getSelection?.()?.toString() || ''
  if (selectedText.trim().length > 0) {
    return true
  }

  const nativeCopyScopeSelector = '.bytemd-editor, .bytemd-preview, input, textarea, [contenteditable="true"]'
  const eventTarget = event?.target instanceof Element ? event.target : null
  const activeElement = document.activeElement instanceof Element ? document.activeElement : null

  if (eventTarget?.closest(nativeCopyScopeSelector)) {
    return true
  }
  if (activeElement?.closest(nativeCopyScopeSelector)) {
    return true
  }

  return false
}

function handleCopy(e) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'c' && selectedNodeId) {
    // preview/CodeMirror/入力系での通常コピーを優先
    if (shouldUseNativeCopy(e)) {
      return
    }

    e.preventDefault()
    setInternalClipboardByNodePath(selectedNodeId, selectedNodePath, selectedNodeElement, 'copy')
    void writeNodePlainTextToSystemClipboard(selectedNodeId)
  }
}

async function handleCut(e) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'x' && selectedNodeId) {
    if (document.activeElement.tagName === 'INPUT' ||
      document.activeElement.tagName === 'TEXTAREA') {
      return
    }

    e.preventDefault()
    setInternalClipboardByNodePath(selectedNodeId, selectedNodePath, selectedNodeElement, 'cut')
    await writeNodePlainTextToSystemClipboard(selectedNodeId)
  }
}

// Save shortcut handler (Cmd/Ctrl + Enter)
function handleSaveShortcut(e) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && selectedNodeId) {
    e.preventDefault()
    const saveBtn = document.getElementById('save-node-btn')
    if (saveBtn && !saveBtn.disabled) {
      saveBtn.click()
    }
  }
}

function handlePreviewExitShortcut(e) {
  if (e.isComposing) return
  if (e.altKey || e.ctrlKey || e.metaKey) return
  if (e.key !== 'e' && e.key !== 'E') return
  if (!window.currentEditor || typeof window.currentEditor.isPreviewActive !== 'function') return
  if (!window.currentEditor.isPreviewActive()) return

  const active = document.activeElement
  if (active instanceof HTMLElement) {
    const tagName = active.tagName
    if (
      tagName === 'INPUT' ||
      tagName === 'TEXTAREA' ||
      tagName === 'SELECT' ||
      tagName === 'BUTTON' ||
      active.isContentEditable ||
      active.closest('[role="dialog"], dialog, #custom-prompt-modal, #unsaved-confirm-modal, #delete-node-choice-modal, #print-orientation-modal')
    ) {
      return
    }
  }

  e.preventDefault()
  if (typeof window.currentEditor.exitPreviewOnly === 'function') {
    window.currentEditor.exitPreviewOnly()
  } else {
    window.currentEditor.togglePreview()
  }
}

async function handleNodeShortcuts(e) {
  if (!e.altKey) return

  // Alt+F: 入力欄やエディタにフォーカス中でも検索を開く（macOS の ƒ 入力を防止）
  if (e.code === 'KeyF' && !e.shiftKey) {
    e.preventDefault()
    openSearchPopup()
    return
  }

  const active = document.activeElement
  if (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') return
  if (active.closest('.cm-editor')) return

  const getShortcutTarget = () => {
    if (selectedNodeElement) {
      const nodeId = selectedNodeElement.dataset.nodeId
      const nodePath = selectedNodeElement.dataset.nodePath
      if (nodeId && nodePath) {
        return { nodeId, nodePath }
      }
    }
    if (selectedNodeId) {
      return { nodeId: selectedNodeId, nodePath: selectedNodePath || String(selectedNodeId) }
    }
    return null
  }

  if (e.code === 'KeyN' && !e.shiftKey) {
    e.preventDefault()
    if (selectedNodeId) await addChildNode(selectedNodeId)
  } else if (e.code === 'KeyM' && !e.shiftKey) {
    e.preventDefault()
    if (selectedNodeId && selectedNodePath) await duplicateNode(selectedNodeId, selectedNodePath)
  } else if (e.code === 'KeyN' && e.shiftKey) {
    e.preventDefault()
    await addSiblingNode()
  } else if (e.key === 'ArrowUp') {
    if (!selectedNodeElement || !isManualSortForParent(getParentNodeIdFromElement(selectedNodeElement))) return
    e.preventDefault()
    await moveNodeInSiblings(-1)
  } else if (e.key === 'ArrowDown') {
    if (!selectedNodeElement || !isManualSortForParent(getParentNodeIdFromElement(selectedNodeElement))) return
    e.preventDefault()
    await moveNodeInSiblings(1)
  } else if (e.code === 'KeyO' && !e.shiftKey) {
    e.preventDefault()
    const target = getShortcutTarget()
    if (target) {
      expandNodeDescendants(target.nodeId, target.nodePath)
      renderTree()
    }
  } else if (e.code === 'KeyL' && !e.shiftKey) {
    e.preventDefault()
    const target = getShortcutTarget()
    if (target) {
      collapseNodeDescendants(target.nodeId, target.nodePath)
      renderTree()
    }
  } else if (e.code === 'KeyR' && !e.shiftKey) {
    e.preventDefault()
    await reloadTreeData()
  } else if (e.code === 'KeyF' && !e.shiftKey) {
    e.preventDefault()
    openSearchPopup()
  }
}

async function handlePaste(e) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'v' && clipboard && selectedNodeId) {
    // エディタ内のテキスト選択を妨げない
    if (document.activeElement.tagName === 'INPUT' ||
      document.activeElement.tagName === 'TEXTAREA') {
      return
    }

    e.preventDefault()

    console.log('Pasting node:', { parent: selectedNodeId, child: clipboard })

    if (selectedNodePath) expandedNodePaths.add(selectedNodePath)
    const shouldMove = clipboardMode === 'cut' && clipboardSourceParentId !== undefined && clipboardSourceParentId !== null
    let success = false

    if (shouldMove && clipboardSourceParentId !== undefined && clipboardSourceParentId !== null) {
      success = await moveRelation(clipboard, clipboardSourceParentId, selectedNodeId, null, { reload: false })
    } else {
      success = await addRelation(selectedNodeId, clipboard, { reload: false })
      if (success) {
        await fetchNodes()
      }
    }

    if (success) {
      if (shouldMove && clipboardSourceParentId !== undefined) {
        clipboard = null
        clipboardMode = null
        clipboardSourceParentId = undefined
      }
    }
  }
}

async function handleDeleteShortcut(e) {
  if (!selectedNodeId) return
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
  if (e.key !== 'Delete' && e.key !== 'Backspace') return

  const active = document.activeElement
  if (e.composedPath().some(el => el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.isContentEditable)) return
  if (active?.closest('.bytemd-editor, .bytemd-preview')) return

  e.preventDefault()
  await deleteCurrentNode()
}

// ===============================
// キーボードナビゲーション（矢印キー）
// ===============================
function getVisibleNodeElements() {
  const visibleElements = []

  // ツリーコンテナから再帰的に走査して、表示順序通りにノード要素を取得
  function traverseTree(element) {
    // data-node-groupを持つ要素を探す
    const nodeGroups = element.children

    for (let i = 0; i < nodeGroups.length; i++) {
      const group = nodeGroups[i]

      // .tree-itemを探す
      const treeItem = group.querySelector(':scope > .tree-item')
      if (treeItem) {
        visibleElements.push(treeItem)

        // 子要素(.tree-children)があり、かつexpandedの場合は再帰的に走査
        const childrenContainer = group.querySelector(':scope > .tree-children.expanded')
        if (childrenContainer) {
          traverseTree(childrenContainer)
        }
      }
    }
  }

  const treeContainer = document.getElementById('tree-container')
  if (treeContainer) {
    traverseTree(treeContainer)
  }

  return visibleElements
}

async function handleArrowKeys(e) {
  // 入力フィールドにフォーカスがある場合はスキップ
  if (document.activeElement.tagName === 'INPUT' ||
    document.activeElement.tagName === 'TEXTAREA') {
    return
  }
  if (document.activeElement.closest('.cm-editor')) return

  if (e.altKey && e.key === 'ArrowLeft') {
    e.preventDefault()
    await navigateNodeHistory('back')
    return
  }
  if (e.altKey && e.key === 'ArrowRight') {
    e.preventDefault()
    await navigateNodeHistory('forward')
    return
  }

  // Alt+矢印（上下）はノード順移動ショートカットなのでスキップ
  if (e.altKey) return

  // 矢印キーでない場合はスキップ
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
    return
  }

  // 上下キーでノード切り替え時のみ未保存チェック
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault()
    const okToProceed = await runWithUnsavedGuard(async () => {})
    if (!okToProceed) return
    // 変更を破棄した場合、または保存成功後に移動
    handleArrowKeysInternal(e.key)
    return
  }

  e.preventDefault()
  handleArrowKeysInternal(e.key)
}

function handleArrowKeysInternal(key) {

  const visibleElements = getVisibleNodeElements()
  if (visibleElements.length === 0) return

  // 選択されているノードがない場合は最初のノードを選択
  if (!selectedNodePath && !selectedNodeId) {
    const firstElement = visibleElements[0]
    const firstNodeId = firstElement.dataset.nodeId
    const firstNodePath = firstElement.dataset.nodePath
    selectNode(firstNodeId, firstNodePath)
    return
  }

  // 現在選択されている要素のインデックスを見つける
  // 1. まずselectedNodeElement（実際のDOM要素）で探す（最も確実）
  // 2. 見つからなければselectedNodePathで探す
  // 3. それでも見つからなければselectedNodeIdで最初に見つかったものを探す
  let currentIndex = -1

  if (selectedNodeElement && document.contains(selectedNodeElement)) {
    // selectedNodeElementが有効な場合、visibleElements内で同じ要素参照を探す
    currentIndex = visibleElements.findIndex(el => el === selectedNodeElement)
  }

  if (currentIndex === -1 && selectedNodePath) {
    // パスで探す
    currentIndex = visibleElements.findIndex(el => el.dataset.nodePath === selectedNodePath)
  }

  if (currentIndex === -1 && selectedNodeId) {
    // IDで最初に見つかったものを探す（フォールバック）
    currentIndex = visibleElements.findIndex(el => el.dataset.nodeId === selectedNodeId)
    // 見つかった場合は、そのパスをselectedNodePathとして更新
    if (currentIndex !== -1) {
      const foundElement = visibleElements[currentIndex]
      selectedNodePath = foundElement.dataset.nodePath
      selectedNodeElement = foundElement
    }
  }

  if (currentIndex === -1) {
    // 見つからない場合（例えば親が閉じられた）、最初の要素を選択
    const firstElement = visibleElements[0]
    const firstNodeId = firstElement.dataset.nodeId
    const firstNodePath = firstElement.dataset.nodePath
    selectNode(firstNodeId, firstNodePath)
    return
  }

  const selectedNode = nodes.find(n => n.id === selectedNodeId)

  switch (key) {
    case 'ArrowUp':
      // 上のノードを選択
      if (currentIndex > 0) {
        const prevElement = visibleElements[currentIndex - 1]
        const prevNodeId = prevElement.dataset.nodeId
        const prevNodePath = prevElement.dataset.nodePath
        selectNode(prevNodeId, prevNodePath)
      }
      break

    case 'ArrowDown':
      // 下のノードを選択
      if (currentIndex < visibleElements.length - 1) {
        const nextElement = visibleElements[currentIndex + 1]
        const nextNodeId = nextElement.dataset.nodeId
        const nextNodePath = nextElement.dataset.nodePath
        selectNode(nextNodeId, nextNodePath)
      }
      break

    case 'ArrowRight':
      if (selectedNodeElement) {
        // 選択中のノードのIDを取得
        const nodeIdToExpand = selectedNodeElement.dataset.nodeId
        const nodePathToExpand = selectedNodeElement.dataset.nodePath

        // 逆ツリーモードと通常モードで子ノードの判定方法が異なる
        const hasChildren = treeViewMode === 'reverse'
          ? relations.some(rel => rel.child_node_id === nodeIdToExpand)
          : relations.some(rel => rel.parent_node_id === nodeIdToExpand)

        if (hasChildren && nodePathToExpand && !expandedNodePaths.has(nodePathToExpand)) {
          const toggleIcon = selectedNodeElement.querySelector('.toggle-icon')
          if (toggleIcon) toggleNode(nodeIdToExpand, toggleIcon)
        }
      }
      break

    case 'ArrowLeft':
      if (selectedNodeElement) {
        const nodeIdToCollapse = selectedNodeElement.dataset.nodeId
        const nodePathToCollapse = selectedNodeElement.dataset.nodePath

        if (nodePathToCollapse && expandedNodePaths.has(nodePathToCollapse)) {
          const toggleIcon = selectedNodeElement.querySelector('.toggle-icon')
          if (toggleIcon) toggleNode(nodeIdToCollapse, toggleIcon)
        } else if (treeViewMode === 'normal') {
          // 通常モードで既に折りたたまれている場合は、親ノードに移動
          // パスから親パスを計算: "1-2-3" -> "1-2"
          if (selectedNodePath) {
            const lastSeparatorIndex = selectedNodePath.lastIndexOf('-')
            if (lastSeparatorIndex > 0) {
              const parentPath = selectedNodePath.substring(0, lastSeparatorIndex)
              const parentElement = document.querySelector(`.tree-item[data-node-path="${parentPath}"]`)

              if (parentElement) {
                const parentId = parentElement.dataset.nodeId
                selectNode(parentId, parentPath)
              }
            }
          }
        }
        // 逆ツリーモードで折りたたまれている場合は何もしない
      }
      break
  }
}

// ===============================
// 初期化
// ===============================
document.addEventListener('DOMContentLoaded', () => {
  loadRenderConfig()
  cleanupExpiredNodeDrafts()
  ensureCaretStyles()

  const nodeDetailDialog = document.getElementById('node-detail-dialog')
  document.getElementById('node-detail-dialog-close')?.addEventListener('click', closeNodeDetailDialog)
  // preview の copy button。選択中の版の content（=preview 表示内容）をコピーする。
  // loading 中の案内文字列をコピーしないよう DOM ではなく cache から読む
  document.getElementById('node-detail-copy-btn')?.addEventListener('click', async () => {
    if (nodeDetailSelectedVersion == null) return
    const content = nodeDetailPreviewCache.get(nodeDetailSelectedVersion) ?? ''
    if (!content) {
      showToast(t('editor.contentEmpty'), 'error')
      return
    }
    if (!navigator.clipboard?.writeText) {
      showToast(t('editor.clipboardUnavailable'), 'error')
      return
    }
    try {
      await navigator.clipboard.writeText(content)
      showToast(t('editor.contentCopied'))
    } catch (error) {
      console.error('Failed to copy preview content:', error)
      showToast(t('editor.copyFailed'), 'error')
    }
  })
  // 背景クリックでは閉じない。履歴を見ながら本文を確認したくなる場面で、
  // 外側を触っただけでダイアログが消えると選択と preview がやり直しになる。
  // 閉じる手段は × ボタンと Escape の2つ
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || nodeDetailDialog?.classList.contains('hidden')) return
    // The conflict dialog is layered above node detail; do not let one Escape
    // operate on the obscured dialog when both are present.
    if (!document.getElementById('conflict-dialog')?.classList.contains('hidden')) return
    // 比較オーバーレイが開いている間は、その下の node detail を Escape で閉じない
    const compareOverlay = document.getElementById('node-compare-overlay')
    if (compareOverlay && !compareOverlay.classList.contains('hidden')) {
      event.preventDefault()
      closeNodeCompareOverlay()
      return
    }
    event.preventDefault()
    closeNodeDetailDialog()
  })
  // 「比較」ボタン。viewer でも履歴閲覧と同じ読み取り専用操作として使える
  document.getElementById('node-detail-compare-btn')?.addEventListener('click', () => {
    void openNodeCompareOverlay()
  })
  document.getElementById('node-compare-close')?.addEventListener('click', closeNodeCompareOverlay)

  // ペインリサイズ
  setupPaneResize()

  // ツリー表示モード切り替え
  document.querySelectorAll('.tree-view-tab').forEach(tab => {
    tab.addEventListener('click', async (e) => {
      const viewMode = tab.dataset.view
      if (viewMode === 'normal') {
        e.preventDefault()
        e.stopPropagation()
        const wasNormalMode = treeViewMode === 'normal'
        const reverseFocusedNodeId = treeViewMode === 'reverse' ? getCurrentDisplayNodeId() : null
        if (treeViewMode !== 'normal') {
          const savedNormalPath = normalViewSelectedNodePath
          normalViewSelectedNodePath = null
          const restorePath = reverseFocusedNodeId && savedNormalPath &&
            savedNormalPath.split('-').pop() === String(reverseFocusedNodeId)
            ? savedNormalPath
            : null
          treeViewMode = 'normal'
          if (restorePath) selectedNodePath = restorePath
          document.querySelectorAll('.tree-view-tab').forEach(t => t.classList.remove('active'))
          tab.classList.add('active')
          renderTree()
          if (reverseFocusedNodeId) {
            await selectNode(reverseFocusedNodeId, restorePath)
          }
          hideNormalViewMenu()
          return
        }
        if (wasNormalMode) {
          toggleNormalViewMenu(tab)
        }
        return
      }

      hideNormalViewMenu()

      // タブのアクティブ状態を切り替え
      document.querySelectorAll('.tree-view-tab').forEach(t => t.classList.remove('active'))
      tab.classList.add('active')

      // 表示モードを切り替え
      if (treeViewMode === 'normal' && viewMode === 'reverse') {
        normalViewSelectedNodePath = selectedNodePath
      }
      treeViewMode = viewMode
      if (treeViewMode === 'reverse' && selectedNodeId && reverseInitialExpandedForNodeId !== selectedNodeId) {
        expandNodeDirectChildren(selectedNodeId, String(selectedNodeId))
        reverseInitialExpandedForNodeId = selectedNodeId
      }
      renderTree()
    })
  })

  // キーボードショートカット
  document.addEventListener('keydown', handleCopy)
  document.addEventListener('keydown', handleCut)
  document.addEventListener('keydown', handlePaste)
  document.addEventListener('keydown', handleDeleteShortcut)
  document.addEventListener('keydown', handleArrowKeys)
  document.addEventListener('keydown', handleSaveShortcut)
  document.addEventListener('keydown', handlePreviewExitShortcut)
  document.addEventListener('keydown', handleNodeShortcuts)

  // 初期データ読み込み（認証とツリーコンテキストチェック）
  initializeApp()
})

// Mermaid レンダリング
// 公式 @bytemd/plugin-mermaid は mermaid 10.0.2 同梱・全図を並列レンダリング・
// エラーを握り潰すため、初回ロードのタイミング次第で図が黒塗り/空白になる。
// 修正版 mermaid を遅延ロードし、1図ずつ順次レンダリングする自前プラグインで置き換える。
// erDiagram の属性名が日本語（Unicode）を含むと 10.x / 11.4以下 は ATTRIBUTE_WORD で
// パースエラーになる。11.5.0 で修正されたため最新版へ追従する。
const MERMAID_CDN_URL = 'https://cdn.jsdelivr.net/npm/mermaid@12.2.0/dist/mermaid.min.js'
let mermaidLoadPromise = null

// mermaid のテーマは Zeeta のテーマ（html.theme-dark）に合わせる
function currentMermaidTheme() {
  return document.documentElement.classList.contains('theme-dark') ? 'dark' : 'default'
}

function loadMermaid() {
  if (!mermaidLoadPromise) {
    mermaidLoadPromise = new Promise((resolve, reject) => {
      if (window.mermaid) {
        resolve(window.mermaid)
        return
      }
      const script = document.createElement('script')
      script.src = MERMAID_CDN_URL
      script.onload = () => {
        window.mermaid.initialize({ startOnLoad: false, theme: currentMermaidTheme() })
        resolve(window.mermaid)
      }
      script.onerror = () => {
        mermaidLoadPromise = null
        reject(new Error('mermaid CDN load failed'))
      }
      document.head.appendChild(script)
    })
  }
  return mermaidLoadPromise
}

let mermaidRenderSeq = 0

// 全 viewerEffect を横断してレンダリングを直列化する（プレビュー再描画が
// 重なった場合でも mermaid.render が並行実行されないようにする）
let mermaidRenderChain = Promise.resolve()
function enqueueMermaidTask(task) {
  const next = mermaidRenderChain.then(task, task)
  mermaidRenderChain = next.catch(() => {})
  return next
}

// 壊れたレンダリング結果の検知。
// 症状（本番初回ロード時）: SVG は生成されるが内部 <style> の CSS が効かず、
// エッジ線（inline fill:none / stroke はCSS依存）とラベル背景だけが消える。
function diagnoseMermaidSvg(svg) {
  const styleEl = svg.querySelector('style')
  if (!styleEl) return 'style-missing'
  if (!styleEl.textContent.includes('#' + svg.id)) return 'style-scope-mismatch'
  // 図の種類を問わない共通判定: mermaid のCSSは必ずルートsvgに
  // font-family "trebuchet ms" を当てる（default / dark 両テーマで共通。
  // テーマを追加する場合はこの判定も合わせて見直すこと）。
  // 未挿入の要素は computed style が取れないため接続済みの場合のみ判定する。
  if (svg.isConnected && !getComputedStyle(svg).fontFamily.toLowerCase().includes('trebuchet')) {
    return 'css-not-applied'
  }
  const link = svg.querySelector('path.flowchart-link')
  if (link && getComputedStyle(link).stroke === 'none') return 'edge-stroke-none'
  return null
}

async function renderMermaidInto(mermaid, holder, source) {
  const id = `zeeta-mermaid-${++mermaidRenderSeq}`
  const { svg } = await mermaid.render(id, source)
  holder.innerHTML = svg
  const svgEl = holder.querySelector('svg')
  return svgEl ? diagnoseMermaidSvg(svgEl) : 'svg-missing'
}

const MERMAID_RETRY_DELAY_MS = 400
const MERMAID_SWEEP_DELAYS_MS = [1000, 2000] // 全描画完了からの経過時間で複数回スイープ
const MERMAID_VIEWER_READY_MESSAGE = 'zeeta:mermaid-viewer-ready'
const MERMAID_VIEWER_LOAD_MESSAGE = 'zeeta:mermaid-viewer-load'

const VIEWER_HANDSHAKE_TIMEOUT_MS = 10000

// 別タブのビューア（/mermaid-viewer, /html-viewer）へ中身を渡す共通処理。
// 中身はURLに載せず、開いた先が ready を通知してから postMessage で送る。
function openInPopupViewer({ path, readyMessage, loadMessage, buildPayload, loadFailedText }) {
  const channel = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  let viewerWindow = null
  let timeoutId = null

  const cleanup = () => {
    window.removeEventListener('message', handleViewerReady)
    if (timeoutId) window.clearTimeout(timeoutId)
  }
  const handleViewerReady = (event) => {
    if (event.origin !== window.location.origin || event.source !== viewerWindow) return
    if (!event.data || event.data.type !== readyMessage || event.data.channel !== channel) return
    viewerWindow.postMessage({ type: loadMessage, channel, ...buildPayload() }, window.location.origin)
    cleanup()
  }

  window.addEventListener('message', handleViewerReady)
  viewerWindow = window.open(`${path}?channel=${encodeURIComponent(channel)}`, '_blank')
  if (!viewerWindow) {
    cleanup()
    showToast(t('editor.newTabOpenFailed'), 'error')
    return
  }
  timeoutId = window.setTimeout(() => {
    cleanup()
    if (!viewerWindow.closed) showToast(loadFailedText, 'error')
  }, VIEWER_HANDSHAKE_TIMEOUT_MS)
}

function openMermaidInViewer(holder) {
  if (!holder || !holder.closest('.bytemd-preview')) return
  const svg = holder.querySelector('svg')
  if (!svg) return

  openInPopupViewer({
    path: '/mermaid-viewer',
    readyMessage: MERMAID_VIEWER_READY_MESSAGE,
    loadMessage: MERMAID_VIEWER_LOAD_MESSAGE,
    buildPayload: () => ({
      // outerHTML はHTMLシリアライザなので foreignObject 内のXHTML void要素
      // （ラベルの `<br/>` など）が閉じタグなしで出力され、viewer側の
      // 厳格なXMLパース（image/svg+xml）が parsererror になる。
      // XMLSerializer なら `<br />` と整形式で出力される。
      svg: new XMLSerializer().serializeToString(svg),
      title: document.getElementById('node-title')?.value || t('editor.mermaidDiagram'),
    }),
    loadFailedText: t('editor.mermaidViewerLoadFailed'),
  })
}

function makeMermaidHolderInteractive(holder) {
  if (!holder || holder.dataset.mermaidViewerReady === 'true') return
  holder.dataset.mermaidViewerReady = 'true'
  holder.tabIndex = 0
  holder.setAttribute('role', 'button')
  holder.setAttribute('aria-label', t('editor.openMermaidInNewTab'))
  holder.title = t('editor.clickToOpenInNewTab')
  holder.addEventListener('click', event => {
    if (event.target instanceof Element && event.target.closest('a')) return
    openMermaidInViewer(holder)
  })
  holder.addEventListener('keydown', event => {
    if (event.target !== holder || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    openMermaidInViewer(holder)
  })
}

function mermaidViewerPlugin() {
  return {
    viewerEffect({ markdownBody }) {
      const codeBlocks = [...markdownBody.querySelectorAll('pre>code.language-mermaid')]
      if (codeBlocks.length === 0) return
      ;(async () => {
        let mermaid
        try {
          mermaid = await loadMermaid()
        } catch (e) {
          console.warn('[mermaid]', e)
          return
        }
        for (const code of codeBlocks) {
          const pre = code.parentElement
          // プレビュー再描画で旧DOMが破棄された場合は、新しい viewerEffect 実行に任せる
          if (!pre || !pre.isConnected) continue
          const source = code.innerText
          await enqueueMermaidTask(async () => {
            if (!pre.isConnected) return
            try {
              const holder = document.createElement('div')
              holder.classList.add('bytemd-mermaid')
              holder.style.lineHeight = 'initial'
              holder.dataset.mermaidSource = source
              let broken = await renderMermaidInto(mermaid, holder, source)
              if (!pre.isConnected) return
              pre.replaceWith(holder)
              makeMermaidHolderInteractive(holder)
              // DOM挿入後に再判定（挿入前と挿入後で適用結果が変わるケースに備える）
              const inserted = holder.querySelector('svg')
              broken = inserted ? diagnoseMermaidSvg(inserted) : broken
              if (broken) {
                // 根本原因特定用の診断ログ + その場で1回だけ自動再描画
                console.warn('[mermaid] broken render detected:', broken, {
                  id: inserted && inserted.id,
                  cssSample: inserted && inserted.querySelector('style')
                    ? inserted.querySelector('style').textContent.slice(0, 200) : null,
                })
                await new Promise(r => setTimeout(r, MERMAID_RETRY_DELAY_MS))
                if (!holder.isConnected) return
                const retryBroken = await renderMermaidInto(mermaid, holder, source)
                console.warn('[mermaid] retry result:', retryBroken || 'ok')
              }
            } catch (e) {
              // 失敗時は元のコードブロックを残す（黒塗り・空白にしない）
              console.warn('[mermaid] render failed:', e)
            }
          })
        }
        // 最終スイープ: 全描画完了後、1秒・2秒の2回壊れた図を一括検査して再描画する。
        // （描画時は正常でも、その後のDOM再構築等で壊れた場合の保険）
        await enqueueMermaidTask(async () => {
          let elapsed = 0
          for (const delay of MERMAID_SWEEP_DELAYS_MS) {
            await new Promise(r => setTimeout(r, delay - elapsed))
            elapsed = delay
            for (const holder of document.querySelectorAll('.bytemd-mermaid[data-mermaid-source]')) {
              const svgEl = holder.querySelector('svg')
              if (!svgEl || !holder.isConnected) continue
              const broken = diagnoseMermaidSvg(svgEl)
              if (!broken) continue
              console.warn('[mermaid] final sweep re-render:', broken, svgEl.id)
              try {
                await renderMermaidInto(mermaid, holder, holder.dataset.mermaidSource)
              } catch (e) {
                console.warn('[mermaid] final sweep failed:', e)
              }
            }
          }
        })
      })()
    },
  }
}

// テーマ切替時に mermaid のテーマを切り替え、表示中の図を再レンダリングする。
// 再レンダリングは mermaidRenderChain に乗せて通常の描画と直列化する
window.addEventListener('zeeta:themechange', () => {
  ;(async () => {
    let mermaid
    try {
      mermaid = await loadMermaid()
    } catch (e) {
      return
    }
    await enqueueMermaidTask(async () => {
      mermaid.initialize({ startOnLoad: false, theme: currentMermaidTheme() })
      for (const holder of document.querySelectorAll('.bytemd-mermaid[data-mermaid-source]')) {
        if (!holder.isConnected) continue
        try {
          await renderMermaidInto(mermaid, holder, holder.dataset.mermaidSource)
        } catch (e) {
          console.warn('[mermaid] theme re-render failed:', e)
        }
      }
    })
  })()
})

// HTML コードブロックのレンダリング表示
// Mermaid と違い、プレビュー上の見た目は「コードブロックのまま」にする。
// hover でクリッカブルになり、クリックで sandbox ビューア（/html-viewer）に渡す。
const HTML_VIEWER_READY_MESSAGE = 'zeeta:html-viewer-ready'
const HTML_VIEWER_LOAD_MESSAGE = 'zeeta:html-viewer-load'
const HTML_DOCUMENT_HEAD_PATTERN = /^\s*(?:<!doctype\s+html\b|<html\b)/i

// プレビュー内のコードブロックが「HTMLとして開く対象」かを判定する。
//   - ```html で囲まれている（ByteMD が code.language-html を付ける）
//   - 言語指定なしでも、ブロックの先頭が <!doctype html> / <html>
// 「本文のどこかに doctype がある」では判定しない。HTMLの解説記事で doctype を
// 引用しているだけのブロックまでクリッカブルになるため
// （本番実測 2026-09-13: doctype を含む26件のうち6件は本文途中）。
function getOpenableHtmlBlockSource(code) {
  const source = code.innerText
  if (!source.trim()) return ''
  if (code.classList.contains('language-html')) return source
  return HTML_DOCUMENT_HEAD_PATTERN.test(source) ? source : ''
}

// ```html で囲んだ断片（<div>…</div> だけ等）はそのまま開くと charset 未指定の
// 裸のフラグメントになり日本語が化けるため、最小のHTML文書に包む。
function toStandaloneHtmlDocument(source) {
  if (HTML_DOCUMENT_HEAD_PATTERN.test(source)) return source
  return `<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n</head>\n<body>\n${source}\n</body>\n</html>`
}

function openHtmlBlockInViewer(pre, source) {
  if (!pre || !pre.closest('.bytemd-preview')) return
  openInPopupViewer({
    path: '/html-viewer',
    readyMessage: HTML_VIEWER_READY_MESSAGE,
    loadMessage: HTML_VIEWER_LOAD_MESSAGE,
    buildPayload: () => ({
      html: toStandaloneHtmlDocument(source),
      title: document.getElementById('node-title')?.value || t('editor.htmlBlock'),
    }),
    loadFailedText: t('editor.htmlViewerLoadFailed'),
  })
}

function makeHtmlBlockInteractive(pre, source) {
  if (!pre || pre.dataset.htmlViewerReady === 'true') return
  pre.dataset.htmlViewerReady = 'true'
  pre.tabIndex = 0
  pre.setAttribute('role', 'button')
  pre.setAttribute('aria-label', t('editor.openHtmlBlockInNewTab'))
  pre.title = t('editor.clickToOpenHtmlInNewTab')
  pre.addEventListener('click', event => {
    if (event.target instanceof Element && event.target.closest('a')) return
    // Mermaid の図と違いコードブロックはテキスト選択の対象。
    // ドラッグしてコピーした直後のクリックで別タブを開かない。
    if (String(window.getSelection() || '')) return
    openHtmlBlockInViewer(pre, source)
  })
  pre.addEventListener('keydown', event => {
    if (event.target !== pre || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    openHtmlBlockInViewer(pre, source)
  })
}

function htmlViewerPlugin() {
  return {
    viewerEffect({ markdownBody }) {
      // 言語指定なしフェンスには language-* クラスが付かないため、
      // language-html だけを引くのではなく pre>code を全部見る必要がある。
      for (const code of markdownBody.querySelectorAll('pre>code')) {
        const pre = code.parentElement
        if (!pre || !pre.isConnected) continue
        const source = getOpenableHtmlBlockSource(code)
        if (!source) continue
        makeHtmlBlockInteractive(pre, source)
      }
    },
  }
}

// content中の画像（![alt](url)）の拡大表示。
// Mermaid/HTMLブロックと同じく、専用ビューア（/image-viewer）を別タブで開く。
// 右上画像アイコンの「別タブで表示」もこの経路を使う。
const IMAGE_VIEWER_READY_MESSAGE = 'zeeta:image-viewer-ready'
const IMAGE_VIEWER_LOAD_MESSAGE = 'zeeta:image-viewer-load'

function openImageInViewer({ url, alt }) {
  if (!url) return
  openInPopupViewer({
    path: '/image-viewer',
    readyMessage: IMAGE_VIEWER_READY_MESSAGE,
    loadMessage: IMAGE_VIEWER_LOAD_MESSAGE,
    buildPayload: () => ({
      url,
      alt: alt || '',
      title: document.getElementById('node-title')?.value || t('editor.image'),
    }),
    loadFailedText: t('editor.imageViewerLoadFailed'),
  })
}

function makeImageInteractive(img) {
  if (!img || img.dataset.imageViewerReady === 'true') return
  img.dataset.imageViewerReady = 'true'
  img.tabIndex = 0
  img.setAttribute('role', 'button')
  img.setAttribute('aria-label', t('editor.openImageInNewTab'))
  img.title = t('editor.clickToOpenImageInNewTab')
  img.addEventListener('click', event => {
    // [![alt](image)](link) の場合はリンクを優先してビューアを開かない
    if (event.target instanceof Element && event.target.closest('a')) return
    openImageInViewer({ url: img.currentSrc || img.src, alt: img.alt })
  })
  img.addEventListener('keydown', event => {
    if (event.target !== img || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    openImageInViewer({ url: img.currentSrc || img.src, alt: img.alt })
  })
}

function imageViewerPlugin() {
  return {
    viewerEffect({ markdownBody }) {
      for (const img of markdownBody.querySelectorAll('img')) {
        if (!img.src && !img.currentSrc) continue
        makeImageInteractive(img)
      }
    },
  }
}

// ノードリンク記法 [タイトル (id:xxxxxx)] のプレビュー内リンク化
// - 記法は単独ブラケット + (id:6文字base58) 必須。タイトルと (id: の間の半角スペースは
//   0個以上。区切りの空白は半角スペースのみ（タブ・全角スペースはタイトルの一部、
//   \s にはしない＝改行はまたがない）。タスクリスト - [x] や脚注 [^1]、
//   markdown リンクとは (id:...) 接尾辞があるため衝突しない
// - ID部分の文字種は src/utils/public-id.ts の isValidPublicNodeId() と同じ
// - タイトル部分は最短一致（[] を含めない）。] を含むタイトルはリンクにならない
// - 表示は外側のブラケットを除いた `タイトル (id:xxxxxx)`（IDは隠さない。
//   書き方のスペース数に関係なくスペース1個に正規化される）
const NODE_LINK_PATTERN = /\[([^[\]\n]+?) *\(id:([1-9A-HJ-NP-Za-km-z]{6})\)\]/g

function makeNodeLinkInteractive(anchor) {
  if (!anchor || anchor.dataset.nodeLinkReady === 'true') return
  anchor.dataset.nodeLinkReady = 'true'
  anchor.classList.add('zeeta-node-link')
  anchor.title = t('editor.openNodeLink')
  anchor.addEventListener('click', async (event) => {
    event.preventDefault()
    const nodeId = anchor.dataset.nodeId
    if (!nodeId || selectedNodeId === nodeId) return
    const okToProceed = await runWithUnsavedGuard(async () => {})
    if (!okToProceed) return
    switchViewForNodeOpen(nodeId)
    const opened = await openNodeAlongPreferredPath(nodeId)
    if (!opened) {
      showToast(t('editor.requestedNodeOpenFailed'), 'error')
    }
  })
}

// ノードリンク・URL直接表示からノードを開くときのビュー切替。
// ゴミ箱に入っているノードは通常ビューのDOMに存在しないため、検索ポップアップと
// 同じ分類（ゴミ箱専用ノードならゴミ箱ビュー、それ以外は通常ビュー）へ切り替えてから選択する。
function switchViewForNodeOpen(nodeId) {
  const trashReachableNodeIds = getTrashReachableNodeIdSet()
  const isInTrashSubtree = trashReachableNodeIds.has(nodeId) && nodeId !== currentTrashRootNodeId
  const isTrashOnlyNode = isInTrashSubtree && !getSharedTrashNodeIdSet(trashReachableNodeIds).has(nodeId)
  const shouldShowTrashView = isTrashOnlyNode

  if (shouldShowTrashView && treeViewMode !== 'trash') {
    hideNormalViewMenu()
    treeViewMode = 'trash'
    document.querySelectorAll('.tree-view-tab').forEach(t => t.classList.remove('active'))
    document.querySelector('.tree-view-tab[data-view="trash"]')?.classList.add('active')
    renderTree()
  } else if (!shouldShowTrashView && treeViewMode === 'trash') {
    hideNormalViewMenu()
    treeViewMode = 'normal'
    document.querySelectorAll('.tree-view-tab').forEach(t => t.classList.remove('active'))
    document.querySelector('.tree-view-tab[data-view="normal"]')?.classList.add('active')
    renderTree()
  }
}

function nodeLinkPlugin() {
  return {
    viewerEffect({ markdownBody }) {
      // 存在チェック用。nodes / relations にはゴミ箱配下のノードも含まれるため、
      // 「存在しないIDは素のテキスト・ゴミ箱はリンク」の要件をこれ1つで満たす
      const existingNodeIds = new Set()
      nodes.forEach(n => existingNodeIds.add(n.id))
      relations.forEach(rel => {
        existingNodeIds.add(rel.parent_node_id)
        existingNodeIds.add(rel.child_node_id)
      })

      const walker = document.createTreeWalker(markdownBody, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement
          if (!parent) return NodeFilter.FILTER_REJECT
          // コードブロック・インラインコード内はID説明を壊さないため対象外
          if (parent.closest('pre, code')) return NodeFilter.FILTER_REJECT
          // 加工済みリンクやmarkdownリンク内部の二重処理を防ぐ
          if (parent.closest('a')) return NodeFilter.FILTER_REJECT
          NODE_LINK_PATTERN.lastIndex = 0
          return NODE_LINK_PATTERN.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
        },
      })

      const matchedTextNodes = []
      while (walker.nextNode()) matchedTextNodes.push(walker.currentNode)

      for (const textNode of matchedTextNodes) {
        if (!textNode.isConnected) continue
        NODE_LINK_PATTERN.lastIndex = 0
        const fragment = document.createDocumentFragment()
        let lastIndex = 0
        let match
        while ((match = NODE_LINK_PATTERN.exec(textNode.nodeValue)) !== null) {
          if (match.index > lastIndex) {
            fragment.appendChild(document.createTextNode(textNode.nodeValue.slice(lastIndex, match.index)))
          }
          // 存在しないIDは素のテキストのまま残す。lastIndex をマッチ先頭のままにして、
          // 次のギャップ連結 or 末尾スライスがこの分のテキストを拾う
          if (!existingNodeIds.has(match[2])) {
            lastIndex = match.index
            continue
          }
          const anchor = document.createElement('a')
          // href は buildNodeShareUrl() と同じ形（/index.html?tree=...&node=...）。
          // 遷移はクリックハンドラで preventDefault するため、通常のページ遷移には使わない
          anchor.href = buildNodeShareUrl(match[2])
          anchor.dataset.nodeId = match[2]
          // 外側のブラケットは表示しない（記法は書くときだけのもの）
          anchor.textContent = `${match[1]} (id:${match[2]})`
          makeNodeLinkInteractive(anchor)
          fragment.appendChild(anchor)
          lastIndex = match.index + match[0].length
        }
        if (lastIndex < textNode.nodeValue.length) {
          fragment.appendChild(document.createTextNode(textNode.nodeValue.slice(lastIndex)))
        }
        textNode.replaceWith(fragment)
      }
    },
  }
}

async function initializeApp() {
  showLoadingAfterDelay(INITIAL_LOADING_DELAY_MS)

  // Check authentication
  const isAuthenticated = await checkAuth()
  if (!isAuthenticated) {
    hideLoading()
    showToast(t('editor.loginRequired'), 'error')
    setTimeout(() => {
      window.location.href = '/login.html'
    }, 1500)
    return
  }

  // Load tree context and check access
  const treeContext = await loadTreeContext()
  if (treeContext === 'empty') {
    updateTreeHeader()
    window.ZeetaTreeRail.setEmptyState(true)
    hideLoading()
    markAppReady()
    return
  }
  if (treeContext !== 'ok') {
    // 読み込みに失敗しても、左バーから別のツリーへ移れるようヘッダーは出しておく
    if (!document.getElementById('app-menu-btn')) updateTreeHeader()
    hideLoading()
    markAppReady()
    return
  }

  // Load nodes
  await fetchRelationTypes()
  await Promise.all([
    fetchNodes(),
    fetchTreeMembers()
  ])

  const initialNodeId = getNodeIdFromURL()
  // 「new ver.」のリロード前に見ていた位置。ノード指定が無くても保存値は消費して残さない
  const reloadSelectionPath = takeReloadSelectionPath(initialNodeId)
  if (initialNodeId) {
    // URL でゴミ箱配下のノードを直接開いた場合はゴミ箱ビューへ切り替えてから選択する
    switchViewForNodeOpen(initialNodeId)
    const opened = await openNodeAlongPreferredPath(initialNodeId, { recordHistory: false, nodePath: reloadSelectionPath })
    if (!opened) {
      showToast(t('editor.requestedNodeOpenFailed'), 'error')
    }
  }

  hideLoading()
  markAppReady()
}

// 初期化（認証・着地・ツリー読み込み）が終わり、操作できる状態になった印。E2E テストはこれで待ち合わせる。
// ツリー切替のアニメーション中は操作を受け付けないので、その終了も待つ
async function markAppReady() {
  await window.ZeetaTreeRail?.whenRevealTransitionDone?.()
  document.documentElement.dataset.appReady = 'true'
}

// 左バーから開いているツリーの名前を変えたとき、ヘッダーの表示も追従させる
document.addEventListener('zeeta:current-tree-updated', (event) => {
  const updatedTree = event.detail?.tree
  if (!updatedTree || updatedTree.id !== currentTreeId) return
  currentTree = { ...currentTree, name: updatedTree.name, description: updatedTree.description }
  const title = document.getElementById('tree-header-title')
  if (title) title.textContent = updatedTree.name
})

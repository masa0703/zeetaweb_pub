/**
 * バージョン不一致チェック。
 *
 * タブ／ウィンドウがアクティブになったときに GET /api/version を叩き、
 * サーバの現在ビルド日時（MMDD-HHMM）とこのページが読み込んだビルド日時
 * （window.__BUILD_STAMP__、サーバがHTMLに直埋め）を比較する。
 * 不一致ならヘッダーに update バッジを表示する（ダイアログは自動では出さない）。
 * バッジをクリックするとページ内ダイアログでリロードを確認し、
 * 「リロードする」でリロードする。選択中ノードがあればリロード後も同じノードを開く。
 *
 * 発火タイミングは2系統:
 *   - visibilitychange: タブ切替・最小化からの復帰（タブの可視性が変わる場合）
 *   - window focus:     別アプリからの復帰など、可視性が変わらないアクティベート
 *     （visibilitychange はアプリ切替では発火しないため。Page Visibility API の仕様）
 *
 * ネイティブ confirm() を使わない理由:
 *   Chrome はタブ復帰（visibilitychange）直後の JS ダイアログを黙って抑止することがあり、
 *   実ブラウザで確認ダイアログが出ない不具合の原因になった（2026-09-26 実機で再現）。
 *
 * バッジの差し込み先:
 *   マイツリー画面・ノード編集画面それぞれのヘッダーに用意された共通スロット
 *   #update-badge-slot を見るだけで、ページの違いは意識しない。
 *   ノード編集画面はツリー切替等でヘッダーDOMごと作り直されるため、
 *   再描画完了時に発火する 'zeeta:tree-header-rendered' イベントでバッジを再挿入する。
 *
 * 負荷対策:
 *   - チェックは最短1分間隔（タブ切り替え連打で叩かれないように間引く）
 *
 * 落ちても何も壊さないようベストエフォート。fetch 失敗・応答不正は無視する。
 * ページ読み込み自体ではチェックしない（visibilitychange / focus のみが起点。
 * バッジ用のロード時往復は f605ee7 で廃止済みのため）。
 * ロード直後の初期クールダウンは撤廃（バッジ方式では見過ごしても実害が小さいため。2026-09-26）。
 * テストからは window.__VERSION_CHECK_CONFIG__ で間隔を制御できる。
 */
;(function () {
  'use strict'

  const CHECK_THROTTLE_MS = 60 * 1000 // チェック最短間隔
  const DIALOG_SELECTOR = '[data-version-reload-dialog]'
  const BADGE_SLOT_ID = 'update-badge-slot'
  const BADGE_ID = 'update-badge'

  const config = window.__VERSION_CHECK_CONFIG__ || {}
  const throttleMs = typeof config.throttleMs === 'number' ? config.throttleMs : CHECK_THROTTLE_MS

  const myStamp = window.__BUILD_STAMP__
  if (typeof myStamp !== 'string') return // 埋め込みの無いページでは何もしない

  let lastCheckedAt = 0
  let checking = false
  let updateAvailable = false

  const MESSAGES = {
    ja: { text: '新しいバージョンがリリースされています。リロードしますか？', reload: 'リロードする', later: '後で', badge: 'new ver.', badgeLabel: '新しいバージョンがあります' },
    en: { text: 'A new version is available. Reload now?', reload: 'Reload now', later: 'Later', badge: 'new ver.', badgeLabel: 'A new version is available' }
  }
  const message = () => MESSAGES[document.documentElement.lang] || MESSAGES.en

  /**
   * リロード先を決める。選択中ノードがあれば復元できるURLへ、
   * 無ければ通常のリロード。マイツリー画面など selectedNodeId / buildNodeShareUrl が
   * 存在しないページでは通常のリロードにフォールバックする。
   */
  const reload = () => {
    if (typeof selectedNodeId !== 'undefined' && selectedNodeId && typeof buildNodeShareUrl === 'function') {
      const url = buildNodeShareUrl(selectedNodeId)
      if (url) {
        // リロード後も同じパス（ツリー上の表示位置）で開けるよう、選択位置を残す
        if (typeof rememberSelectionForReload === 'function') rememberSelectionForReload()
        window.location.href = url
        return
      }
    }
    window.location.reload()
  }

  /**
   * ページ内ダイアログを表示する。既に出ている場合は何もしない。
   * 「リロードする」でリロード、「後で」/Escape で閉じる（バッジは残したまま）。
   */
  const showDialog = () => {
    if (document.querySelector(DIALOG_SELECTOR)) return
    const t = message()

    const overlay = document.createElement('div')
    overlay.setAttribute('data-version-reload-dialog', '')
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-modal', 'true')
    overlay.setAttribute('aria-label', t.text)
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(0,0,0,0.4);font-family:system-ui,-apple-system,sans-serif'

    const card = document.createElement('div')
    card.style.cssText =
      'max-width:360px;margin:16px;padding:20px 24px;background:#fff;color:#1a1a1a;border-radius:12px;' +
      'box-shadow:0 8px 32px rgba(0,0,0,0.25);font-size:14px;line-height:1.6'

    const text = document.createElement('p')
    text.textContent = t.text
    text.style.cssText = 'margin:0 0 16px'

    const buttonRow = document.createElement('div')
    buttonRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end'

    const laterButton = document.createElement('button')
    laterButton.type = 'button'
    laterButton.textContent = t.later
    laterButton.style.cssText =
      'padding:8px 16px;border-radius:8px;border:1px solid #ccc;background:#fff;color:#1a1a1a;' +
      'font-size:14px;cursor:pointer'

    const reloadButton = document.createElement('button')
    reloadButton.type = 'button'
    reloadButton.textContent = t.reload
    reloadButton.style.cssText =
      'padding:8px 16px;border-radius:8px;border:none;background:#1a1a1a;color:#fff;' +
      'font-size:14px;cursor:pointer'

    const close = () => {
      overlay.remove()
      document.removeEventListener('keydown', onKeydown)
    }
    const onKeydown = (e) => {
      if (e.key === 'Escape') close()
    }

    reloadButton.addEventListener('click', reload)
    laterButton.addEventListener('click', close)

    buttonRow.append(laterButton, reloadButton)
    card.append(text, buttonRow)
    overlay.append(card)
    document.body.append(overlay)
    document.addEventListener('keydown', onKeydown)
    reloadButton.focus()
  }

  /**
   * #update-badge-slot にバッジを差し込む。スロットが無いページ、
   * 既にバッジがあるページでは何もしない（冪等）。
   */
  const renderBadge = () => {
    const slot = document.getElementById(BADGE_SLOT_ID)
    if (!slot || document.getElementById(BADGE_ID)) return
    const t = message()

    const badge = document.createElement('button')
    badge.id = BADGE_ID
    badge.type = 'button'
    badge.textContent = t.badge
    badge.setAttribute('aria-label', t.badgeLabel)
    badge.style.cssText =
      'background:#ec4899;color:#fff;border:none;border-radius:9999px;padding:0.15rem 0.6rem;' +
      'font-size:0.7rem;font-weight:600;line-height:1.4;cursor:pointer;white-space:nowrap'
    badge.addEventListener('click', showDialog)

    slot.append(badge)
  }

  const setUpdateAvailable = () => {
    if (updateAvailable) return
    updateAvailable = true
    renderBadge()
  }

  const checkVersion = async () => {
    if (checking) return
    const now = Date.now()
    if (now - lastCheckedAt < throttleMs) return
    lastCheckedAt = now
    checking = true
    try {
      const res = await fetch('/api/version', { headers: { Accept: 'application/json' } })
      if (!res.ok) return
      const data = await res.json()
      if (!data || typeof data.build !== 'string') return
      if (data.build === myStamp) return
      setUpdateAvailable()
    } catch {
      // ベストエフォート。オフライン等では何もしない
    } finally {
      checking = false
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkVersion()
  })
  // 別アプリからの復帰（可視性が変わらないアクティベート）。スロットルが重複を吸収する
  window.addEventListener('focus', checkVersion)
  // ノード編集画面はツリー切替等でヘッダーDOMごと作り直されるため、再描画のたびにバッジを復元する
  document.addEventListener('zeeta:tree-header-rendered', () => {
    if (updateAvailable) renderBadge()
  })
})()

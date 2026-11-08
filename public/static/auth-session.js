/**
 * Shared session handling for authenticated pages.
 * Redirects once when an API request reports that the session is no longer valid.
 */
(function () {
  const REDIRECT_DELAY_MS = 1500
  const CONNECTION_LOST_TOAST_DURATION_MS = 10000
  const LOGIN_PATH = '/login.html'
  let redirectScheduled = false
  let connectionLostNotified = false

  function getSessionExpiredMessage() {
    return t('common.sessionExpired')
  }

  function getConnectionLostMessage() {
    return t('common.connectionLost')
  }

  function getCurrentRedirectPath() {
    return `${window.location.pathname}${window.location.search}${window.location.hash}`
  }

  function getLoginUrl() {
    const redirect = getCurrentRedirectPath()
    return `${LOGIN_PATH}?redirect=${encodeURIComponent(redirect)}`
  }

  // showToast が無い・使えない場合の
  // 最小限の可視フォールバック。トースト同様、一定時間で消す。
  function showFallbackNotice(message, autoRemoveMs) {
    const notice = document.createElement('div')
    notice.textContent = message
    notice.style.cssText = [
      'position: fixed',
      'top: 16px',
      'left: 50%',
      'transform: translateX(-50%)',
      'z-index: 10000',
      'padding: 12px 16px',
      'border-radius: 8px',
      'background: #c53030',
      'color: #fff',
      'font-size: 14px',
      'font-weight: 600',
      'box-shadow: 0 10px 25px rgba(0, 0, 0, 0.2)'
    ].join(';')
    document.body.appendChild(notice)
    if (autoRemoveMs) {
      setTimeout(() => notice.remove(), autoRemoveMs)
    }
    return notice
  }

  function showSessionExpiredMessage() {
    const message = getSessionExpiredMessage()
    if (typeof window.showToast === 'function') {
      window.showToast(message, 'error', REDIRECT_DELAY_MS)
      return
    }
    // ログイン画面へ遷移するため自動削除は不要（ページごと消える）
    showFallbackNotice(message)
  }

  function showConnectionLostMessage() {
    const message = getConnectionLostMessage()
    if (typeof window.showToast === 'function') {
      window.showToast(message, 'error', CONNECTION_LOST_TOAST_DURATION_MS)
      return
    }
    // 自動遷移しないため、トーストと同じ猶予で消す（消さないと画面に残り続ける）
    showFallbackNotice(message, CONNECTION_LOST_TOAST_DURATION_MS)
  }

  function stopAuthDependentPolling() {
    if (typeof window.stopNotificationPolling === 'function') {
      window.stopNotificationPolling()
    }
  }

  function persistUnsavedEditorDraft() {
    try {
      window.ZeetaEditorDrafts?.resetDraftPrompts?.()
      window.ZeetaEditorDrafts?.persistCurrentDraft?.()
    } catch (error) {
      console.error('Failed to persist editor draft before reauthentication:', error)
    }
  }

  // AbortController によるキャンセルは「レスポンスが無い」という点で
  // ネットワークエラーと区別が付かない。アプリは現状どこもリクエストを
  // キャンセルしていない（2026-09-22 時点、grep で AbortController /
  // CancelToken の使用箇所なし）が、将来キャンセルが入ったときに
  // 「キャンセルしただけなのに通信断トーストが出る」誤検知を防ぐため
  // 先回りでガードする
  function isCancellationError(error) {
    if (!error) return false
    if (window.axios?.isCancel?.(error)) return true
    if (error.code === 'ERR_CANCELED') return true
    if (error.name === 'AbortError') return true
    return false
  }

  function isZeetaAuthRequest(input) {
    try {
      const rawUrl = input instanceof Request ? input.url : String(input || '')
      const url = new URL(rawUrl, window.location.href)
      return url.origin === window.location.origin && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/'))
    } catch {
      return false
    }
  }

  function handleUnauthorized() {
    if (redirectScheduled) {
      return true
    }

    redirectScheduled = true
    stopAuthDependentPolling()
    persistUnsavedEditorDraft()
    showSessionExpiredMessage()

    setTimeout(() => {
      window.location.href = getLoginUrl()
    }, REDIRECT_DELAY_MS)

    return true
  }

  // レスポンスを受け取れずに失敗した同一オリジンのAPI/認証リクエスト。
  // Cloudflare Access のセッション切れ（別オリジンへの302）は、ブラウザが
  // その302を読めずXHR/fetchがネットワークエラーとして落ちるため、
  // handleUnauthorized()（HTTP 401確定）では拾えない。原因を断定できないため
  // 自動リロードはせず、トースト表示と下書き保護のみ行う（2026-09-22）。
  function handleConnectionLost() {
    if (redirectScheduled || connectionLostNotified) {
      return
    }

    connectionLostNotified = true
    persistUnsavedEditorDraft()
    showConnectionLostMessage()
  }

  function noteZeetaRequestSucceeded(url) {
    if (isZeetaAuthRequest(url)) {
      connectionLostNotified = false
    }
  }

  function installFetchInterceptor() {
    const originalFetch = window.fetch
    if (typeof originalFetch !== 'function' || originalFetch.__zeetaAuthWrapped) {
      return
    }

    function zeetaAuthFetch(...args) {
      return originalFetch.apply(this, args).then(
        (response) => {
          if (response && response.status === 401 && isZeetaAuthRequest(args[0])) {
            handleUnauthorized()
          } else {
            noteZeetaRequestSucceeded(args[0])
          }
          return response
        },
        (error) => {
          if (isZeetaAuthRequest(args[0]) && !isCancellationError(error)) {
            handleConnectionLost()
          }
          throw error
        }
      )
    }

    zeetaAuthFetch.__zeetaAuthWrapped = true
    window.fetch = zeetaAuthFetch
  }

  function installAxiosInterceptor() {
    if (!window.axios || !window.axios.interceptors || window.axios.__zeetaAuthWrapped) {
      return
    }

    window.axios.interceptors.response.use(
      response => {
        noteZeetaRequestSucceeded(response.config?.url)
        return response
      },
      error => {
        if (isZeetaAuthRequest(error.config?.url)) {
          if (error.response && error.response.status === 401) {
            handleUnauthorized()
          } else if (!error.response && !isCancellationError(error)) {
            handleConnectionLost()
          }
        }
        return Promise.reject(error)
      }
    )
    window.axios.__zeetaAuthWrapped = true
  }

  window.ZeetaAuth = {
    get SESSION_EXPIRED_MESSAGE() { return getSessionExpiredMessage() },
    handleUnauthorized,
    isRedirectScheduled: () => redirectScheduled,
    installAxiosInterceptor
  }

  installFetchInterceptor()
  installAxiosInterceptor()
})()

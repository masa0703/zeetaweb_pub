/**
 * MCP OAuth 同意画面 / エラー画面のレンダリング
 *
 * 外部CSS・外部フォントに依存しない自己完結HTMLを返す。
 * テーマは /static/theme.js・/static/dark.css で適用する。
 * 同意画面も同一オリジンのテーマスクリプトだけを CSP で許可する。
 * クライアント名・ツリー名・redirect_uri はすべてエスケープして表示する。
 */

import { MCP_OAUTH_SCOPE_WRITE, scopeIncludes } from './mcp-oauth'
import type { Role } from '../utils/permissions'
import { serverT, type Locale } from '../utils/i18n'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const BASE_STYLE = `
  :root {
    --surface: #ffffff;
    --surface-muted: #f5f6f8;
    --border: #e3e5ea;
    --text: #1c1f26;
    --text-muted: #5b6472;
    --accent: #4f46e5;
    --accent-strong: #4338ca;
    --danger: #b42318;
    --radius: 14px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px 20px;
    background: radial-gradient(circle at 15% 0%, #eef0ff 0%, #f7f8fa 45%, #f2f3f6 100%);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", "Segoe UI", sans-serif;
    line-height: 1.7;
  }
  .card {
    width: 100%;
    max-width: 480px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 32px;
    box-shadow: 0 18px 48px -24px rgba(28, 31, 38, 0.35);
  }
  .brand {
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--accent);
    margin: 0 0 12px;
  }
  h1 {
    font-size: 1.4rem;
    line-height: 1.45;
    margin: 0 0 8px;
    letter-spacing: -0.01em;
  }
  .lead { margin: 0 0 24px; color: var(--text-muted); font-size: 0.92rem; }
  dl {
    margin: 0 0 24px;
    padding: 18px;
    background: var(--surface-muted);
    border-radius: 10px;
    border: 1px solid var(--border);
  }
  dl div + div { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border); }
  dt { font-size: 0.72rem; font-weight: 700; letter-spacing: 0.08em; color: var(--text-muted); text-transform: uppercase; }
  dd { margin: 4px 0 0; font-size: 0.95rem; word-break: break-all; }
  .scope-list { margin: 0; padding-left: 1.1em; font-size: 0.95rem; }
  .note {
    font-size: 0.8rem;
    color: var(--text-muted);
    margin: 0 0 24px;
    padding-left: 12px;
    border-left: 3px solid var(--border);
  }
  form { display: flex; gap: 12px; flex-direction: row-reverse; }
  button {
    flex: 1;
    font: inherit;
    font-weight: 600;
    padding: 12px 16px;
    border-radius: 10px;
    border: 1px solid transparent;
    cursor: pointer;
    transition: background-color 140ms ease, border-color 140ms ease, transform 140ms ease;
  }
  button:active { transform: translateY(1px); }
  .approve { background: var(--accent); color: #fff; }
  .approve:hover { background: var(--accent-strong); }
  .deny { background: #fff; color: var(--text-muted); border-color: var(--border); }
  .deny:hover { border-color: #c9ccd4; color: var(--text); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .error-title { color: var(--danger); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85em; }
  a { color: var(--accent); }
  /* Dark theme（<html class="theme-dark">時に有効。判定は /static/theme.js） */
  html.theme-dark {
    --surface: #1f2937;
    --surface-muted: #111827;
    --border: #374151;
    --text: #f3f4f6;
    --text-muted: #9ca3af;
    --accent: #818cf8;
    --accent-strong: #a5b4fc;
    --danger: #fca5a5;
  }
  html.theme-dark body { background: radial-gradient(circle at 15% 0%, #1a2040 0%, #0f172a 45%, #111827 100%); }
  html.theme-dark .card { box-shadow: 0 18px 48px -24px rgba(0, 0, 0, 0.65); }
  html.theme-dark .approve { background: #4f46e5; }
  html.theme-dark .approve:hover { background: #4338ca; }
  html.theme-dark .deny { background: transparent; }
  html.theme-dark .deny:hover { border-color: #4b5563; color: var(--text); }
`

export type ConsentPageParams = {
  requestId: string
  clientName: string | null
  clientUri: string | null
  treeName: string
  role: Role
  scope: string
  redirectUri: string
  userEmail: string
}

function roleLabel(locale: Locale, role: Role): string {
  if (role === 'owner') return serverT(locale, 'mypage.roleOwner')
  if (role === 'editor') return serverT(locale, 'mypage.roleEditor')
  return serverT(locale, 'mypage.roleViewer')
}

export function renderConsentPage(params: ConsentPageParams, locale: Locale): string {
  const canWrite = scopeIncludes(params.scope, MCP_OAUTH_SCOPE_WRITE)
  const clientLabel = params.clientName && params.clientName.trim() !== ''
    ? params.clientName
    : serverT(locale, 'consent.unnamedClient')
  const redirectHost = (() => {
    try {
      return new URL(params.redirectUri).host
    } catch {
      return params.redirectUri
    }
  })()
  const isLoopbackRedirect = (() => {
    try {
      const hostname = new URL(params.redirectUri).hostname
      return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
    } catch {
      return false
    }
  })()

  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(serverT(locale, 'consent.pageTitle'))}</title>
<link rel="stylesheet" href="/static/dark.css">
<script src="/static/theme.js"></script>
<style>${BASE_STYLE}</style>
</head>
<body>
  <main class="card">
    <p class="brand">${serverT(locale, 'consent.brand')}</p>
    <h1>${escapeHtml(serverT(locale, 'consent.questionBeforeBreak', { client: clientLabel }))}<br>${serverT(locale, 'consent.questionAfterBreak')}</h1>
    <p class="lead">${serverT(locale, 'consent.description')}</p>
    ${!isLoopbackRedirect ? `<p class="note" style="color:var(--danger);font-weight:700">${escapeHtml(serverT(locale, 'consent.externalRedirectWarning', { host: redirectHost }))}</p>` : ''}

    <dl>
      <div>
        <dt>${serverT(locale, 'consent.clientLabel')}</dt>
        <dd>${escapeHtml(clientLabel)}</dd>
      </div>
      <div>
        <dt>${serverT(locale, 'consent.treeLabel')}</dt>
        <dd>${escapeHtml(params.treeName)}</dd>
      </div>
      <div>
        <dt>${serverT(locale, 'consent.accountAndRoleLabel')}</dt>
        <dd>${escapeHtml(params.userEmail)} — ${roleLabel(locale, params.role)}</dd>
      </div>
      <div>
        <dt>${serverT(locale, 'consent.grantedPermissionsLabel')}</dt>
        <dd>
          <ul class="scope-list">
            <li>${serverT(locale, 'consent.readScopeBeforeCode')}<code>mcp:read</code>${serverT(locale, 'consent.scopeAfterCode')}</li>
            ${canWrite
              ? `<li>${serverT(locale, 'consent.writeScopeBeforeCode')}<code>mcp:write</code>${serverT(locale, 'consent.scopeAfterCode')}</li>`
              : `<li style="color:var(--text-muted)">${serverT(locale, 'consent.readOnlyScope')}</li>`}
          </ul>
        </dd>
      </div>
      <div>
        <dt>${serverT(locale, 'consent.redirectLabel')}</dt>
        <dd>${escapeHtml(redirectHost)}</dd>
      </div>
    </dl>

    <p class="note">${serverT(locale, 'consent.permissionNote')}</p>

    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="request_id" value="${escapeHtml(params.requestId)}">
      <button class="approve" type="submit" name="decision" value="approve">${serverT(locale, 'consent.approve')}</button>
      <button class="deny" type="submit" name="decision" value="deny">${serverT(locale, 'consent.deny')}</button>
    </form>
  </main>
</body>
</html>`
}

export function renderOAuthErrorPage(params: {
  titleKey: string
  messageKey: string
  detailKey?: string
}, locale: Locale): string {
  const title = serverT(locale, params.titleKey)
  const message = serverT(locale, params.messageKey)
  const detail = params.detailKey ? serverT(locale, params.detailKey) : undefined

  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)} - Zeeta</title>
<link rel="stylesheet" href="/static/dark.css">
<script src="/static/theme.js"></script>
<style>${BASE_STYLE}</style>
</head>
<body>
  <main class="card">
    <p class="brand">${serverT(locale, 'consent.brand')}</p>
    <h1 class="error-title">${escapeHtml(title)}</h1>
    <p class="lead">${escapeHtml(message)}</p>
    ${detail ? `<p class="note">${escapeHtml(detail)}</p>` : ''}
    <p style="font-size:0.85rem;margin:0"><a href="/help?tab=mcp">${serverT(locale, 'consent.clientSetupLink')}</a></p>
  </main>
</body>
</html>`
}

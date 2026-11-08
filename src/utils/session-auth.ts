import type { JWTPayload } from './jwt.ts'

export type ActiveSession = {
  id: string
  user_id: number
}

/**
 * Resolve a JWT to a live session and existing user.
 *
 * session_id を持つトークンは token 値の一致を条件にしない。近接期限のセッションは
 * リクエストごとに token が回転するため、並行リクエストでは回転前の token を持つ側が
 * 一律 401 になり、有効なセッションのユーザーがログアウトさせられる。
 * 失効の即時反映は sessions 行の存在と expires_at で担保する。
 */
export async function findActiveSession(
  db: D1Database,
  token: string,
  payload: JWTPayload,
): Promise<ActiveSession | null> {
  const lookup = payload.session_id
    ? db.prepare(
        `SELECT s.id, s.user_id
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.id = ? AND s.user_id = ?
           AND unixepoch(s.expires_at) > unixepoch('now')`,
      ).bind(payload.session_id, payload.user_id)
    : db.prepare(
        `SELECT s.id, s.user_id
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token = ? AND s.user_id = ?
           AND unixepoch(s.expires_at) > unixepoch('now')`,
      ).bind(token, payload.user_id)

  return lookup.first<ActiveSession>()
}

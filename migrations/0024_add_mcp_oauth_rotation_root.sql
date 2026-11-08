-- refresh token の rotation chain を識別する列を追加する。
--
-- 目的: 1つの rotation chain に生存 refresh token が同時に2本存在する状態を防ぐ。
-- 並行リクエストが両方 `revoked_at IS NULL` を通過すると family が分岐し、
-- 片方が「古い refresh のコピー」として残って後の再利用検知を踏む火種になっていた。
--
-- 発行後に `rotation_root_id` が同じ、かつ自分より小さい id の refresh を失効させることで
-- 「常に最新の1本だけが生きる」を競合に強い形で保証する（id 昇順の単調な失効なので
-- 並行実行しても相互に殺し合って0本になることがない）。

ALTER TABLE mcp_oauth_tokens ADD COLUMN rotation_root_id INTEGER;

-- 既存行の backfill。真の root ではなく直近の親を root として埋めるが、
-- 以降の rotation はこの値を継承していくため chain 内で値は一致する。
UPDATE mcp_oauth_tokens
SET rotation_root_id = COALESCE(rotated_from_token_id, id)
WHERE token_type = 'refresh' AND rotation_root_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_rotation_root ON mcp_oauth_tokens(rotation_root_id);

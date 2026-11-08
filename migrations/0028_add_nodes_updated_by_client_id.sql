-- node detail の履歴一覧「現在行」でMCPクライアント名を表示するため、
-- 最終更新がどのMCPクライアント経由かを nodes 自身に保持する。
-- 既存行は NULL（= UI経由の更新と同じ扱い）。
ALTER TABLE nodes ADD COLUMN updated_by_client_id TEXT NULL;

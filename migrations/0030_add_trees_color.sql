-- ツリーの丸アイコンの背景色。NULL は従来どおりツリーIDから自動で決める。
-- 値は public/static/tree-rail.js の CHIP_COLORS のキー名（indigo / sky / ...）。
ALTER TABLE trees ADD COLUMN color TEXT;

-- Add permission preset to API keys for MCP access control

ALTER TABLE api_keys
ADD COLUMN permission_preset TEXT NOT NULL DEFAULT 'full_access';

UPDATE api_keys
SET permission_preset = 'full_access'
WHERE permission_preset IS NULL OR permission_preset = '';

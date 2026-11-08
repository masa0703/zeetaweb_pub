-- Migration: Add Multi-User Support Tables
-- Description: Creates tables for users, trees, permissions, invitations, and notifications
-- Date: 2026-01-26

-- ================================================================
-- 1. CREATE NEW TABLES
-- ================================================================

-- Users table: Store authenticated users from OAuth providers
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  oauth_provider TEXT NOT NULL,           -- 'google' or 'github'
  oauth_provider_id TEXT NOT NULL,        -- OAuth provider's user ID
  email TEXT NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_login_at DATETIME,
  UNIQUE(oauth_provider, oauth_provider_id)
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_oauth ON users(oauth_provider, oauth_provider_id);

-- Trees table: Workspace/tree containers
CREATE TABLE IF NOT EXISTS trees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  owner_user_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_trees_owner ON trees(owner_user_id);
CREATE INDEX idx_trees_updated ON trees(updated_at);

-- Tree members table: User access to trees with role-based permissions
CREATE TABLE IF NOT EXISTS tree_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tree_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner', 'editor', 'viewer')),
  added_by_user_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tree_id) REFERENCES trees(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (added_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(tree_id, user_id)
);

CREATE INDEX idx_tree_members_tree ON tree_members(tree_id);
CREATE INDEX idx_tree_members_user ON tree_members(user_id);
CREATE INDEX idx_tree_members_role ON tree_members(tree_id, role);

-- Invitations table: Manage pending invitations to trees
CREATE TABLE IF NOT EXISTS invitations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tree_id INTEGER NOT NULL,
  inviter_user_id INTEGER NOT NULL,
  invitee_email TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('editor', 'viewer')),
  token TEXT NOT NULL UNIQUE,              -- Unique invitation token
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'accepted', 'declined', 'expired')),
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  accepted_at DATETIME,
  FOREIGN KEY (tree_id) REFERENCES trees(id) ON DELETE CASCADE,
  FOREIGN KEY (inviter_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_invitations_email ON invitations(invitee_email);
CREATE INDEX idx_invitations_token ON invitations(token);
CREATE INDEX idx_invitations_status ON invitations(status, expires_at);

-- Notifications table: Store in-app notifications for users
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,                      -- 'invitation', 'tree_shared', etc.
  title TEXT NOT NULL,
  message TEXT,
  link TEXT,                               -- Link to relevant page
  is_read INTEGER DEFAULT 0,               -- 0 = unread, 1 = read
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_notifications_user ON notifications(user_id, is_read);
CREATE INDEX idx_notifications_created ON notifications(created_at);

-- Sessions table: Manage user sessions (JWT-based)
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,                     -- Session ID (UUID)
  user_id INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,              -- JWT or session token
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_activity_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- ================================================================
-- 2. MIGRATE EXISTING NODES TABLE
-- ================================================================

-- SQLite doesn't support ALTER TABLE ADD FOREIGN KEY directly
-- We need to create a new table, copy data, and rename

-- Create new nodes table with multi-user columns
CREATE TABLE nodes_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tree_id INTEGER NOT NULL,                -- NEW: Workspace isolation
  title TEXT NOT NULL,
  content TEXT,
  author TEXT NOT NULL,                    -- Keep for backward compatibility
  created_by_user_id INTEGER,              -- NEW: Reference to user who created
  updated_by_user_id INTEGER,              -- NEW: Reference to last editor
  version INTEGER DEFAULT 1,               -- NEW: Optimistic locking
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  root_position INTEGER DEFAULT 0,
  FOREIGN KEY (tree_id) REFERENCES trees(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- ================================================================
-- 3. INSERT DEFAULT DATA
-- ================================================================

-- Create default system admin user (for migration)
INSERT INTO users (oauth_provider, oauth_provider_id, email, display_name)
VALUES ('system', 'admin', 'admin@zeeta.local', 'System Admin');

-- Create default tree (for existing data)
INSERT INTO trees (name, description, owner_user_id)
VALUES ('Default Tree', 'Migrated from single-user data', 1);

-- ================================================================
-- 4. MIGRATE EXISTING NODE DATA
-- ================================================================

-- Copy existing nodes to nodes_new with default tree_id = 1
INSERT INTO nodes_new (id, tree_id, title, content, author, created_by_user_id, updated_by_user_id, version, created_at, updated_at, root_position)
SELECT id, 1, title, content, author, 1, 1, 1, created_at, updated_at, COALESCE(root_position, 0)
FROM nodes;

-- Drop old nodes table
DROP TABLE nodes;

-- Rename new table to nodes
ALTER TABLE nodes_new RENAME TO nodes;

-- Recreate indexes for nodes table
CREATE INDEX idx_nodes_tree ON nodes(tree_id);
CREATE INDEX idx_nodes_tree_root ON nodes(tree_id, root_position);
CREATE INDEX idx_nodes_created_at ON nodes(created_at);
CREATE INDEX idx_nodes_root_position ON nodes(root_position);

-- ================================================================
-- 5. ADD DEFAULT ADMIN AS TREE OWNER
-- ================================================================

-- Add default admin as owner of default tree in tree_members
INSERT INTO tree_members (tree_id, user_id, role, added_by_user_id)
VALUES (1, 1, 'owner', 1);

-- ================================================================
-- MIGRATION COMPLETE
-- ================================================================
-- All existing nodes are now in "Default Tree" (tree_id = 1)
-- Default admin user (user_id = 1) is the owner
-- Existing author field is preserved for historical records
-- New user registrations will create proper user records
-- ================================================================

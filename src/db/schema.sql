CREATE TABLE IF NOT EXISTS channels (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    parent_id     TEXT REFERENCES channels(id) ON DELETE CASCADE,
    password      TEXT,
    max_users     INTEGER,
    description   TEXT DEFAULT '',
    is_default    INTEGER NOT NULL DEFAULT 0,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    is_temporary  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bans (
    id         TEXT PRIMARY KEY,
    ip         TEXT,
    reason     TEXT DEFAULT '',
    created_at INTEGER NOT NULL,
    expires_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_bans_ip ON bans(ip);

CREATE TABLE IF NOT EXISTS messages (
    id               TEXT PRIMARY KEY,
    channel_id       TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    content          TEXT NOT NULL,
    reply_to         TEXT,
    reply_to_nickname TEXT,
    reply_to_user_id TEXT,
    reply_to_content TEXT,
    created_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_channel
    ON messages(channel_id, created_at);

CREATE TABLE IF NOT EXISTS dm_messages (
    id              TEXT PRIMARY KEY,
    from_user_id    TEXT NOT NULL,
    to_user_id      TEXT NOT NULL,
    content         TEXT NOT NULL,
    created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dm_messages_convo
    ON dm_messages(from_user_id, to_user_id, created_at);

CREATE TABLE IF NOT EXISTS identities (
    user_id     TEXT PRIMARY KEY,
    public_key  TEXT NOT NULL UNIQUE,
    fingerprint TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    last_seen_at INTEGER
);

CREATE TABLE IF NOT EXISTS server_messages (
    id         TEXT PRIMARY KEY,
    type       TEXT NOT NULL DEFAULT 'message',
    user_id    TEXT,
    client_id  TEXT,
    badge      TEXT,
    content    TEXT NOT NULL,
    reply_to   TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_server_messages_time
    ON server_messages(created_at);

CREATE TABLE IF NOT EXISTS files (
    id         TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    client_id  TEXT,
    nickname   TEXT NOT NULL,
    filename   TEXT NOT NULL,
    size       INTEGER NOT NULL,
    mime_type  TEXT NOT NULL DEFAULT 'application/octet-stream',
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_tokens (
    token       TEXT PRIMARY KEY,
    role        TEXT NOT NULL DEFAULT 'admin',
    user_id     TEXT,
    created_at  INTEGER NOT NULL,
    redeemed_at INTEGER,
    expires_at  INTEGER
);

CREATE TABLE IF NOT EXISTS roles (
  id     TEXT PRIMARY KEY,
  name   TEXT NOT NULL UNIQUE,
  badge  TEXT
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id    TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY (role_id, permission)
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS channel_allowed_roles (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  role_id    TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (channel_id, role_id)
);

CREATE TABLE IF NOT EXISTS reactions (
  id         TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  emoji      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(message_id, user_id, emoji)
);

CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id);

CREATE TABLE IF NOT EXISTS pinned_messages (
  message_id TEXT NOT NULL,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  pinned_by_user_id TEXT,
  pinned_at  INTEGER NOT NULL,
  PRIMARY KEY (message_id, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_pinned_messages_channel ON pinned_messages(channel_id, pinned_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id         TEXT PRIMARY KEY,
  action     TEXT NOT NULL,
  actor_user_id TEXT,
  actor_nickname TEXT,
  target_user_id TEXT,
  target_nickname TEXT,
  details    TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_log_time ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_user_id, created_at DESC);

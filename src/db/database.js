import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import logger from '../logger.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ALL_PERMISSIONS } from '../permissions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const dataDir = join(__dirname, '..', '..', 'data');
const dbPath = join(dataDir, 'gimodi.db');

mkdirSync(dataDir, { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
db.exec(schema);

const count = db.prepare('SELECT COUNT(*) as c FROM channels').get();
if (count.c === 0) {
  db.prepare(`INSERT INTO channels (id, name, is_default, sort_order) VALUES ('lobby', 'Lobby', 1, 0)`).run();
  logger.info('Created default Lobby channel.');
}

try {
  db.prepare('SELECT badge FROM roles LIMIT 0').get();
} catch {
  db.exec('ALTER TABLE roles ADD COLUMN badge TEXT');
}
try {
  db.prepare('SELECT badge FROM messages LIMIT 0').get();
} catch {
  db.exec('ALTER TABLE messages ADD COLUMN badge TEXT');
}
try {
  db.prepare('SELECT position FROM roles LIMIT 0').get();
} catch {
  db.exec('ALTER TABLE roles ADD COLUMN position INTEGER NOT NULL DEFAULT 0');
}

db.prepare("INSERT OR IGNORE INTO roles (id, name, badge, position) VALUES ('admin', 'Admin', 'Admin', 0)").run();
db.prepare("INSERT OR IGNORE INTO roles (id, name, badge, position) VALUES ('user', 'User', NULL, 1)").run();

for (const perm of ALL_PERMISSIONS) {
  db.prepare("INSERT OR IGNORE INTO role_permissions (role_id, permission) VALUES ('admin', ?)").run(perm);
}

try {
  db.prepare('SELECT link_previews FROM messages LIMIT 0').get();
} catch {
  db.exec('ALTER TABLE messages ADD COLUMN link_previews TEXT');
}
try {
  db.prepare('SELECT client_id FROM messages LIMIT 0').get();
} catch {
  db.exec('ALTER TABLE messages ADD COLUMN client_id TEXT');
}
try {
  db.prepare('SELECT user_id FROM messages LIMIT 0').get();
} catch {
  db.exec('ALTER TABLE messages ADD COLUMN user_id TEXT');
}
try {
  db.prepare('SELECT user_id FROM files LIMIT 0').get();
} catch {
  db.exec('ALTER TABLE files ADD COLUMN user_id TEXT');
}
try {
  db.prepare('SELECT nickname FROM messages LIMIT 0').get();
  db.exec('ALTER TABLE messages DROP COLUMN nickname');
} catch {
  /* column already removed */
}
try {
  db.prepare('SELECT moderated FROM channels LIMIT 0').get();
} catch {
  db.exec('ALTER TABLE channels ADD COLUMN moderated INTEGER NOT NULL DEFAULT 0');
}
try {
  db.prepare('SELECT type FROM channels LIMIT 0').get();
} catch {
  db.exec("ALTER TABLE channels ADD COLUMN type TEXT NOT NULL DEFAULT 'channel'");
}
try {
  db.prepare('SELECT expires_at FROM admin_tokens LIMIT 0').get();
} catch {
  db.exec('ALTER TABLE admin_tokens ADD COLUMN expires_at INTEGER');
}
try {
  db.prepare('SELECT edited_at FROM messages LIMIT 0').get();
} catch {
  db.exec('ALTER TABLE messages ADD COLUMN edited_at INTEGER');
}
try {
  db.prepare('SELECT is_temporary FROM channels LIMIT 0').get();
} catch {
  db.exec('ALTER TABLE channels ADD COLUMN is_temporary INTEGER NOT NULL DEFAULT 0');
}
try {
  db.prepare('SELECT user_id FROM bans LIMIT 0').get();
} catch {
  db.exec('ALTER TABLE bans ADD COLUMN user_id TEXT');
}
try {
  db.prepare('SELECT type FROM server_messages LIMIT 0').get();
} catch {
  db.exec("ALTER TABLE server_messages ADD COLUMN type TEXT NOT NULL DEFAULT 'message'");
}
try {
  db.prepare('SELECT reply_to FROM messages LIMIT 0').get();
} catch {
  db.exec('ALTER TABLE messages ADD COLUMN reply_to TEXT');
}
try {
  db.prepare('SELECT reply_to_nickname FROM messages LIMIT 0').get();
} catch {
  db.exec('ALTER TABLE messages ADD COLUMN reply_to_nickname TEXT');
}
try {
  db.prepare('SELECT reply_to_user_id FROM messages LIMIT 0').get();
} catch {
  db.exec('ALTER TABLE messages ADD COLUMN reply_to_user_id TEXT');
}
try {
  db.prepare('SELECT reply_to_content FROM messages LIMIT 0').get();
} catch {
  db.exec('ALTER TABLE messages ADD COLUMN reply_to_content TEXT');
}
try {
  db.prepare('SELECT last_seen_at FROM identities LIMIT 0').get();
} catch {
  db.exec('ALTER TABLE identities ADD COLUMN last_seen_at INTEGER');
}
try {
  db.prepare('SELECT reply_to FROM server_messages LIMIT 0').get();
} catch {
  db.exec('ALTER TABLE server_messages ADD COLUMN reply_to TEXT');
}
try {
  db.prepare('SELECT channel_id FROM channel_read_roles LIMIT 0').get();
} catch {
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_read_roles (
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      role_id    TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      PRIMARY KEY (channel_id, role_id)
    );
  `);
}
try {
  db.prepare('SELECT channel_id FROM channel_write_roles LIMIT 0').get();
} catch {
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_write_roles (
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      role_id    TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      PRIMARY KEY (channel_id, role_id)
    );
  `);
}
try {
  db.prepare('SELECT channel_id FROM channel_visibility_roles LIMIT 0').get();
} catch {
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_visibility_roles (
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      role_id    TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      PRIMARY KEY (channel_id, role_id)
    );
  `);
}
try {
  db.prepare('SELECT id FROM reactions LIMIT 0').get();
} catch {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reactions (
      id         TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      emoji      TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(message_id, user_id, emoji)
    );
    CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id);
  `);
}
try {
  db.prepare('SELECT key FROM server_config LIMIT 0').get();
} catch {
  db.exec(`
    CREATE TABLE IF NOT EXISTS server_config (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

/**
 * Returns all channels ordered by parent and sort order.
 * @returns {object[]}
 */
export function getAllChannels() {
  return db.prepare('SELECT * FROM channels ORDER BY parent_id NULLS FIRST, sort_order').all();
}

/**
 * Returns a single channel by ID.
 * @param {string} id
 * @returns {object|undefined}
 */
export function getChannel(id) {
  return db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
}

/**
 * Returns the default channel.
 * @returns {object|undefined}
 */
export function getDefaultChannel() {
  return db.prepare('SELECT * FROM channels WHERE is_default = 1').get();
}

/**
 * Inserts a new channel.
 * @param {object} channel
 */
export function insertChannel(channel) {
  db.prepare(
    `INSERT INTO channels (id, name, parent_id, password, max_users, description, is_default, sort_order, moderated, type, is_temporary)
     VALUES (@id, @name, @parentId, @password, @maxUsers, @description, @isDefault, @sortOrder, @moderated, @type, @isTemporary)`,
  ).run({
    id: channel.id,
    name: channel.name,
    parentId: channel.parentId ?? null,
    password: channel.password ?? null,
    maxUsers: channel.maxUsers ?? null,
    description: channel.description ?? '',
    isDefault: channel.isDefault ? 1 : 0,
    sortOrder: channel.sortOrder ?? 0,
    moderated: channel.moderated ? 1 : 0,
    type: channel.type ?? 'channel',
    isTemporary: channel.isTemporary ? 1 : 0,
  });
}

/**
 * Updates a channel's properties.
 * @param {string} id
 * @param {object} props
 */
export function updateChannel(id, props) {
  const sets = [];
  const params = { id };
  if (props.name !== undefined) {
    sets.push('name = @name');
    params.name = props.name;
  }
  if (props.password !== undefined) {
    sets.push('password = @password');
    params.password = props.password;
  }
  if (props.maxUsers !== undefined) {
    sets.push('max_users = @maxUsers');
    params.maxUsers = props.maxUsers;
  }
  if (props.description !== undefined) {
    sets.push('description = @description');
    params.description = props.description;
  }
  if (props.parentId !== undefined) {
    sets.push('parent_id = @parentId');
    params.parentId = props.parentId;
  }
  if (props.sortOrder !== undefined) {
    sets.push('sort_order = @sortOrder');
    params.sortOrder = props.sortOrder;
  }
  if (props.moderated !== undefined) {
    sets.push('moderated = @moderated');
    params.moderated = props.moderated ? 1 : 0;
  }
  if (props.type !== undefined) {
    sets.push('type = @type');
    params.type = props.type;
  }
  if (props.isDefault !== undefined) {
    sets.push('is_default = @isDefault');
    params.isDefault = props.isDefault ? 1 : 0;
  }
  if (sets.length === 0) {
    return;
  }
  db.prepare(`UPDATE channels SET ${sets.join(', ')} WHERE id = @id`).run(params);
}

/**
 * Deletes a channel by ID.
 * @param {string} id
 */
export function deleteChannel(id) {
  db.prepare('DELETE FROM channels WHERE id = ?').run(id);
}

/**
 * Checks whether an IP address is currently banned.
 * @param {string} ip
 * @returns {boolean}
 */
export function isBanned(ip) {
  const now = Date.now();
  return !!db.prepare('SELECT 1 FROM bans WHERE ip = ? AND (expires_at IS NULL OR expires_at > ?)').get(ip, now);
}

/**
 * Returns all bans ordered by creation date.
 * @returns {object[]}
 */
export function getAllBans() {
  return db.prepare('SELECT * FROM bans ORDER BY created_at DESC').all();
}

/**
 * Deletes a ban by ID.
 * @param {string} banId
 */
export function deleteBan(banId) {
  db.prepare('DELETE FROM bans WHERE id = ?').run(banId);
}

/**
 * Inserts a new ban record.
 * @param {object} ban
 */
export function addBan(ban) {
  db.prepare(
    `INSERT INTO bans (id, ip, user_id, reason, created_at, expires_at, nickname)
     VALUES (@id, @ip, @userId, @reason, @createdAt, @expiresAt, @nickname)`,
  ).run({
    id: ban.id,
    ip: ban.ip ?? null,
    userId: ban.userId ?? null,
    reason: ban.reason ?? '',
    createdAt: ban.createdAt ?? Date.now(),
    expiresAt: ban.expiresAt ?? null,
    nickname: ban.nickname ?? null,
  });
}

/**
 * Checks whether a user ID is currently banned.
 * @param {string} userId
 * @returns {boolean}
 */
export function isBannedByUserId(userId) {
  if (!userId) {
    return false;
  }
  const now = Date.now();
  return !!db.prepare('SELECT 1 FROM bans WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)').get(userId, now);
}

/**
 * Returns the nickname for a user ID from the identities table.
 * @param {string} userId
 * @returns {string|null}
 */
export function getNicknameByUserId(userId) {
  const row = db.prepare('SELECT name FROM identities WHERE user_id = ?').get(userId);
  return row ? row.name : null;
}

/**
 * Finds an identity by its OpenPGP fingerprint.
 * @param {string} fingerprint
 * @returns {object|undefined}
 */
export function findIdentityByFingerprint(fingerprint) {
  return db.prepare('SELECT * FROM identities WHERE fingerprint = ?').get(fingerprint);
}

/**
 * Inserts a new identity record.
 * @param {object} identity
 */
export function insertIdentity(identity) {
  db.prepare(
    `INSERT INTO identities (user_id, public_key, fingerprint, name, created_at)
     VALUES (@userId, @publicKey, @fingerprint, @name, @createdAt)`,
  ).run({
    userId: identity.userId,
    publicKey: identity.publicKey,
    fingerprint: identity.fingerprint,
    name: identity.name,
    createdAt: identity.createdAt,
  });
}

/**
 * Returns an identity by user ID.
 * @param {string} userId
 * @returns {object|undefined}
 */
export function getIdentity(userId) {
  return db.prepare('SELECT * FROM identities WHERE user_id = ?').get(userId);
}

/**
 * Returns all identities ordered by name.
 * @returns {object[]}
 */
export function getAllIdentities() {
  return db.prepare('SELECT * FROM identities ORDER BY name').all();
}

/**
 * Updates the last_seen_at timestamp for a user.
 * @param {string} userId
 * @param {number} timestamp
 */
export function updateLastSeen(userId, timestamp) {
  db.prepare('UPDATE identities SET last_seen_at = ? WHERE user_id = ?').run(timestamp, userId);
}

/**
 * Deletes an identity by user ID.
 * @param {string} userId
 */
export function deleteIdentity(userId) {
  db.prepare('DELETE FROM nickname_registrations WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM identities WHERE user_id = ?').run(userId);
}

/**
 * Finds the user_id that owns a registered nickname (case-insensitive).
 * @param {string} nickname
 * @returns {string|null}
 */
export function getNicknameOwner(nickname) {
  const row = db.prepare('SELECT user_id FROM nickname_registrations WHERE nickname = ? COLLATE NOCASE').get(nickname);
  return row ? row.user_id : null;
}

/**
 * Registers a nickname for a user identity.
 * @param {string} userId
 * @param {string} nickname
 */
export function registerNickname(userId, nickname) {
  db.prepare('INSERT OR IGNORE INTO nickname_registrations (user_id, nickname, registered_at) VALUES (?, ?, ?)').run(userId, nickname, Date.now());
}

/**
 * Returns all registered nicknames for a given user.
 * @param {string} userId
 * @returns {string[]}
 */
export function getRegisteredNicknames(userId) {
  return db
    .prepare('SELECT nickname FROM nickname_registrations WHERE user_id = ?')
    .all(userId)
    .map((r) => r.nickname);
}

/**
 * Deletes a single nickname registration for a user.
 * @param {string} userId
 * @param {string} nickname
 * @returns {boolean}
 */
export function deleteNicknameRegistration(userId, nickname) {
  const result = db.prepare('DELETE FROM nickname_registrations WHERE user_id = ? AND nickname = ? COLLATE NOCASE').run(userId, nickname);
  return result.changes > 0;
}

/**
 * Deletes all role assignments for a user.
 * @param {string} userId
 */
export function deleteUserRoles(userId) {
  db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(userId);
}

/**
 * Inserts a server-wide chat message.
 * @param {object} msg
 */
export function insertServerMessage(msg) {
  db.prepare(
    `INSERT INTO server_messages (id, type, user_id, client_id, badge, content, reply_to, created_at)
     VALUES (@id, @type, @userId, @clientId, @badge, @content, @replyTo, @createdAt)`,
  ).run({
    id: msg.id,
    type: msg.type ?? 'message',
    userId: msg.userId ?? null,
    clientId: msg.clientId ?? null,
    badge: msg.badge ?? null,
    content: msg.content,
    replyTo: msg.replyTo ?? null,
    createdAt: msg.createdAt,
  });
}

/**
 * Returns a server message by ID.
 * @param {string} id
 * @returns {object|undefined}
 */
export function getServerMessage(id) {
  return db.prepare('SELECT * FROM server_messages WHERE id = ?').get(id);
}

/**
 * Deletes a server message by ID.
 * @param {string} id
 */
export function deleteServerMessage(id) {
  db.prepare('DELETE FROM server_messages WHERE id = ?').run(id);
}

/**
 * Returns server messages with optional pagination.
 * @param {object} [options]
 * @param {number} [options.before]
 * @param {number} [options.limit]
 * @returns {object[]}
 */
export function getServerMessages({ before, limit = 50 } = {}) {
  if (before) {
    return db
      .prepare(
        `SELECT * FROM server_messages WHERE created_at < ?
       ORDER BY created_at DESC LIMIT ?`,
      )
      .all(before, limit);
  }
  return db.prepare(`SELECT * FROM server_messages ORDER BY created_at DESC LIMIT ?`).all(limit);
}

/**
 * Inserts a channel chat message.
 * @param {object} msg
 */
export function insertMessage(msg) {
  db.prepare(
    `INSERT INTO messages (id, channel_id, client_id, user_id, badge, content, reply_to, reply_to_nickname, reply_to_user_id, reply_to_content, created_at)
     VALUES (@id, @channelId, @clientId, @userId, @badge, @content, @replyTo, @replyToNickname, @replyToUserId, @replyToContent, @createdAt)`,
  ).run({
    id: msg.id,
    channelId: msg.channelId,
    clientId: msg.clientId ?? null,
    userId: msg.userId ?? null,
    badge: msg.badge ?? null,
    content: msg.content,
    replyTo: msg.replyTo ?? null,
    replyToNickname: msg.replyToNickname ?? null,
    replyToUserId: msg.replyToUserId ?? null,
    replyToContent: msg.replyToContent ?? null,
    createdAt: msg.createdAt,
  });
}

/**
 * Returns channel messages with optional pagination.
 * @param {string} channelId
 * @param {object} [options]
 * @param {number} [options.before]
 * @param {number} [options.limit]
 * @returns {object[]}
 */
export function getMessages(channelId, { before, limit = 50 } = {}) {
  if (before) {
    return db
      .prepare(
        `SELECT * FROM messages WHERE channel_id = ? AND created_at < ?
       ORDER BY created_at DESC LIMIT ?`,
      )
      .all(channelId, before, limit);
  }
  return db
    .prepare(
      `SELECT * FROM messages WHERE channel_id = ?
     ORDER BY created_at DESC LIMIT ?`,
    )
    .all(channelId, limit);
}

/**
 * Returns messages surrounding a given timestamp in a channel.
 * @param {string} channelId
 * @param {number} timestamp
 * @param {number} [halfLimit=25]
 * @returns {object[]}
 */
export function getMessagesAround(channelId, timestamp, halfLimit = 25) {
  const before = db
    .prepare(
      `SELECT * FROM messages WHERE channel_id = ? AND created_at <= ?
     ORDER BY created_at DESC LIMIT ?`,
    )
    .all(channelId, timestamp, halfLimit);
  const after = db
    .prepare(
      `SELECT * FROM messages WHERE channel_id = ? AND created_at > ?
     ORDER BY created_at ASC LIMIT ?`,
    )
    .all(channelId, timestamp, halfLimit);
  const all = [...before.reverse(), ...after];
  return all;
}

/**
 * Searches messages in a channel by content substring.
 * @param {string} channelId
 * @param {string} query
 * @param {{ limit?: number }} [options]
 * @returns {object[]}
 */
export function searchMessages(channelId, query, { limit = 50 } = {}) {
  return db
    .prepare(
      `SELECT * FROM messages WHERE channel_id = ? AND content LIKE ?
     ORDER BY created_at DESC LIMIT ?`,
    )
    .all(channelId, `%${query}%`, limit);
}

/**
 * Returns a map of channel IDs to their most recent message timestamp.
 * @returns {Map<string, number>}
 */
export function getLastMessageTimestamps() {
  const rows = db.prepare(`SELECT channel_id, MAX(created_at) AS last_message_at FROM messages GROUP BY channel_id`).all();
  const map = new Map();
  for (const row of rows) {
    map.set(row.channel_id, row.last_message_at);
  }
  return map;
}

/**
 * Updates the stored link previews for a message.
 * @param {string} messageId
 * @param {object[]} previews
 */
export function updateMessagePreviews(messageId, previews) {
  db.prepare('UPDATE messages SET link_previews = ? WHERE id = ?').run(JSON.stringify(previews), messageId);
}

/**
 * Clears the link previews for a message.
 * @param {string} messageId
 */
export function clearMessagePreviews(messageId) {
  db.prepare('UPDATE messages SET link_previews = NULL WHERE id = ?').run(messageId);
}

/**
 * Returns a single message by ID.
 * @param {string} messageId
 * @returns {object|undefined}
 */
export function getMessage(messageId) {
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
}

/**
 * Updates a message's content and edited timestamp.
 * @param {string} messageId
 * @param {string} newContent
 * @param {number} editedAt
 */
export function updateMessage(messageId, newContent, editedAt) {
  db.prepare('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?').run(newContent, editedAt, messageId);
}

/**
 * Deletes a message by ID.
 * @param {string} messageId
 */
export function deleteMessage(messageId) {
  db.prepare('DELETE FROM messages WHERE id = ?').run(messageId);
}

/**
 * Deletes all messages in a channel.
 * @param {string} channelId
 */
export function deleteChannelMessages(channelId) {
  db.prepare('DELETE FROM messages WHERE channel_id = ?').run(channelId);
}

/**
 * Deletes all messages from a user (by client_id and/or user_id) across all channels.
 * Also removes associated reactions and pinned message entries.
 * @param {string} clientId
 * @param {string|null} userId
 */
export function deleteMessagesByUser(clientId, userId) {
  const conditions = [];
  const params = [];

  if (clientId) {
    conditions.push('client_id = ?');
    params.push(clientId);
  }
  if (userId) {
    conditions.push('user_id = ?');
    params.push(userId);
  }

  if (conditions.length === 0) {
    return;
  }

  const where = conditions.join(' OR ');
  const subquery = `SELECT id FROM messages WHERE ${where}`;

  const txn = db.transaction(() => {
    db.prepare(`DELETE FROM reactions WHERE message_id IN (${subquery})`).run(...params);
    db.prepare(`DELETE FROM pinned_messages WHERE message_id IN (${subquery})`).run(...params);
    db.prepare(`DELETE FROM messages WHERE ${where}`).run(...params);
  });
  txn();
}

/**
 * Prunes messages in a channel keeping only the most recent maxCount.
 * @param {string} channelId
 * @param {number} maxCount
 */
export function pruneMessages(channelId, maxCount) {
  const cutoff = db
    .prepare(
      `SELECT created_at FROM messages WHERE channel_id = ?
     ORDER BY created_at DESC LIMIT 1 OFFSET ?`,
    )
    .get(channelId, maxCount);
  if (cutoff) {
    db.prepare('DELETE FROM messages WHERE channel_id = ? AND created_at < ?').run(channelId, cutoff.created_at);
  }
}

/**
 * Inserts a file upload record.
 * @param {object} file
 */
export function insertFile(file) {
  db.prepare(
    `INSERT INTO files (id, channel_id, client_id, user_id, nickname, filename, size, mime_type, created_at)
     VALUES (@id, @channelId, @clientId, @userId, @nickname, @filename, @size, @mimeType, @createdAt)`,
  ).run({
    id: file.id,
    channelId: file.channelId,
    clientId: file.clientId,
    userId: file.userId ?? null,
    nickname: file.nickname,
    filename: file.filename,
    size: file.size,
    mimeType: file.mimeType,
    createdAt: file.createdAt,
  });
}

/**
 * Returns a file record by ID.
 * @param {string} id
 * @returns {object|undefined}
 */
export function getFile(id) {
  return db.prepare('SELECT * FROM files WHERE id = ?').get(id);
}

/**
 * Returns files for a channel with optional pagination.
 * @param {string} channelId
 * @param {object} [options]
 * @param {number} [options.before]
 * @param {number} [options.limit]
 * @returns {object[]}
 */
export function getChannelFiles(channelId, { before, limit = 50 } = {}) {
  if (before) {
    return db
      .prepare(
        `SELECT * FROM files WHERE channel_id = ? AND created_at < ?
       ORDER BY created_at DESC LIMIT ?`,
      )
      .all(channelId, before, limit);
  }
  return db
    .prepare(
      `SELECT * FROM files WHERE channel_id = ?
     ORDER BY created_at DESC LIMIT ?`,
    )
    .all(channelId, limit);
}

/**
 * Deletes a file record by ID.
 * @param {string} id
 */
export function deleteFile(id) {
  db.prepare('DELETE FROM files WHERE id = ?').run(id);
}

/**
 * Returns all file IDs for a channel.
 * @param {string} channelId
 * @returns {string[]}
 */
export function getChannelFileIds(channelId) {
  return db
    .prepare('SELECT id FROM files WHERE channel_id = ?')
    .all(channelId)
    .map((r) => r.id);
}

/**
 * Finds the message containing a file upload by file ID.
 * @param {string} fileId
 * @returns {object|undefined}
 */
export function getMessageByFileId(fileId) {
  return db.prepare('SELECT * FROM messages WHERE content LIKE ?').get(`%"fileId":"${fileId}"%`);
}

/**
 * Returns the count of admin tokens.
 * @returns {number}
 */
export function getAdminTokenCount() {
  return db.prepare('SELECT COUNT(*) as c FROM admin_tokens').get().c;
}

/**
 * Returns true if at least one user has been assigned the admin role.
 * @returns {boolean}
 */
export function hasAdminUsers() {
  return db.prepare("SELECT COUNT(*) as c FROM user_roles WHERE role_id = 'admin'").get().c > 0;
}

/**
 * Inserts a new admin token.
 * @param {object} token
 */
export function insertAdminToken(token) {
  db.prepare(`INSERT INTO admin_tokens (token, role, created_at, expires_at) VALUES (@token, @role, @createdAt, @expiresAt)`).run({
    token: token.token,
    role: token.role || 'admin',
    createdAt: token.createdAt || Date.now(),
    expiresAt: token.expiresAt ?? null,
  });
}

/**
 * Deletes all expired and unredeemed admin tokens.
 * @returns {import('better-sqlite3').RunResult}
 */
export function deleteExpiredTokens() {
  return db.prepare('DELETE FROM admin_tokens WHERE expires_at IS NOT NULL AND expires_at < ? AND redeemed_at IS NULL').run(Date.now());
}

/**
 * Returns an admin token by its token string.
 * @param {string} token
 * @returns {object|undefined}
 */
export function getAdminToken(token) {
  return db.prepare('SELECT * FROM admin_tokens WHERE token = ?').get(token);
}

/**
 * Marks an admin token as redeemed by a user.
 * @param {string} token
 * @param {string} userId
 */
export function redeemAdminToken(token, userId) {
  db.prepare('UPDATE admin_tokens SET user_id = ?, redeemed_at = ? WHERE token = ?').run(userId, Date.now(), token);
}

/**
 * Returns the set of all permissions granted to a user through their roles.
 * @param {string} userId
 * @returns {Set<string>}
 */
export function getUserPermissions(userId) {
  const rows = db
    .prepare(
      `
    SELECT rp.permission FROM role_permissions rp
    JOIN user_roles ur ON ur.role_id = rp.role_id
    WHERE ur.user_id = ?
  `,
    )
    .all(userId);
  return new Set(rows.map((r) => r.permission));
}

/**
 * Returns the badge text for a user from their highest-priority role.
 * @param {string} userId
 * @returns {string|null}
 */
export function getUserBadge(userId) {
  const row = db
    .prepare(
      `
    SELECT r.badge FROM roles r
    JOIN user_roles ur ON ur.role_id = r.id
    WHERE ur.user_id = ? AND r.badge IS NOT NULL
    ORDER BY r.position
    LIMIT 1
  `,
    )
    .get(userId);
  return row ? row.badge : null;
}

/**
 * Returns the role color for a user from their highest-priority role.
 * @param {string} userId
 * @returns {string|null}
 */
export function getUserRoleColor(userId) {
  const row = db
    .prepare(
      `
    SELECT r.color FROM roles r
    JOIN user_roles ur ON ur.role_id = r.id
    WHERE ur.user_id = ? AND r.color IS NOT NULL
    ORDER BY r.position
    LIMIT 1
  `,
    )
    .get(userId);
  return row ? row.color : null;
}

/**
 * Assigns a role to a user (idempotent).
 * @param {string} userId
 * @param {string} roleId
 */
export function assignRole(userId, roleId) {
  db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)').run(userId, roleId);
}

/**
 * Removes a role from a user.
 * @param {string} userId
 * @param {string} roleId
 */
export function removeRole(userId, roleId) {
  db.prepare('DELETE FROM user_roles WHERE user_id = ? AND role_id = ?').run(userId, roleId);
}

/**
 * Returns all roles assigned to a user.
 * @param {string} userId
 * @returns {Array<{id: string, name: string, badge: string|null}>}
 */
export function getUserRoles(userId) {
  return db
    .prepare(
      `
    SELECT r.id, r.name, r.badge, r.color, r.position FROM roles r
    JOIN user_roles ur ON ur.role_id = r.id
    WHERE ur.user_id = ?
    ORDER BY r.position
  `,
    )
    .all(userId);
}

/**
 * Returns all roles.
 * @returns {object[]}
 */
export function getRoles() {
  return db.prepare('SELECT * FROM roles ORDER BY position').all();
}

/**
 * Returns all members of a role with their identity info.
 * @param {string} roleId
 * @returns {Array<{user_id: string, name: string, fingerprint: string}>}
 */
export function getRoleMembers(roleId) {
  return db
    .prepare(
      `
    SELECT i.user_id, i.name, i.fingerprint FROM identities i
    JOIN user_roles ur ON ur.user_id = i.user_id
    WHERE ur.role_id = ?
    ORDER BY i.name
  `,
    )
    .all(roleId);
}

/**
 * Creates a new role.
 * @param {object} role
 */
/**
 * Returns the best (lowest) position among all roles assigned to a user.
 * Lower position = higher rank. Returns Infinity if the user has no roles.
 * @param {string} userId
 * @returns {number}
 */
export function getUserHighestRolePosition(userId) {
  const row = db
    .prepare(
      `
    SELECT MIN(r.position) AS pos FROM roles r
    JOIN user_roles ur ON ur.role_id = r.id
    WHERE ur.user_id = ?
  `,
    )
    .get(userId);
  return row?.pos ?? Infinity;
}

/**
 * Returns a role's position in the hierarchy.
 * @param {string} roleId
 * @returns {number}
 */
export function getRolePosition(roleId) {
  const row = db.prepare('SELECT position FROM roles WHERE id = ?').get(roleId);
  return row?.position ?? Infinity;
}

/**
 * Updates positions for multiple roles in a transaction.
 * @param {Array<{id: string, position: number}>} entries
 */
export function updateRolePositions(entries) {
  const stmt = db.prepare('UPDATE roles SET position = ? WHERE id = ?');
  db.transaction(() => {
    for (const { id, position } of entries) {
      stmt.run(position, id);
    }
  })();
}

/**
 * Returns the next available position for a new role (max + 1).
 * @returns {number}
 */
export function getNextRolePosition() {
  const row = db.prepare('SELECT MAX(position) AS maxPos FROM roles').get();
  return (row?.maxPos ?? -1) + 1;
}

export function createRole(role) {
  db.prepare('INSERT INTO roles (id, name, badge, color, position) VALUES (@id, @name, @badge, @color, @position)').run({
    id: role.id,
    name: role.name,
    badge: role.badge ?? null,
    color: role.color ?? null,
    position: role.position ?? 0,
  });
}

/**
 * Updates a role's properties.
 * @param {string} id
 * @param {object} props
 */
export function updateRole(id, props) {
  const sets = [];
  const params = { id };
  if (props.name !== undefined) {
    sets.push('name = @name');
    params.name = props.name;
  }
  if (props.badge !== undefined) {
    sets.push('badge = @badge');
    params.badge = props.badge;
  }
  if (props.color !== undefined) {
    sets.push('color = @color');
    params.color = props.color;
  }
  if (sets.length === 0) {
    return;
  }
  db.prepare(`UPDATE roles SET ${sets.join(', ')} WHERE id = @id`).run(params);
}

/**
 * Deletes a role by ID (built-in 'admin' and 'user' roles are protected).
 * @param {string} id
 */
export function deleteRole(id) {
  db.prepare("DELETE FROM roles WHERE id = ? AND id != 'admin' AND id != 'user'").run(id);
}

/**
 * Returns all permission strings for a role.
 * @param {string} roleId
 * @returns {string[]}
 */
export function getRolePermissions(roleId) {
  return db
    .prepare('SELECT permission FROM role_permissions WHERE role_id = ?')
    .all(roleId)
    .map((r) => r.permission);
}

/**
 * Replaces all permissions for a role.
 * @param {string} roleId
 * @param {string[]} permissions
 */
export function setRolePermissions(roleId, permissions) {
  const del = db.prepare('DELETE FROM role_permissions WHERE role_id = ?');
  const ins = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission) VALUES (?, ?)');
  db.transaction(() => {
    del.run(roleId);
    for (const perm of permissions) {
      ins.run(roleId, perm);
    }
  })();
}

/**
 * Returns all allowed role IDs for a channel.
 * @param {string} channelId
 * @returns {string[]}
 */
export function getChannelAllowedRoles(channelId) {
  return db
    .prepare('SELECT role_id FROM channel_allowed_roles WHERE channel_id = ?')
    .all(channelId)
    .map((r) => r.role_id);
}

/**
 * Replaces the allowed roles for a channel.
 * @param {string} channelId
 * @param {string[]} roleIds
 */
export function setChannelAllowedRoles(channelId, roleIds) {
  const del = db.prepare('DELETE FROM channel_allowed_roles WHERE channel_id = ?');
  const ins = db.prepare('INSERT OR IGNORE INTO channel_allowed_roles (channel_id, role_id) VALUES (?, ?)');
  db.transaction(() => {
    del.run(channelId);
    for (const roleId of roleIds) {
      ins.run(channelId, roleId);
    }
  })();
}

/**
 * Returns a map of channel IDs to their allowed role ID arrays.
 * @returns {Map<string, string[]>}
 */
export function getAllChannelAllowedRoles() {
  const rows = db.prepare('SELECT channel_id, role_id FROM channel_allowed_roles').all();
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.channel_id)) {
      map.set(row.channel_id, []);
    }
    map.get(row.channel_id).push(row.role_id);
  }
  return map;
}

/**
 * Returns all unredeemed and non-expired admin tokens.
 * @returns {object[]}
 */
export function listAdminTokens() {
  return db
    .prepare('SELECT token, role, created_at, redeemed_at, expires_at FROM admin_tokens WHERE redeemed_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC')
    .all(Date.now());
}

/**
 * Deletes an admin token by its token string.
 * @param {string} token
 * @returns {import('better-sqlite3').RunResult}
 */
export function deleteAdminToken(token) {
  return db.prepare('DELETE FROM admin_tokens WHERE token = ?').run(token);
}

/**
 * Returns all read-restricted role IDs for a channel.
 * @param {string} channelId
 * @returns {string[]}
 */
export function getChannelReadRoles(channelId) {
  return db
    .prepare('SELECT role_id FROM channel_read_roles WHERE channel_id = ?')
    .all(channelId)
    .map((r) => r.role_id);
}

/**
 * Replaces the read-restricted roles for a channel.
 * @param {string} channelId
 * @param {string[]} roleIds
 */
export function setChannelReadRoles(channelId, roleIds) {
  const del = db.prepare('DELETE FROM channel_read_roles WHERE channel_id = ?');
  const ins = db.prepare('INSERT OR IGNORE INTO channel_read_roles (channel_id, role_id) VALUES (?, ?)');
  db.transaction(() => {
    del.run(channelId);
    for (const roleId of roleIds) {
      ins.run(channelId, roleId);
    }
  })();
}

/**
 * Returns a map of channel IDs to their read-restricted role ID arrays.
 * @returns {Map<string, string[]>}
 */
export function getAllChannelReadRoles() {
  const rows = db.prepare('SELECT channel_id, role_id FROM channel_read_roles').all();
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.channel_id)) {
      map.set(row.channel_id, []);
    }
    map.get(row.channel_id).push(row.role_id);
  }
  return map;
}

/**
 * Returns all write-restricted role IDs for a channel.
 * @param {string} channelId
 * @returns {string[]}
 */
export function getChannelWriteRoles(channelId) {
  return db
    .prepare('SELECT role_id FROM channel_write_roles WHERE channel_id = ?')
    .all(channelId)
    .map((r) => r.role_id);
}

/**
 * Replaces the write-restricted roles for a channel.
 * @param {string} channelId
 * @param {string[]} roleIds
 */
export function setChannelWriteRoles(channelId, roleIds) {
  const del = db.prepare('DELETE FROM channel_write_roles WHERE channel_id = ?');
  const ins = db.prepare('INSERT OR IGNORE INTO channel_write_roles (channel_id, role_id) VALUES (?, ?)');
  db.transaction(() => {
    del.run(channelId);
    for (const roleId of roleIds) {
      ins.run(channelId, roleId);
    }
  })();
}

/**
 * Returns a map of channel IDs to their write-restricted role ID arrays.
 * @returns {Map<string, string[]>}
 */
export function getAllChannelWriteRoles() {
  const rows = db.prepare('SELECT channel_id, role_id FROM channel_write_roles').all();
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.channel_id)) {
      map.set(row.channel_id, []);
    }
    map.get(row.channel_id).push(row.role_id);
  }
  return map;
}

/**
 * Replaces the visibility-restricted roles for a channel.
 * @param {string} channelId
 * @param {string[]} roleIds
 */
export function setChannelVisibilityRoles(channelId, roleIds) {
  const del = db.prepare('DELETE FROM channel_visibility_roles WHERE channel_id = ?');
  const ins = db.prepare('INSERT OR IGNORE INTO channel_visibility_roles (channel_id, role_id) VALUES (?, ?)');
  db.transaction(() => {
    del.run(channelId);
    for (const roleId of roleIds) {
      ins.run(channelId, roleId);
    }
  })();
}

/**
 * Returns a map of channel IDs to their visibility-restricted role ID arrays.
 * @returns {Map<string, string[]>}
 */
export function getAllChannelVisibilityRoles() {
  const rows = db.prepare('SELECT channel_id, role_id FROM channel_visibility_roles').all();
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.channel_id)) {
      map.set(row.channel_id, []);
    }
    map.get(row.channel_id).push(row.role_id);
  }
  return map;
}

/**
 * Adds a reaction to a message. Returns false if the reaction already exists.
 * @param {object} reaction
 * @returns {boolean}
 */
export function addReaction(reaction) {
  try {
    db.prepare(
      `INSERT INTO reactions (id, message_id, user_id, emoji, created_at)
       VALUES (@id, @messageId, @userId, @emoji, @createdAt)`,
    ).run({
      id: reaction.id,
      messageId: reaction.messageId,
      userId: reaction.userId,
      emoji: reaction.emoji,
      createdAt: reaction.createdAt,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes a specific reaction from a message.
 * @param {string} messageId
 * @param {string} userId
 * @param {string} emoji
 */
export function removeReaction(messageId, userId, emoji) {
  db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(messageId, userId, emoji);
}

/**
 * Returns all reactions for a message ordered by creation time.
 * @param {string} messageId
 * @returns {object[]}
 */
export function getReactions(messageId) {
  return db.prepare('SELECT * FROM reactions WHERE message_id = ? ORDER BY created_at').all(messageId);
}

/**
 * Pins a message in a channel.
 * @param {string} messageId
 * @param {string} channelId
 * @param {string} pinnedByUserId
 * @returns {boolean}
 */
export function pinMessage(messageId, channelId, pinnedByUserId) {
  try {
    db.prepare(
      `INSERT OR REPLACE INTO pinned_messages (message_id, channel_id, pinned_by_user_id, pinned_at)
       VALUES (?, ?, ?, ?)`,
    ).run(messageId, channelId, pinnedByUserId, Date.now());
    return true;
  } catch {
    return false;
  }
}

/**
 * Unpins a message from a channel.
 * @param {string} messageId
 * @param {string} channelId
 */
export function unpinMessage(messageId, channelId) {
  db.prepare('DELETE FROM pinned_messages WHERE message_id = ? AND channel_id = ?').run(messageId, channelId);
}

/**
 * Returns all pinned messages in a channel.
 * @param {string} channelId
 * @returns {Array<{message_id: string, pinned_by_user_id: string, pinned_at: number}>}
 */
export function getPinnedMessages(channelId) {
  return db
    .prepare(
      `SELECT p.message_id, p.pinned_by_user_id, p.pinned_at FROM pinned_messages p
     INNER JOIN messages m ON m.id = p.message_id
     WHERE p.channel_id = ? ORDER BY p.pinned_at DESC`,
    )
    .all(channelId);
}

/**
 * Checks whether a message is pinned in a channel.
 * @param {string} messageId
 * @param {string} channelId
 * @returns {boolean}
 */
export function isMessagePinned(messageId, channelId) {
  const row = db.prepare('SELECT 1 FROM pinned_messages WHERE message_id = ? AND channel_id = ?').get(messageId, channelId);
  return !!row;
}

/**
 * Returns all server config key-value pairs.
 * @returns {Record<string, *>}
 */
export function getAllConfigValues() {
  const rows = db.prepare('SELECT key, value FROM server_config').all();
  const result = {};
  for (const row of rows) {
    try {
      result[row.key] = JSON.parse(row.value);
    } catch {
      result[row.key] = row.value;
    }
  }
  return result;
}

/**
 * Returns a single server config value by key.
 * @param {string} key
 * @returns {*}
 */
export function getConfigValue(key) {
  const row = db.prepare('SELECT value FROM server_config WHERE key = ?').get(key);
  if (!row) {
    return undefined;
  }
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

/**
 * Sets a single server config value.
 * @param {string} key
 * @param {*} value
 */
export function setConfigValue(key, value) {
  db.prepare('INSERT OR REPLACE INTO server_config (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
}

/**
 * Sets multiple server config values in a transaction.
 * @param {Record<string, *>} entries
 */
export function setConfigValues(entries) {
  const stmt = db.prepare('INSERT OR REPLACE INTO server_config (key, value) VALUES (?, ?)');
  db.transaction(() => {
    for (const [key, value] of Object.entries(entries)) {
      stmt.run(key, JSON.stringify(value));
    }
  })();
}

/**
 * Logs an audit event.
 * @param {string} action
 * @param {string|null} actorUserId
 * @param {string|null} actorNickname
 * @param {string|null} targetUserId
 * @param {string|null} targetNickname
 * @param {string|null} details
 */
export function logAuditEvent(action, actorUserId, actorNickname, targetUserId, targetNickname, details) {
  db.prepare(
    `INSERT INTO audit_log (id, action, actor_user_id, actor_nickname, target_user_id, target_nickname, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), action, actorUserId || null, actorNickname || null, targetUserId || null, targetNickname || null, details || null, Date.now());
}

/**
 * Returns the most recent audit log entries.
 * @param {number} [limit=100]
 * @returns {object[]}
 */
export function getAuditLog(limit = 100) {
  return db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?').all(limit);
}

/**
 * Returns analytics data aggregated from the database.
 * @returns {object}
 */
export function getAnalyticsData() {
  const now = Date.now();
  const oneDayAgo = now - 86400000;
  const sevenDaysAgo = now - 604800000;
  const thirtyDaysAgo = now - 2592000000;

  const totalMessages = db.prepare('SELECT COUNT(*) as c FROM messages').get().c;
  const messagesToday = db.prepare('SELECT COUNT(*) as c FROM messages WHERE created_at > ?').get(oneDayAgo).c;
  const messages7d = db.prepare('SELECT COUNT(*) as c FROM messages WHERE created_at > ?').get(sevenDaysAgo).c;
  const messages30d = db.prepare('SELECT COUNT(*) as c FROM messages WHERE created_at > ?').get(thirtyDaysAgo).c;

  const totalFiles = db.prepare('SELECT COUNT(*) as c FROM files').get().c;
  const fileStats = db.prepare('SELECT COALESCE(SUM(size), 0) as totalSize FROM files').get();

  const totalIdentities = db.prepare('SELECT COUNT(*) as c FROM identities').get().c;
  const activeIdentities7d = db.prepare('SELECT COUNT(*) as c FROM identities WHERE last_seen_at > ?').get(sevenDaysAgo).c;

  const totalBans = db.prepare('SELECT COUNT(*) as c FROM bans').get().c;

  const totalChannels = db.prepare('SELECT COUNT(*) as c FROM channels').get().c;

  const totalReactions = db.prepare('SELECT COUNT(*) as c FROM reactions').get().c;

  const totalPins = db.prepare('SELECT COUNT(*) as c FROM pinned_messages').get().c;

  const totalAuditEvents = db.prepare('SELECT COUNT(*) as c FROM audit_log').get().c;

  const messagesPerChannel = db
    .prepare(
      `SELECT c.name, COUNT(m.id) as count
     FROM channels c LEFT JOIN messages m ON m.channel_id = c.id
     GROUP BY c.id ORDER BY count DESC LIMIT 10`,
    )
    .all();

  const topUploaders = db
    .prepare(
      `SELECT nickname, COUNT(*) as count, SUM(size) as totalSize
     FROM files GROUP BY nickname ORDER BY totalSize DESC LIMIT 10`,
    )
    .all();

  const messageActivity = db
    .prepare(
      `SELECT (created_at / 3600000) * 3600000 as hour, COUNT(*) as count
     FROM messages WHERE created_at > ? GROUP BY hour ORDER BY hour`,
    )
    .all(sevenDaysAgo);

  const filesByType = db
    .prepare(
      `SELECT mime_type, COUNT(*) as count, SUM(size) as totalSize
     FROM files GROUP BY mime_type ORDER BY totalSize DESC LIMIT 10`,
    )
    .all();

  const serverMessages = db.prepare('SELECT COUNT(*) as c FROM server_messages').get().c;

  return {
    messages: { total: totalMessages, today: messagesToday, last7d: messages7d, last30d: messages30d },
    serverMessages,
    files: { total: totalFiles, totalSize: fileStats.totalSize, byType: filesByType, topUploaders },
    identities: { total: totalIdentities, active7d: activeIdentities7d },
    bans: { total: totalBans },
    channels: { total: totalChannels, messagesPerChannel },
    reactions: { total: totalReactions },
    pins: { total: totalPins },
    auditEvents: { total: totalAuditEvents },
    messageActivity,
  };
}

// ── Conversations ──────────────────────────────────────────────────────────

/**
 * Creates a new conversation.
 * @param {{ id: string, name?: string|null, type: string, creatorFingerprint: string, createdAt: number }} conv
 */
export function createConversation(conv) {
  db.prepare(
    `INSERT INTO conversations (id, name, type, creator_fingerprint, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(conv.id, conv.name ?? null, conv.type, conv.creatorFingerprint, conv.createdAt);
}

/**
 * Adds a participant to a conversation.
 * @param {string} conversationId
 * @param {string} fingerprint
 * @param {string|null} encryptedSessionKey
 * @param {number} joinedAt
 */
export function addConversationParticipant(conversationId, fingerprint, encryptedSessionKey, joinedAt) {
  db.prepare(
    `INSERT OR IGNORE INTO conversation_participants (conversation_id, fingerprint, encrypted_session_key, joined_at)
     VALUES (?, ?, ?, ?)`,
  ).run(conversationId, fingerprint, encryptedSessionKey, joinedAt);
}

/**
 * Removes a participant from a conversation.
 * @param {string} conversationId
 * @param {string} fingerprint
 */
export function removeConversationParticipant(conversationId, fingerprint) {
  db.prepare('DELETE FROM conversation_participants WHERE conversation_id = ? AND fingerprint = ?').run(conversationId, fingerprint);
}

/**
 * Returns a conversation with its participants.
 * @param {string} conversationId
 * @returns {{ conversation: object, participants: Array<object> }|null}
 */
export function getConversation(conversationId) {
  const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
  if (!conversation) return null;
  const participants = db.prepare('SELECT * FROM conversation_participants WHERE conversation_id = ?').all(conversationId);
  return { conversation, participants };
}

/**
 * Returns all conversations a user is part of, with participants.
 * @param {string} fingerprint
 * @returns {Array<{ conversation: object, participants: Array<object> }>}
 */
export function getConversationsForUser(fingerprint) {
  const convIds = db
    .prepare('SELECT conversation_id FROM conversation_participants WHERE fingerprint = ?')
    .all(fingerprint)
    .map((r) => r.conversation_id);

  return convIds.map((convId) => getConversation(convId)).filter(Boolean);
}

/**
 * Updates the encrypted session key for a single participant.
 * @param {string} conversationId
 * @param {string} fingerprint
 * @param {string} encryptedKey
 */
export function updateSessionKey(conversationId, fingerprint, encryptedKey) {
  db.prepare(
    'UPDATE conversation_participants SET encrypted_session_key = ? WHERE conversation_id = ? AND fingerprint = ?',
  ).run(encryptedKey, conversationId, fingerprint);
}

/**
 * Bulk-updates encrypted session keys for all participants in a conversation.
 * @param {string} conversationId
 * @param {Record<string, string>} keysMap - fingerprint → encryptedKey
 */
export function updateAllSessionKeys(conversationId, keysMap) {
  const stmt = db.prepare(
    'UPDATE conversation_participants SET encrypted_session_key = ? WHERE conversation_id = ? AND fingerprint = ?',
  );
  const run = db.transaction(() => {
    for (const [fingerprint, encryptedKey] of Object.entries(keysMap)) {
      stmt.run(encryptedKey, conversationId, fingerprint);
    }
  });
  run();
}

/**
 * Returns the participant count for a conversation.
 * @param {string} conversationId
 * @returns {number}
 */
export function getConversationParticipantCount(conversationId) {
  const row = db.prepare('SELECT COUNT(*) as count FROM conversation_participants WHERE conversation_id = ?').get(conversationId);
  return row.count;
}

/**
 * Checks whether a fingerprint is a participant in a conversation.
 * @param {string} conversationId
 * @param {string} fingerprint
 * @returns {boolean}
 */
export function isConversationParticipant(conversationId, fingerprint) {
  const row = db.prepare('SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND fingerprint = ?').get(conversationId, fingerprint);
  return !!row;
}

/**
 * Finds an existing direct (1:1) conversation between exactly two fingerprints.
 * @param {string} fpA
 * @param {string} fpB
 * @returns {string|null} - The conversation ID, or null
 */
export function findDirectConversation(fpA, fpB) {
  const row = db.prepare(
    `SELECT cp1.conversation_id FROM conversation_participants cp1
     JOIN conversation_participants cp2 ON cp1.conversation_id = cp2.conversation_id
     JOIN conversations c ON c.id = cp1.conversation_id
     WHERE cp1.fingerprint = ? AND cp2.fingerprint = ? AND c.type = 'direct'`,
  ).get(fpA, fpB);
  return row ? row.conversation_id : null;
}

// ── DM Messages (conversation-based) ──────────────────────────────────────

/**
 * Inserts a new DM message into a conversation.
 * @param {{ id: string, conversationId: string, senderFingerprint: string, content: string, keyIndex?: number, createdAt: number, replyTo?: string|null, replyToNickname?: string|null, replyToContent?: string|null }} msg
 */
export function insertDmMessage(msg) {
  db.prepare(
    `INSERT OR IGNORE INTO dm_messages (id, conversation_id, sender_fingerprint, content, key_index, created_at, reply_to, reply_to_nickname, reply_to_content)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(msg.id, msg.conversationId, msg.senderFingerprint, msg.content, msg.keyIndex ?? 0, msg.createdAt, msg.replyTo ?? null, msg.replyToNickname ?? null, msg.replyToContent ?? null);
}

/**
 * Marks a DM message as delivered.
 * @param {string} id
 * @param {number} deliveredAt
 */
export function markDmDelivered(id, deliveredAt) {
  db.prepare('UPDATE dm_messages SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL').run(deliveredAt, id);
}

/**
 * Returns all undelivered DM messages for a given fingerprint across all their conversations.
 * @param {string} fingerprint
 * @returns {Array<object>}
 */
export function getPendingDmMessages(fingerprint) {
  return db.prepare(
    `SELECT m.* FROM dm_messages m
     JOIN conversation_participants cp ON cp.conversation_id = m.conversation_id AND cp.fingerprint = ?
     WHERE m.sender_fingerprint != ? AND m.delivered_at IS NULL
     ORDER BY m.created_at ASC`,
  ).all(fingerprint, fingerprint);
}

/**
 * Returns message history for a conversation.
 * @param {string} conversationId
 * @param {{ before?: number, limit?: number }} options
 * @returns {Array<object>}
 */
export function getConversationMessages(conversationId, { before, limit = 50 } = {}) {
  if (before) {
    return db.prepare(
      `SELECT * FROM dm_messages WHERE conversation_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?`,
    ).all(conversationId, before, limit);
  }
  return db.prepare(
    `SELECT * FROM dm_messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?`,
  ).all(conversationId, limit);
}

/**
 * Returns pending conversation invites for a fingerprint (conversations they're in but haven't acked).
 * Returns conversations where the user has a participant row but no messages delivered yet.
 * @param {string} fingerprint
 * @returns {Array<{ conversation: object, participants: Array<object>, encryptedSessionKey: string|null }>}
 */
export function getPendingConversationInvites(fingerprint) {
  const rows = db.prepare(
    `SELECT cp.conversation_id, cp.encrypted_session_key
     FROM conversation_participants cp
     JOIN conversations c ON c.id = cp.conversation_id
     WHERE cp.fingerprint = ?`,
  ).all(fingerprint);

  return rows.map((row) => {
    const conv = getConversation(row.conversation_id);
    return {
      ...conv,
      encryptedSessionKey: row.encrypted_session_key,
    };
  });
}

/**
 * Inserts a new friend request.
 * @param {{ id: string, senderFingerprint: string, recipientFingerprint: string, senderPublicKey: string, senderNickname: string, createdAt: number }} req
 */
export function insertFriendRequest(req) {
  db.prepare(
    `INSERT INTO friend_requests (id, sender_fingerprint, recipient_fingerprint, sender_public_key, sender_nickname, status, created_at)
     VALUES (@id, @senderFingerprint, @recipientFingerprint, @senderPublicKey, @senderNickname, 'pending', @createdAt)`,
  ).run({
    id: req.id,
    senderFingerprint: req.senderFingerprint,
    recipientFingerprint: req.recipientFingerprint,
    senderPublicKey: req.senderPublicKey,
    senderNickname: req.senderNickname,
    createdAt: req.createdAt,
  });
}

/**
 * Returns a friend request by ID.
 * @param {string} id
 * @returns {object|undefined}
 */
export function getFriendRequest(id) {
  return db.prepare('SELECT * FROM friend_requests WHERE id = ?').get(id);
}

/**
 * Returns the pending friend request between two fingerprints in either direction.
 * @param {string} fpA
 * @param {string} fpB
 * @returns {object|undefined}
 */
export function getPendingRequestBetween(fpA, fpB) {
  return db.prepare(
    `SELECT * FROM friend_requests
     WHERE status = 'pending'
       AND ((sender_fingerprint = ? AND recipient_fingerprint = ?)
         OR (sender_fingerprint = ? AND recipient_fingerprint = ?))`,
  ).get(fpA, fpB, fpB, fpA);
}

/**
 * Returns all pending incoming friend requests for a fingerprint.
 * @param {string} recipientFingerprint
 * @returns {object[]}
 */
export function getPendingFriendRequests(recipientFingerprint) {
  return db.prepare(
    `SELECT * FROM friend_requests WHERE recipient_fingerprint = ? AND status = 'pending' ORDER BY created_at ASC`,
  ).all(recipientFingerprint);
}

/**
 * Returns accepted friend requests where the sender has not been notified yet.
 * @param {string} senderFingerprint
 * @returns {object[]}
 */
export function getUnnotifiedAcceptedRequests(senderFingerprint) {
  return db.prepare(
    `SELECT * FROM friend_requests WHERE sender_fingerprint = ? AND status = 'accepted' ORDER BY resolved_at ASC`,
  ).all(senderFingerprint);
}

/**
 * Updates a friend request's status.
 * @param {string} id
 * @param {string} status
 */
export function updateFriendRequestStatus(id, status) {
  db.prepare('UPDATE friend_requests SET status = ?, resolved_at = ? WHERE id = ?').run(status, Date.now(), id);
}

/**
 * Deletes a friend request by ID.
 * @param {string} id
 */
export function deleteFriendRequest(id) {
  db.prepare('DELETE FROM friend_requests WHERE id = ?').run(id);
}

/**
 * Deletes all conversations, DM messages, and friend requests from the database.
 * @returns {{ conversationCount: number, dmCount: number, friendRequestCount: number }}
 */
export function purgeAllDmAndFriendData() {
  const dmResult = db.prepare('DELETE FROM dm_messages').run();
  const cpResult = db.prepare('DELETE FROM conversation_participants').run();
  const convResult = db.prepare('DELETE FROM conversations').run();
  const frResult = db.prepare('DELETE FROM friend_requests').run();
  return { conversationCount: convResult.changes, dmCount: dmResult.changes, friendRequestCount: frResult.changes };
}

export default db;

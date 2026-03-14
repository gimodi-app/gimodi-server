/**
 * Creates the conversations and conversation_participants tables for group DMs.
 * Drops the old dm_messages and dm_reactions tables and recreates dm_messages
 * tied to conversations.
 * @param {import('better-sqlite3').Database} db
 */
export default function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id                   TEXT PRIMARY KEY,
      name                 TEXT,
      type                 TEXT NOT NULL DEFAULT 'direct',
      creator_fingerprint  TEXT NOT NULL,
      created_at           INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversation_participants (
      conversation_id      TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      fingerprint          TEXT NOT NULL,
      encrypted_session_key TEXT,
      joined_at            INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, fingerprint)
    );

    CREATE INDEX IF NOT EXISTS idx_conv_participants_fp
      ON conversation_participants(fingerprint);

    DROP TABLE IF EXISTS dm_reactions;
    DROP TABLE IF EXISTS dm_messages;

    CREATE TABLE dm_messages (
      id                   TEXT PRIMARY KEY,
      conversation_id      TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_fingerprint   TEXT NOT NULL,
      content              TEXT NOT NULL,
      key_index            INTEGER DEFAULT 0,
      created_at           INTEGER NOT NULL,
      delivered_at         INTEGER,
      reply_to             TEXT,
      reply_to_nickname    TEXT,
      reply_to_content     TEXT
    );

    CREATE INDEX idx_dm_messages_conversation
      ON dm_messages(conversation_id, created_at);
  `);
}

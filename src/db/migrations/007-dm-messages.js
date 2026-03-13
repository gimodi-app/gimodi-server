/**
 * Creates the dm_messages table for direct messaging between users.
 * @param {import('better-sqlite3').Database} db
 */
export default function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dm_messages (
      id                TEXT PRIMARY KEY,
      conversation_id   TEXT NOT NULL,
      sender_user_id    TEXT NOT NULL,
      recipient_user_id TEXT NOT NULL,
      content           TEXT NOT NULL,
      reply_to          TEXT,
      reply_to_content  TEXT,
      reply_to_user_id  TEXT,
      link_previews     TEXT,
      created_at        INTEGER NOT NULL,
      edited_at         INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_dm_conversation ON dm_messages(conversation_id, created_at);
  `);
}

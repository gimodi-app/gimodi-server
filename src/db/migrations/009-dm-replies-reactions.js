/**
 * Adds reply fields to dm_messages and creates the dm_reactions table.
 * @param {import('better-sqlite3').Database} db
 */
export default function migrate(db) {
  db.exec(`
    ALTER TABLE dm_messages ADD COLUMN reply_to TEXT;
    ALTER TABLE dm_messages ADD COLUMN reply_to_nickname TEXT;
    ALTER TABLE dm_messages ADD COLUMN reply_to_content TEXT;

    CREATE TABLE IF NOT EXISTS dm_reactions (
      id          TEXT PRIMARY KEY,
      message_id  TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      emoji       TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      UNIQUE(message_id, fingerprint, emoji)
    );
  `);
}

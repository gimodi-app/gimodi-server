/**
 * Creates the meet_invites table for channel invite links.
 * @param {import('better-sqlite3').Database} db
 */
export default function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meet_invites (
      id         TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      max_uses   INTEGER,
      use_count  INTEGER NOT NULL DEFAULT 0
    )
  `);
}

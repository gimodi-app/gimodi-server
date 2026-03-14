/**
 * Creates the dm_messages table for the direct messaging system.
 * Messages are stored server-side and relayed to recipients.
 * Deduplication is handled client-side via the UUID primary key.
 * @param {import('better-sqlite3').Database} db
 */
export default function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dm_messages (
      id                   TEXT PRIMARY KEY,
      sender_fingerprint   TEXT NOT NULL,
      recipient_fingerprint TEXT NOT NULL,
      content              TEXT NOT NULL,
      created_at           INTEGER NOT NULL,
      delivered_at         INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_dm_messages_recipient
      ON dm_messages (recipient_fingerprint, delivered_at);

    CREATE INDEX IF NOT EXISTS idx_dm_messages_sender
      ON dm_messages (sender_fingerprint);
  `);
}

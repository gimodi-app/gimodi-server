/**
 * Creates the friend_requests table for relaying friend request handshakes.
 * Rows are deleted once both parties have exchanged public keys.
 * @param {import('better-sqlite3').Database} db
 */
export default function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS friend_requests (
      id                    TEXT PRIMARY KEY,
      sender_fingerprint    TEXT NOT NULL,
      recipient_fingerprint TEXT NOT NULL,
      sender_public_key     TEXT NOT NULL,
      sender_nickname       TEXT NOT NULL,
      status                TEXT NOT NULL DEFAULT 'pending',
      created_at            INTEGER NOT NULL,
      resolved_at           INTEGER,
      UNIQUE(sender_fingerprint, recipient_fingerprint)
    );

    CREATE INDEX IF NOT EXISTS idx_friend_requests_recipient
      ON friend_requests(recipient_fingerprint, status);

    CREATE INDEX IF NOT EXISTS idx_friend_requests_sender
      ON friend_requests(sender_fingerprint, status);
  `);
}

/**
 * Adds indexes on sender_user_id and recipient_user_id for efficient DM conversation listing.
 * @param {import('better-sqlite3').Database} db
 */
export default function migrate(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_dm_sender ON dm_messages(sender_user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_dm_recipient ON dm_messages(recipient_user_id, created_at);
  `);
}

/**
 * Drops the dm_messages table as direct messaging has been removed.
 * @param {import('better-sqlite3').Database} db
 */
export default function migrate(db) {
  db.exec('DROP TABLE IF EXISTS dm_messages');
}

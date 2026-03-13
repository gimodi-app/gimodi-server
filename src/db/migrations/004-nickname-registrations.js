/**
 * Creates the nickname_registrations table and seeds it from existing identities.
 * @param {import('better-sqlite3').Database} db
 */
export default function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nickname_registrations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT NOT NULL,
      nickname    TEXT NOT NULL,
      registered_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES identities(user_id) ON DELETE CASCADE,
      UNIQUE(nickname COLLATE NOCASE)
    );
    CREATE INDEX IF NOT EXISTS idx_nickname_reg_user ON nickname_registrations(user_id);
  `);

  const identities = db.prepare('SELECT user_id, name, created_at FROM identities').all();
  const insert = db.prepare('INSERT OR IGNORE INTO nickname_registrations (user_id, nickname, registered_at) VALUES (?, ?, ?)');

  const txn = db.transaction(() => {
    for (const identity of identities) {
      insert.run(identity.user_id, identity.name, identity.created_at);
    }
  });
  txn();
}

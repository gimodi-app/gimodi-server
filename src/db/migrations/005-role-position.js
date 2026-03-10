/**
 * Adds a position column to the roles table for hierarchy ordering.
 * Position 0 is the highest rank (admin). Lower positions = higher rank.
 * @param {import('better-sqlite3').Database} db
 */
export default function migrate(db) {
  try {
    db.exec('ALTER TABLE roles ADD COLUMN position INTEGER NOT NULL DEFAULT 0');
  } catch {
    // Column may already exist from legacy ALTER TABLE in database.js
  }

  const roles = db.prepare('SELECT id FROM roles ORDER BY CASE WHEN id = \'admin\' THEN 0 WHEN id = \'user\' THEN 999999 ELSE 1 END, name').all();
  const update = db.prepare('UPDATE roles SET position = ? WHERE id = ?');
  db.transaction(() => {
    for (let i = 0; i < roles.length; i++) {
      update.run(i, roles[i].id);
    }
  })();
}

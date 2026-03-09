/**
 * Adds a color column to the roles table for role-based nickname coloring.
 * @param {import('better-sqlite3').Database} db
 */
export default function migrate(db) {
  db.exec(`ALTER TABLE roles ADD COLUMN color TEXT`);
}

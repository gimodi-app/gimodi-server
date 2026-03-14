import db from './database.js';
import migration001 from './migrations/001-fix-file-urls.js';
import migration002 from './migrations/002-bans-nickname.js';
import migration003 from './migrations/003-role-color.js';
import migration004 from './migrations/004-nickname-registrations.js';
import migration005 from './migrations/005-role-position.js';
import migration006 from './migrations/006-drop-dm-messages.js';
import migration007 from './migrations/007-dm-messages.js';
import logger from '../logger.js';

/** @type {Array<[string, function]>} */
const MIGRATIONS = [
  ['001-fix-file-urls', migration001],
  ['002-bans-nickname', migration002],
  ['003-role-color', migration003],
  ['004-nickname-registrations', migration004],
  ['005-role-position', migration005],
  ['006-drop-dm-messages', migration006],
  ['007-dm-messages', migration007],
];

/**
 * Runs all pending data migrations in order, recording each in the migrations table.
 */
export function runMigrations() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      name        TEXT PRIMARY KEY,
      executed_at INTEGER NOT NULL
    );
  `);

  const executed = new Set(
    db
      .prepare('SELECT name FROM migrations')
      .all()
      .map((r) => r.name),
  );

  for (const [name, migrate] of MIGRATIONS) {
    if (executed.has(name)) {
      continue;
    }

    logger.info(`Running migration: ${name}`);
    try {
      migrate(db);
      db.prepare('INSERT INTO migrations (name, executed_at) VALUES (?, ?)').run(name, Date.now());
      logger.info(`Migration complete: ${name}`);
    } catch (err) {
      logger.error(`Migration failed: ${name} - ${err.stack || err}`);
      throw err;
    }
  }
}

import logger from '../../logger.js';

/**
 * Replaces absolute file URLs with relative paths in message content.
 * Previously, file upload messages stored full URLs like "https://host:port/files/id/name".
 * They should use relative paths like "/files/id/name" so URLs survive port/domain changes.
 * @param {import('better-sqlite3').Database} db
 */
export default function migrate(db) {
  const messages = db.prepare(`SELECT id, content FROM messages WHERE content LIKE '%"type"%file"%' AND content LIKE '%"url"%http%'`).all();

  const serverMessages = db.prepare(`SELECT id, content FROM server_messages WHERE content LIKE '%"type"%file"%' AND content LIKE '%"url"%http%'`).all();

  const update = db.prepare('UPDATE messages SET content = ? WHERE id = ?');
  const updateServer = db.prepare('UPDATE server_messages SET content = ? WHERE id = ?');

  let fixed = 0;

  db.transaction(() => {
    for (const msg of messages) {
      const result = fixFileUrl(msg.content);
      if (result) {
        update.run(result, msg.id);
        fixed++;
      }
    }
    for (const msg of serverMessages) {
      const result = fixFileUrl(msg.content);
      if (result) {
        updateServer.run(result, msg.id);
        fixed++;
      }
    }
  })();

  if (fixed > 0) {
    logger.info(`  Fixed ${fixed} file message(s) with absolute URLs`);
  }
}

/**
 * Converts an absolute file URL in a JSON content string to a relative path.
 * @param {string} content - JSON string containing a file message.
 * @returns {string|null} The updated JSON string, or null if no change needed.
 */
function fixFileUrl(content) {
  try {
    const parsed = JSON.parse(content);
    if (parsed.type !== 'file' || !parsed.url) {
      return null;
    }

    if (parsed.url.startsWith('/')) {
      return null;
    }

    const match = parsed.url.match(/^https?:\/\/[^/]+(\/files\/.+)$/);
    if (!match) {
      return null;
    }

    parsed.url = match[1];
    return JSON.stringify(parsed);
  } catch {
    return null;
  }
}

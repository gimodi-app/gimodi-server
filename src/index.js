import { createServer } from 'node:https';
import { randomBytes } from 'node:crypto';
import logger from './logger.js';
import config from './config.js';
import state from './state.js';
import { initWebSocket, closeWebSocket } from './ws/handler.js';
import { checkTemporaryChannel } from './ws/channels.js';
import { initWorkers, closeWorkers } from './media/workers.js';
import { getAdminTokenCount, insertAdminToken, deleteExpiredTokens } from './db/database.js';
import { runMigrations } from './db/migrate.js';
import { loadOrGenerateCert } from './ssl.js';
import { setCors } from './http/utils.js';
import { handleFileUpload, handleFileDownload } from './http/files.js';
import { handleIconUpload, handleIconDownload, handleIconDelete } from './http/icon.js';

let httpServer = null;

async function main() {
  runMigrations();

  logger.info(`Starting ${config.name}...`);

  if (getAdminTokenCount() === 0) {
    const token = randomBytes(16).toString('hex');
    insertAdminToken({ token, role: 'admin', createdAt: Date.now() });
    logger.info('========================================');
    logger.info(`ADMIN TOKEN: ${token}`);
    logger.info('Save this token! Use it in the client to get admin rights.');
    logger.info('========================================');
  }

  if (config.generateAdminToken) {
    const token = randomBytes(16).toString('hex');
    const now = Date.now();
    const expiresAt = now + 60 * 60 * 1000;
    insertAdminToken({ token, role: 'admin', createdAt: now, expiresAt });
    logger.info('========================================');
    logger.info(`STARTUP ADMIN TOKEN: ${token}`);
    logger.info(`Expires: ${new Date(expiresAt).toLocaleString()}`);
    logger.info('========================================');
  }

  deleteExpiredTokens();
  setInterval(() => deleteExpiredTokens(), 60_000);

  state.loadChannelsFromDb();

  for (const ch of state.channels.values()) {
    if (ch.isTemporary) checkTemporaryChannel(ch.id);
  }

  await initWorkers();

  const sslCert = await loadOrGenerateCert();

  const server = httpServer = createServer({ cert: sslCert.cert, key: sslCert.key }, (req, res) => {
    setCors(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        name: config.name,
        clients: state.clients.size,
        channels: state.channels.size,
        iconHash: config.icon?.hash || null,
      }));
      return;
    }

    if (req.method === 'POST' && req.url === '/files') {
      handleFileUpload(req, res);
      return;
    }

    const dlMatch = req.url.match(/^\/files\/([^/]+)\/(.+)$/);
    if (req.method === 'GET' && dlMatch) {
      handleFileDownload(req, res, dlMatch[1], decodeURIComponent(dlMatch[2]));
      return;
    }

    if (req.method === 'POST' && req.url === '/icon') {
      handleIconUpload(req, res);
      return;
    }

    if (req.method === 'GET' && req.url === '/icon') {
      handleIconDownload(req, res);
      return;
    }

    if (req.method === 'DELETE' && req.url === '/icon') {
      handleIconDelete(req, res);
      return;
    }

    res.writeHead(404);
    res.end();
  });

  initWebSocket(server);

  server.listen(config.port, () => {
    logger.info(`${config.name} listening on port ${config.port} (HTTPS/WSS)`);
    logger.info(`Channels: ${state.channels.size}`);
    logger.info(`File uploads: ${config.files.storagePath} (max ${(config.files.maxFileSize / 1024 / 1024).toFixed(0)}MB)`);
  });
}

/**
 * Gracefully shuts down the server.
 * @param {string} signal - The signal that triggered shutdown
 */
async function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down...`);

  closeWebSocket('Server is shutting down.');

  if (httpServer) {
    await new Promise(resolve => httpServer.close(resolve));
  }

  closeWorkers();

  logger.info('Shutdown complete.');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

main().catch(err => {
  logger.error('Failed to start server:', err);
  process.exit(1);
});

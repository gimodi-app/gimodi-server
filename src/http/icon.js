import { createReadStream, mkdirSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import config, { updateConfig } from '../config.js';
import state from '../state.js';
import { broadcast } from '../ws/handler.js';
import { getMimeType } from './utils.js';

const dataDir = resolve('data');

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {object|null} The client with manage_settings permission, or null
 */
function getIconClient(req) {
  const clientId = req.headers['x-client-id'];
  if (!clientId) return null;
  const client = state.clients.get(clientId);
  if (!client || !client.permissions.has('server.manage_settings')) return null;
  return client;
}

/**
 * Deletes the current server icon file from disk.
 */
function deleteExistingIcon() {
  if (config.icon.filename) {
    try { unlinkSync(join(dataDir, config.icon.filename)); } catch {}
  }
}

/**
 * Persists the current icon hash and filename to the database config.
 */
function saveIconConfig() {
  updateConfig('icon.hash', config.icon.hash);
  updateConfig('icon.filename', config.icon.filename);
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export function handleIconUpload(req, res) {
  const client = getIconClient(req);
  if (!client) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Forbidden' }));
    return;
  }

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const buffer = Buffer.concat(chunks);
    if (buffer.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Empty body' }));
      return;
    }

    const hash = createHash('sha256').update(buffer).digest('hex');

    let ext = 'png';
    const ct = req.headers['content-type'] || '';
    if (ct.includes('jpeg') || ct.includes('jpg')) ext = 'jpg';
    else if (ct.includes('gif')) ext = 'gif';
    else if (ct.includes('webp')) ext = 'webp';
    else if (ct.includes('svg')) ext = 'svg';

    deleteExistingIcon();

    const filename = `server-icon.${ext}`;
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, filename), buffer);

    config.icon.hash = hash;
    config.icon.filename = filename;
    saveIconConfig();

    broadcast('server:icon-changed', { hash });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ hash }));
  });

  req.on('error', () => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Upload failed' }));
  });
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export function handleIconDownload(req, res) {
  if (!config.icon.hash || !config.icon.filename) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No icon set' }));
    return;
  }

  const etag = `"${config.icon.hash}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304);
    res.end();
    return;
  }

  const filePath = join(dataDir, config.icon.filename);
  try { statSync(filePath); } catch {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Icon file missing' }));
    return;
  }

  res.writeHead(200, {
    'Content-Type': getMimeType(config.icon.filename),
    'ETag': etag,
    'Cache-Control': 'public, max-age=31536000, immutable',
  });
  createReadStream(filePath).pipe(res);
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export function handleIconDelete(req, res) {
  const client = getIconClient(req);
  if (!client) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Forbidden' }));
    return;
  }

  deleteExistingIcon();
  config.icon.hash = null;
  config.icon.filename = null;
  saveIconConfig();

  broadcast('server:icon-changed', { hash: null });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ hash: null }));
}

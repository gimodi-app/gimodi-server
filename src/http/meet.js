import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import config from '../config.js';
import { getValidInvite } from '../ws/meet.js';
import { getChannel } from '../db/database.js';

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

/**
 * Handles GET /meet/invite/:id — validates an invite and returns channel info.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export function handleMeetInviteApi(req, res) {
  const match = req.url.match(/^\/meet\/api\/invite\/([^/?]+)/);
  if (!match) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ valid: false }));
    return;
  }

  const inviteId = match[1];
  const invite = getValidInvite(inviteId);

  if (!invite) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ valid: false }));
    return;
  }

  const channel = getChannel(invite.channel_id);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    valid: true,
    channelName: channel?.name || 'Unknown',
    expiresAt: invite.expires_at,
  }));
}

/**
 * Serves the meet web application static files from meetPath.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export function handleMeetClient(req, res) {
  const meetPath = config.meetPath;
  if (!meetPath) {
    res.writeHead(404);
    res.end();
    return;
  }

  let urlPath = req.url.replace(/^\/meet\/?/, '/').split('?')[0];
  if (urlPath === '/' || urlPath.startsWith('/invite/')) {
    urlPath = '/index.html';
  }

  const filePath = join(meetPath, urlPath);

  if (!filePath.startsWith(meetPath) || !existsSync(filePath)) {
    const indexPath = join(meetPath, 'index.html');
    if (existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(readFileSync(indexPath));
      return;
    }
    res.writeHead(404);
    res.end();
    return;
  }

  const ext = extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';

  res.writeHead(200, { 'Content-Type': contentType });
  res.end(readFileSync(filePath));
}

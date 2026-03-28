import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import config from '../config.js';

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
};

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export function handleWebClient(req, res) {
  const webPath = config.webPath;
  if (!webPath) {
    res.writeHead(404);
    res.end();
    return;
  }

  let urlPath = req.url.replace(/^\/app\/?/, '/').split('?')[0];
  if (urlPath === '/') {
    urlPath = '/index.html';
  }

  const filePath = join(webPath, urlPath);

  if (!filePath.startsWith(webPath) || !existsSync(filePath)) {
    const indexPath = join(webPath, 'index.html');
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

import { randomUUID } from 'node:crypto';
import { mkdirSync, createWriteStream, createReadStream, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import config from '../config.js';
import state from '../state.js';
import { insertFile, getFile, insertMessage } from '../db/database.js';
import { send } from '../ws/handler.js';
import { contentDisposition, getMimeType } from './utils.js';

const uploadsDir = resolve(config.files.storagePath);
mkdirSync(uploadsDir, { recursive: true });

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export function handleFileUpload(req, res) {
  const channelId = req.headers['x-channel-id'];
  const clientId = req.headers['x-client-id'];
  const filename = req.headers['x-filename'];

  if (!channelId || !clientId || !filename) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing required headers: X-Channel-Id, X-Client-Id, X-Filename' }));
    return;
  }

  const client = state.clients.get(clientId);
  if (!client || client.channelId !== channelId) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Client not found or not in channel' }));
    return;
  }

  const channel = state.channels.get(channelId);
  if (!channel) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Channel not found' }));
    return;
  }

  const fileId = randomUUID();
  const safeName = filename.replace(/[/\\]/g, '_').replace(/\.\./g, '_');
  const fileDir = join(uploadsDir, fileId);
  mkdirSync(fileDir, { recursive: true });
  const filePath = join(fileDir, safeName);

  let size = 0;
  const ws = createWriteStream(filePath);

  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > config.files.maxFileSize) {
      req.destroy();
      ws.destroy();
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `File exceeds max size of ${(config.files.maxFileSize / 1024 / 1024).toFixed(0)}MB` }));
      return;
    }
    ws.write(chunk);
  });

  req.on('end', () => {
    ws.end(() => {
      const mimeType = getMimeType(safeName);
      const downloadPath = `/files/${fileId}/${encodeURIComponent(safeName)}`;
      const baseUrl = config.files.publicUrl || `https://${req.headers.host}`;
      const downloadUrl = `${baseUrl}${downloadPath}`;

      const now = Date.now();
      insertFile({
        id: fileId,
        channelId,
        clientId,
        userId: client.userId || null,
        nickname: client.nickname,
        filename: safeName,
        size,
        mimeType,
        createdAt: now,
      });

      const fileContent = JSON.stringify({
        type: 'file',
        fileId,
        filename: safeName,
        size,
        mimeType,
        url: downloadPath,
      });

      const messageId = randomUUID();
      if (config.chat.persistMessages) {
        insertMessage({
          id: messageId,
          channelId,
          clientId,
          userId: client.userId || null,
          nickname: client.nickname,
          content: fileContent,
          createdAt: now,
        });
      }

      for (const peerId of channel.clients) {
        const peer = state.clients.get(peerId);
        if (peer) {
          send(peer.ws, 'chat:receive', {
            id: messageId,
            channelId,
            clientId,
            userId: client.userId || null,
            nickname: client.nickname,
            content: fileContent,
            timestamp: now,
          });
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ fileId, filename: safeName, size, mimeType, url: downloadUrl }));
    });
  });

  req.on('error', () => {
    ws.destroy();
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Upload failed' }));
  });
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} fileId
 * @param {string} filename
 */
export function handleFileDownload(req, res, fileId, filename) {
  const fileRecord = getFile(fileId);
  if (!fileRecord) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'File not found' }));
    return;
  }

  const filePath = join(uploadsDir, fileId, fileRecord.filename);
  try {
    statSync(filePath);
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'File not found on disk' }));
    return;
  }

  const total = fileRecord.size;
  const rangeHeader = req.headers['range'];

  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (!match) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      res.end();
      return;
    }
    const start = parseInt(match[1], 10);
    const end = match[2] ? parseInt(match[2], 10) : total - 1;
    if (start > end || end >= total) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      'Content-Type': fileRecord.mime_type,
      'Content-Disposition': contentDisposition(fileRecord.filename),
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Type': fileRecord.mime_type,
      'Content-Disposition': contentDisposition(fileRecord.filename),
      'Content-Length': total,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    createReadStream(filePath).pipe(res);
  }
}

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import * as openpgp from 'openpgp';
import logger from '../logger.js';
import config from '../config.js';
import supportedVersions from '../supportedVersions.js';

const require = createRequire(import.meta.url);
const { version: serverVersion } = require('../../package.json');
import state from '../state.js';
import { isBanned, isBannedByUserId, findIdentityByFingerprint, insertIdentity, getUserPermissions, getUserBadge, getUserRoleColor, getUserRoles, assignRole, insertServerMessage, updateLastSeen, hasAdminUsers } from '../db/database.js';
import { broadcast, send } from './handler.js';
import { cleanupClientMedia, maybeCloseRouter } from '../media/room.js';
import { checkTemporaryChannel } from './channels.js';

/**
 * Broadcasts a server event message to all connected clients.
 * @param {string} content
 */
function broadcastServerEvent(content) {
  const id = randomUUID();
  const createdAt = Date.now();

  if (config.chat.persistMessages) {
    insertServerMessage({ id, type: 'event', content, createdAt });
  }

  const payload = { id, type: 'event', content, timestamp: createdAt };
  for (const peer of state.clients.values()) {
    send(peer.ws, 'chat:server-receive', payload);
  }
}

/**
 * Handles a new client connection.
 * @param {import('ws').WebSocket} ws
 * @param {object} data - Connection data (nickname, password, clientVersion, publicKey)
 * @param {string} [msgId]
 * @param {string} ip
 */
export async function handleConnect(ws, data, msgId, ip) {
  const { nickname, password, clientVersion, publicKey } = data;

  if (!nickname || typeof nickname !== 'string' || nickname.trim().length === 0) {
    return send(ws, 'server:error', { code: 'INVALID_NICKNAME', message: 'Nickname is required.' }, msgId);
  }

  const trimmed = nickname.trim();
  if (trimmed.length > 32) {
    return send(ws, 'server:error', { code: 'INVALID_NICKNAME', message: 'Nickname too long (max 32).' }, msgId);
  }

  if (config.password && password !== config.password) {
    return send(ws, 'server:error', { code: 'BAD_PASSWORD', message: 'Incorrect server password.' }, msgId);
  }

  if (isBanned(ip)) {
    return send(ws, 'server:error', { code: 'BANNED', message: 'You are banned from this server.' }, msgId);
  }

  if (state.isNicknameTaken(trimmed)) {
    return send(ws, 'server:error', { code: 'NICKNAME_TAKEN', message: 'Nickname is already in use.' }, msgId);
  }

  if (state.clients.size >= config.maxClients) {
    return send(ws, 'server:error', { code: 'SERVER_FULL', message: 'Server is full.' }, msgId);
  }

  let userId = null;
  if (publicKey && typeof publicKey === 'string') {
    try {
      const key = await openpgp.readKey({ armoredKey: publicKey });
      const fingerprint = key.getFingerprint();

      const existing = findIdentityByFingerprint(fingerprint);
      if (existing) {
        userId = existing.user_id;
      } else {
        userId = randomUUID();
        insertIdentity({
          userId,
          publicKey,
          fingerprint,
          name: trimmed,
          createdAt: Date.now(),
        });
      }
    } catch (err) {
      logger.warn(`Invalid public key from ${trimmed}: ${err.message}`);
    }
  }

  if (userId && isBannedByUserId(userId)) {
    return send(ws, 'server:error', { code: 'BANNED', message: 'You are banned from this server.' }, msgId);
  }

  if (state.isNicknameTaken(trimmed)) {
    return send(ws, 'server:error', { code: 'NICKNAME_TAKEN', message: 'Nickname is already in use.' }, msgId);
  }

  const clientId = randomUUID();

  if (userId) {
    const roles = getUserRoles(userId);
    if (roles.length === 0) {
      assignRole(userId, 'user');
    }
  }

  const permissions = userId ? getUserPermissions(userId) : new Set();
  const badge = userId ? getUserBadge(userId) : null;
  const roleColor = userId ? getUserRoleColor(userId) : null;

  const client = {
    id: clientId,
    userId,
    nickname: trimmed,
    ws,
    channelId: null,
    ip,
    connectedAt: Date.now(),
    clientVersion: clientVersion || null,
    sendTransport: null,
    recvTransport: null,
    producers: new Map(),
    consumers: new Map(),
    rtpCapabilities: null,
    muted: false,
    deafened: false,
    badge,
    roleColor,
    permissions,
    chatSubscriptions: new Set(),
  };

  state.addClient(client);
  ws._clientId = clientId;

  send(ws, 'server:welcome', {
    clientId,
    userId,
    badge,
    roleColor,
    permissions: [...permissions],
    serverName: config.name,
    serverVersion,
    iconHash: config.icon?.hash || null,
    maxFileSize: config.files.maxFileSize,
    tempChannelDeleteDelay: config.chat.tempChannelDeleteDelay || 180,
    supportedVersions,
    channels: state.getChannelList(),
    clients: state.getClientList(),
    hasAdmin: hasAdminUsers(),
  }, msgId);

  broadcast('server:client-joined', {
    clientId,
    userId,
    nickname: trimmed,
    channelId: null,
    badge,
    roleColor,
  }, clientId);

  broadcastServerEvent(`→ ${trimmed} joined the server`);

  logger.info(`Client connected: ${trimmed} (${clientId}${userId ? `, userId=${userId}` : ''})`);
}

/**
 * Handles a client disconnection.
 * @param {import('ws').WebSocket} ws
 */
export function handleDisconnect(ws) {
  const clientId = ws._clientId;
  if (!clientId) return;

  const client = state.clients.get(clientId);
  if (!client) return;

  const { channelId, nickname } = client;

  const channel = state.channels.get(channelId);
  if (channel) {
    for (const id of channel.clients) {
      if (id === clientId) continue;
      const peer = state.clients.get(id);
      if (peer) {
        send(peer.ws, 'channel:user-left', { channelId, clientId });
      }
    }
  }

  broadcastServerEvent(`← ${nickname} left the server`);

  if (client.userId) {
    updateLastSeen(client.userId, Date.now());
  }

  cleanupClientMedia(client);
  state.removeClient(clientId);
  if (channel) maybeCloseRouter(channelId);

  if (channel) checkTemporaryChannel(channelId);

  broadcast('server:client-left', { clientId }, clientId);

  logger.info(`Client disconnected: ${nickname} (${clientId})`);
}

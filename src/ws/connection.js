import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import * as openpgp from 'openpgp';
import logger from '../logger.js';
import config from '../config.js';
import { incrementCounter } from '../metrics.js';
import supportedVersions from '../supportedVersions.js';

const require = createRequire(import.meta.url);
const { version: serverVersion } = require('../../package.json');
import state from '../state.js';
import { PERMISSIONS } from '../permissions.js';
import {
  isBanned,
  isBannedByUserId,
  findIdentityByFingerprint,
  insertIdentity,
  getUserPermissions,
  getUserBadge,
  getUserRoleColor,
  getUserHighestRolePosition,
  getUserRoles,
  assignRole,
  insertServerMessage,
  updateLastSeen,
  hasAdminUsers,
  getNicknameOwner,
  registerNickname,
} from '../db/database.js';
import { broadcast, send } from './handler.js';
import { deliverPendingDms } from './dm.js';
import { cleanupClientMedia, maybeCloseRouter } from '../media/room.js';
import { checkTemporaryChannel, hasChannelVisibility } from './channels.js';

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
    if (peer.observe) {
      continue;
    }
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
  const { nickname, password, clientVersion, publicKey, mode } = data;
  const observeMode = mode === 'observe';

  if (!nickname || typeof nickname !== 'string' || nickname.trim().length === 0) {
    return send(ws, 'server:error', { code: 'INVALID_NICKNAME', message: 'Nickname is required.' }, msgId);
  }

  const trimmed = nickname.trim();
  if (trimmed.length > 32) {
    return send(ws, 'server:error', { code: 'INVALID_NICKNAME', message: 'Nickname too long (max 32).' }, msgId);
  }

  if (isBanned(ip)) {
    return send(ws, 'server:error', { code: 'BANNED', message: 'You are banned from this server.' }, msgId);
  }

  if (!observeMode && state.isNicknameTaken(trimmed)) {
    return send(ws, 'server:error', { code: 'NICKNAME_TAKEN', message: 'Nickname is already in use.' }, msgId);
  }

  if (!observeMode && state.getFullClientCount() >= config.maxClients) {
    return send(ws, 'server:error', { code: 'SERVER_FULL', message: 'Server is full.' }, msgId);
  }

  let userId = null;
  let fingerprint = null;
  if (publicKey && typeof publicKey === 'string') {
    try {
      const key = await openpgp.readKey({ armoredKey: publicKey });
      fingerprint = key.getFingerprint();

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

  if (!observeMode && state.isNicknameTaken(trimmed)) {
    return send(ws, 'server:error', { code: 'NICKNAME_TAKEN', message: 'Nickname is already in use.' }, msgId);
  }

  const nicknameOwner = getNicknameOwner(trimmed);
  if (nicknameOwner && !userId) {
    return send(
      ws,
      'server:error',
      {
        code: 'NICKNAME_REGISTERED',
        message: 'This nickname is registered to an identity. Please choose a different nickname or connect with your identity.',
      },
      msgId,
    );
  }
  if (nicknameOwner && nicknameOwner !== userId) {
    return send(
      ws,
      'server:error',
      {
        code: 'NICKNAME_REGISTERED',
        message: 'This nickname is registered to another identity. Please choose a different nickname.',
      },
      msgId,
    );
  }
  if (userId && !nicknameOwner) {
    registerNickname(userId, trimmed);
  }

  const clientId = randomUUID();

  if (userId) {
    const roles = getUserRoles(userId);
    if (roles.length === 0) {
      assignRole(userId, 'user');
    }
  }

  const permissions = userId ? getUserPermissions(userId) : new Set();

  if (config.password && password !== config.password && !permissions.has(PERMISSIONS.SERVER_BYPASS_PASSWORD)) {
    return send(ws, 'server:error', { code: 'BAD_PASSWORD', message: 'Incorrect server password.' }, msgId);
  }

  const badge = userId ? getUserBadge(userId) : null;
  const roleColor = userId ? getUserRoleColor(userId) : null;
  const rolePosition = userId ? getUserHighestRolePosition(userId) : Infinity;

  const client = {
    id: clientId,
    userId,
    fingerprint,
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
    rolePosition,
    permissions,
    chatSubscriptions: new Set(),
    observe: observeMode,
  };

  state.addClient(client);
  ws._clientId = clientId;
  incrementCounter('connectionsTotal');

  if (observeMode) {
    send(
      ws,
      'server:welcome',
      {
        clientId,
        userId,
        serverName: config.name,
        iconHash: config.icon?.hash || null,
        mode: 'observe',
      },
      msgId,
    );

    logger.info(`Client connected (observe): ${trimmed} (${clientId}${userId ? `, userId=${userId}` : ''})`);
    return;
  }

  const voiceGrantedClients = [];
  const voiceRequestClients = [];
  for (const channel of state.channels.values()) {
    if (channel.moderated) {
      for (const cid of channel.voiceGranted) {
        voiceGrantedClients.push(cid);
      }
      for (const cid of channel.voiceRequests) {
        voiceRequestClients.push(cid);
      }
    }
  }

  send(
    ws,
    'server:welcome',
    {
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
      channels: state.getChannelList().filter((ch) => {
        const channel = state.channels.get(ch.id);
        return !channel || hasChannelVisibility(client, channel);
      }),
      clients: state.getClientList(),
      hasAdmin: hasAdminUsers(),
      voiceGrantedClients,
      voiceRequestClients,
      mode: 'full',
    },
    msgId,
  );

  try {
    deliverPendingDms(client);
  } catch (err) {
    logger.warn(`[dm] Failed to deliver pending DMs to ${trimmed}: ${err.message}`);
  }

  broadcast(
    'server:client-joined',
    {
      clientId,
      userId,
      nickname: trimmed,
      channelId: null,
      badge,
      roleColor,
      rolePosition,
      fingerprint: fingerprint || null,
    },
    clientId,
  );

  broadcastServerEvent(`→ ${trimmed} joined the server`);

  logger.info(`Client connected: ${trimmed} (${clientId}${userId ? `, userId=${userId}` : ''})`);
}

/**
 * Upgrades an observe-mode client to full mode over the existing WebSocket.
 * @param {object} client
 * @param {object} data
 * @param {string} [msgId]
 */
export function handleUpgrade(client, data, msgId) {
  if (!client.observe) {
    return send(client.ws, 'server:error', { code: 'ALREADY_FULL', message: 'Already in full mode.' }, msgId);
  }

  if (state.getFullClientCount() >= config.maxClients) {
    return send(client.ws, 'server:error', { code: 'SERVER_FULL', message: 'Server is full.' }, msgId);
  }

  if (state.isNicknameTaken(client.nickname, true)) {
    return send(client.ws, 'server:error', { code: 'NICKNAME_TAKEN', message: 'Nickname is already in use.' }, msgId);
  }

  client.observe = false;

  const permissions = client.userId ? getUserPermissions(client.userId) : new Set();
  const badge = client.userId ? getUserBadge(client.userId) : null;
  const roleColor = client.userId ? getUserRoleColor(client.userId) : null;
  const rolePosition = client.userId ? getUserHighestRolePosition(client.userId) : Infinity;

  client.permissions = permissions;
  client.badge = badge;
  client.roleColor = roleColor;
  client.rolePosition = rolePosition;

  const voiceGrantedClients = [];
  const voiceRequestClients = [];
  for (const channel of state.channels.values()) {
    if (channel.moderated) {
      for (const cid of channel.voiceGranted) {
        voiceGrantedClients.push(cid);
      }
      for (const cid of channel.voiceRequests) {
        voiceRequestClients.push(cid);
      }
    }
  }

  send(
    client.ws,
    'server:upgrade-ok',
    {
      clientId: client.id,
      userId: client.userId,
      badge,
      roleColor,
      permissions: [...permissions],
      serverName: config.name,
      serverVersion,
      iconHash: config.icon?.hash || null,
      maxFileSize: config.files.maxFileSize,
      tempChannelDeleteDelay: config.chat.tempChannelDeleteDelay || 180,
      supportedVersions,
      channels: state.getChannelList().filter((ch) => {
        const channel = state.channels.get(ch.id);
        return !channel || hasChannelVisibility(client, channel);
      }),
      clients: state.getClientList(),
      hasAdmin: hasAdminUsers(),
      voiceGrantedClients,
      voiceRequestClients,
      mode: 'full',
    },
    msgId,
  );

  broadcast(
    'server:client-joined',
    {
      clientId: client.id,
      userId: client.userId,
      nickname: client.nickname,
      channelId: null,
      badge,
      roleColor,
      rolePosition,
    },
    client.id,
  );

  broadcastServerEvent(`→ ${client.nickname} joined the server`);

  logger.info(`Client upgraded to full: ${client.nickname} (${client.id})`);
}

/**
 * Handles a client disconnection.
 * @param {import('ws').WebSocket} ws
 */
export function handleDisconnect(ws) {
  const clientId = ws._clientId;
  if (!clientId) {
    return;
  }

  const client = state.clients.get(clientId);
  if (!client) {
    return;
  }

  const { channelId, nickname } = client;
  const wasObserve = client.observe;

  if (!wasObserve) {
    const channel = state.channels.get(channelId);
    if (channel) {
      for (const id of channel.clients) {
        if (id === clientId) {
          continue;
        }
        const peer = state.clients.get(id);
        if (peer) {
          send(peer.ws, 'channel:user-left', { channelId, clientId });
        }
      }
    }

    broadcastServerEvent(`← ${nickname} left the server`);
  }

  if (client.userId) {
    updateLastSeen(client.userId, Date.now());
  }

  cleanupClientMedia(client);
  state.removeClient(clientId);

  if (!wasObserve) {
    const channel = state.channels.get(channelId);
    if (channel) {
      maybeCloseRouter(channelId);
      checkTemporaryChannel(channelId);
    }

    broadcast('server:client-left', { clientId }, clientId);
  }

  logger.info(`Client disconnected${wasObserve ? ' (observe)' : ''}: ${nickname} (${clientId})`);
}

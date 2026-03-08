import state from '../state.js';
import { PERMISSIONS } from '../permissions.js';
import { getIdentity, getNicknameByUserId } from '../db/database.js';
import { send } from './handler.js';

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleGetUserInfo(client, data, id) {
  const { clientId } = data;
  const target = state.clients.get(clientId);
  if (!target) {
    return send(client.ws, 'server:error', { code: 'CLIENT_NOT_FOUND', message: 'Client not found.' }, id);
  }
  const info = {
    nickname: target.nickname,
    userId: target.userId || null,
    clientVersion: target.clientVersion,
    connectedAt: target.connectedAt,
  };
  if (client.permissions.has(PERMISSIONS.USER_VIEW_IP)) {
    info.ip = target.ip;
  }
  send(client.ws, 'user:info', info, id);
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleGetPublicKey(client, data, id) {
  const { clientId } = data;
  const target = state.clients.get(clientId);
  if (!target) {
    return send(client.ws, 'server:error', { code: 'CLIENT_NOT_FOUND', message: 'Client not found.' }, id);
  }
  if (!target.userId) {
    return send(client.ws, 'user:public-key', { clientId, publicKey: null }, id);
  }
  const identity = getIdentity(target.userId);
  send(client.ws, 'user:public-key', {
    clientId,
    userId: target.userId,
    publicKey: identity ? identity.public_key : null,
  }, id);
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleGetNicknames(client, data, id) {
  const { userIds } = data;
  if (!Array.isArray(userIds)) {
    return send(client.ws, 'server:error', { code: 'INVALID_REQUEST', message: 'userIds must be an array.' }, id);
  }

  const nicknames = {};
  const onlineByUserId = new Map();
  for (const c of state.clients.values()) {
    if (c.userId) onlineByUserId.set(c.userId, c.nickname);
  }

  for (const userId of userIds) {
    if (typeof userId !== 'string') continue;
    if (onlineByUserId.has(userId)) {
      nicknames[userId] = onlineByUserId.get(userId);
    } else {
      const name = getNicknameByUserId(userId);
      if (name) nicknames[userId] = name;
    }
  }

  send(client.ws, 'user:nicknames', { nicknames }, id);
}

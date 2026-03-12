import state from '../state.js';
import config from '../config.js';
import { send } from './handler.js';
import { PERMISSIONS } from '../permissions.js';
import { deleteChannelMessages, deleteMessagesByUser, getNicknameOwner } from '../db/database.js';

/** @type {Record<string, function>} */
const COMMANDS = {
  clear: handleClear,
  purge: handlePurge,
};

/**
 * Dispatches a chat command by name.
 * @param {object} client
 * @param {object} data
 * @param {string} [msgId]
 */
export function handleChatCommand(client, data, msgId) {
  const { name, channelId } = data;

  if (!name || typeof name !== 'string') {
    return send(client.ws, 'server:error', { code: 'INVALID_COMMAND', message: 'Command name required.' }, msgId);
  }

  const handler = COMMANDS[name];
  if (!handler) {
    return send(client.ws, 'server:error', { code: 'UNKNOWN_COMMAND', message: `Unknown command: /${name}` }, msgId);
  }

  handler(client, data, msgId);
}

/**
 * Clears all chat messages in a channel.
 * @param {object} client
 * @param {object} data
 * @param {string} [msgId]
 */
function handleClear(client, data, msgId) {
  const { channelId } = data;

  if (!channelId) {
    return send(client.ws, 'server:error', { code: 'INVALID_COMMAND', message: 'channelId required.' }, msgId);
  }

  if (client.channelId !== channelId && !client.chatSubscriptions.has(channelId)) {
    return send(client.ws, 'server:error', { code: 'NOT_IN_CHANNEL', message: 'You are not in this channel.' }, msgId);
  }

  if (!client.permissions.has(PERMISSIONS.CHAT_SLASH_CLEAR)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'You do not have permission to use /clear.' }, msgId);
  }

  if (config.chat.persistMessages) {
    deleteChannelMessages(channelId);
  }

  const channel = state.channels.get(channelId);
  if (channel) {
    const notified = new Set();
    for (const peerId of channel.clients) {
      const peer = state.clients.get(peerId);
      if (peer) {
        send(peer.ws, 'chat:cleared', { channelId });
        notified.add(peer.id);
      }
    }
    for (const peer of state.clients.values()) {
      if (!notified.has(peer.id) && peer.chatSubscriptions.has(channelId)) {
        send(peer.ws, 'chat:cleared', { channelId });
      }
    }
  }
}

/**
 * Purges all messages from a user across all channels.
 * @param {object} client
 * @param {object} data
 * @param {string} [msgId]
 */
function handlePurge(client, data, msgId) {
  let { nickname } = data;

  if (!nickname || typeof nickname !== 'string') {
    return send(client.ws, 'server:error', { code: 'INVALID_COMMAND', message: 'Usage: /purge <nickname>' }, msgId);
  }

  if (nickname.startsWith('@')) nickname = nickname.slice(1);

  if (!client.permissions.has(PERMISSIONS.CHAT_SLASH_PURGE)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'You do not have permission to use /purge.' }, msgId);
  }

  let targetClientId = null;
  let targetUserId = null;

  for (const c of state.clients.values()) {
    if (c.nickname.toLowerCase() === nickname.toLowerCase()) {
      targetClientId = c.id;
      targetUserId = c.userId || null;
      break;
    }
  }

  if (!targetClientId) {
    const userId = getNicknameOwner(nickname);
    if (userId) {
      targetUserId = userId;
    }
  }

  if (!targetClientId && !targetUserId) {
    return send(client.ws, 'server:error', { code: 'USER_NOT_FOUND', message: `User "${nickname}" not found.` }, msgId);
  }

  if (config.chat.persistMessages) {
    deleteMessagesByUser(targetClientId, targetUserId);
  }

  for (const peer of state.clients.values()) {
    send(peer.ws, 'chat:purged', { clientId: targetClientId, userId: targetUserId });
  }
}

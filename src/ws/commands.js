import state from '../state.js';
import config from '../config.js';
import { send } from './handler.js';
import { PERMISSIONS } from '../permissions.js';
import { deleteChannelMessages } from '../db/database.js';

/** @type {Record<string, function>} */
const COMMANDS = {
  clear: handleClear,
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

  if (client.channelId !== channelId) {
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
    for (const peerId of channel.clients) {
      const peer = state.clients.get(peerId);
      if (peer) {
        send(peer.ws, 'chat:cleared', { channelId });
      }
    }
  }
}

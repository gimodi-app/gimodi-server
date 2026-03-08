import state from '../state.js';
import { send } from './handler.js';
import logger from '../logger.js';

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleScreenStart(client, data, id) {
  logger.info(`[voice] ${client.nickname}: screen share started`);
  const channel = state.channels.get(client.channelId);
  if (!channel) return;

  for (const peerId of channel.clients) {
    if (peerId === client.id) continue;
    const peer = state.clients.get(peerId);
    if (peer) {
      send(peer.ws, 'screen:started', {
        clientId: client.id,
        userId: client.userId || null,
        nickname: client.nickname,
      });
    }
  }

  send(client.ws, 'screen:start-ok', {}, id);
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleScreenStop(client, data, id) {
  logger.info(`[voice] ${client.nickname}: screen share stopped`);
  for (const [producerId, producer] of client.producers) {
    if (producer.appData?.screen) {
      producer.close();
      client.producers.delete(producerId);
    }
  }

  const channel = state.channels.get(client.channelId);
  if (!channel) return;

  for (const peerId of channel.clients) {
    if (peerId === client.id) continue;
    const peer = state.clients.get(peerId);
    if (peer) {
      send(peer.ws, 'screen:stopped', { clientId: client.id });
    }
  }

  send(client.ws, 'screen:stop-ok', {}, id);
}

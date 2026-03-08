import state from '../state.js';
import { send } from './handler.js';
import logger from '../logger.js';

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleWebcamStart(client, data, id) {
  logger.info(`[voice] ${client.nickname}: webcam started`);
  const channel = state.channels.get(client.channelId);
  if (!channel) return;

  for (const peerId of channel.clients) {
    if (peerId === client.id) continue;
    const peer = state.clients.get(peerId);
    if (peer) {
      send(peer.ws, 'webcam:started', {
        clientId: client.id,
        userId: client.userId || null,
        nickname: client.nickname,
      });
    }
  }

  send(client.ws, 'webcam:start-ok', {}, id);
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleWebcamStop(client, data, id) {
  logger.info(`[voice] ${client.nickname}: webcam stopped`);
  for (const [producerId, producer] of client.producers) {
    if (producer.appData?.webcam) {
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
      send(peer.ws, 'webcam:stopped', { clientId: client.id });
    }
  }

  send(client.ws, 'webcam:stop-ok', {}, id);
}

import state from '../state.js';
import { PERMISSIONS } from '../permissions.js';
import { send } from './handler.js';
import logger from '../logger.js';
import { ensureRouter, createWebRtcTransport, createConsumersForProducer, consumeExistingProducers } from '../media/room.js';

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id] - Request ID for response matching
 */
export async function handleGetRtpCapabilities(client, data, id) {
  if (!client.channelId) {
    return send(client.ws, 'server:error', { code: 'NOT_IN_CHANNEL', message: 'You must join a channel first.' }, id);
  }
  logger.info(`[voice] ${client.nickname}: get-rtp-capabilities (channel=${client.channelId})`);
  const router = await ensureRouter(client.channelId);
  if (!router) {
    logger.error(`[voice] ${client.nickname}: no router for channel ${client.channelId}`);
    return send(client.ws, 'server:error', { code: 'NO_ROUTER', message: 'No router for channel.' }, id);
  }
  logger.info(`[voice] ${client.nickname}: sending router RTP capabilities`);
  send(client.ws, 'voice:rtp-capabilities', { rtpCapabilities: router.rtpCapabilities }, id);
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleRtpCapabilities(client, data, id) {
  client.rtpCapabilities = data.rtpCapabilities;
  logger.info(`[voice] ${client.nickname}: stored client RTP capabilities`);
  send(client.ws, 'voice:rtp-capabilities-ok', {}, id);
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export async function handleCreateTransport(client, data, id) {
  const { direction } = data;
  logger.info(`[voice] ${client.nickname}: create-transport direction=${direction}`);

  const router = await ensureRouter(client.channelId);
  if (!router) {
    logger.error(`[voice] ${client.nickname}: no router for channel ${client.channelId}`);
    return send(client.ws, 'server:error', { code: 'NO_ROUTER', message: 'No router for channel.' }, id);
  }

  const { transport, params } = await createWebRtcTransport(router);
  logger.info(`[voice] ${client.nickname}: ${direction} transport created id=${transport.id}`);
  logger.info(`[voice] ${client.nickname}: ICE candidates: ${params.iceCandidates.length}, first=${JSON.stringify(params.iceCandidates[0])}`);

  if (direction === 'send') {
    client.sendTransport = transport;
  } else {
    client.recvTransport = transport;
  }

  transport.on('dtlsstatechange', (dtlsState) => {
    logger.info(`[voice] ${client.nickname}: ${direction} transport DTLS state -> ${dtlsState}`);
  });
  transport.on('icestatechange', (iceState) => {
    logger.info(`[voice] ${client.nickname}: ${direction} transport ICE state -> ${iceState}`);
  });

  send(client.ws, 'voice:transport-created', { direction, ...params }, id);

  if (direction === 'recv' && client.rtpCapabilities) {
    logger.info(`[voice] ${client.nickname}: recv transport ready, consuming existing producers...`);
    await consumeExistingProducers(client);
  }
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export async function handleConnectTransport(client, data, id) {
  const { transportId, dtlsParameters } = data;

  const isSend = client.sendTransport?.id === transportId;
  const isRecv = client.recvTransport?.id === transportId;
  const transport = (isSend && client.sendTransport) || (isRecv && client.recvTransport);

  logger.info(`[voice] ${client.nickname}: connect-transport id=${transportId} (${isSend ? 'send' : isRecv ? 'recv' : 'UNKNOWN'})`);

  if (!transport) {
    logger.error(`[voice] ${client.nickname}: transport not found id=${transportId}`);
    return send(client.ws, 'server:error', { code: 'UNKNOWN_TRANSPORT', message: 'Transport not found.' }, id);
  }

  await transport.connect({ dtlsParameters });
  logger.info(`[voice] ${client.nickname}: transport connected id=${transportId}`);
  send(client.ws, 'voice:transport-connected', { transportId }, id);
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export async function handleProduce(client, data, id) {
  const { transportId, kind, rtpParameters, appData } = data;
  logger.info(`[voice] ${client.nickname}: produce kind=${kind} appData=${JSON.stringify(appData || {})}`);

  const channel = state.channels.get(client.channelId);
  if (channel && channel.moderated && !client.permissions.has(PERMISSIONS.CHANNEL_BYPASS_MODERATION) && !channel.voiceGranted.has(client.id)) {
    const mediaType = appData?.screen ? 'share your screen' : appData?.webcam ? 'use your webcam' : 'speak';
    return send(client.ws, 'server:error', { code: 'MODERATED', message: `This channel is moderated. You need voice permission to ${mediaType}.` }, id);
  }

  if (!client.sendTransport || client.sendTransport.id !== transportId) {
    logger.error(`[voice] ${client.nickname}: send transport mismatch expected=${client.sendTransport?.id} got=${transportId}`);
    return send(client.ws, 'server:error', { code: 'UNKNOWN_TRANSPORT', message: 'Send transport not found.' }, id);
  }

  const producer = await client.sendTransport.produce({
    kind,
    rtpParameters,
    appData: appData || {},
  });

  client.producers.set(producer.id, producer);
  logger.info(`[voice] ${client.nickname}: producer created id=${producer.id} kind=${kind}`);

  producer.on('transportclose', () => {
    logger.info(`[voice] ${client.nickname}: producer ${producer.id} closed (transport closed)`);
    client.producers.delete(producer.id);
  });

  send(client.ws, 'voice:produced', { producerId: producer.id }, id);

  logger.info(`[voice] ${client.nickname}: creating consumers for producer ${producer.id} on peers...`);
  await createConsumersForProducer(client, producer);
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export async function handleConsumerResume(client, data, id) {
  const { consumerId } = data;
  const consumer = client.consumers.get(consumerId);
  if (!consumer) {
    logger.error(`[voice] ${client.nickname}: consumer not found id=${consumerId}`);
    return send(client.ws, 'server:error', { code: 'UNKNOWN_CONSUMER', message: 'Consumer not found.' }, id);
  }

  await consumer.resume();
  logger.info(`[voice] ${client.nickname}: consumer resumed id=${consumerId} kind=${consumer.kind}`);
  send(client.ws, 'voice:consumer-resumed', { consumerId }, id);
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleMuteState(client, data, id) {
  const { muted, deafened } = data;
  client.muted = !!muted;
  client.deafened = !!deafened;

  const channel = state.channels.get(client.channelId);
  if (!channel) return;

  for (const peerId of channel.clients) {
    if (peerId === client.id) continue;
    const peer = state.clients.get(peerId);
    if (peer) {
      send(peer.ws, 'voice:mute-state-changed', {
        clientId: client.id,
        muted: client.muted,
        deafened: client.deafened,
      });
    }
  }
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleVoiceRequest(client, data, id) {
  const channel = state.channels.get(client.channelId);
  if (!channel || !channel.moderated) {
    return send(client.ws, 'server:error', { code: 'NOT_MODERATED', message: 'Channel is not moderated.' }, id);
  }
  channel.voiceRequests.add(client.id);
  for (const peer of state.clients.values()) {
    send(peer.ws, 'channel:voice-requested', { channelId: channel.id, clientId: client.id, nickname: client.nickname });
  }
  send(client.ws, 'voice:request-ok', {}, id);
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleVoiceCancelRequest(client, data, id) {
  const channel = state.channels.get(client.channelId);
  if (!channel || !channel.moderated) {
    return send(client.ws, 'server:error', { code: 'NOT_MODERATED', message: 'Channel is not moderated.' }, id);
  }
  channel.voiceRequests.delete(client.id);
  for (const peer of state.clients.values()) {
    send(peer.ws, 'channel:voice-request-cancelled', { channelId: channel.id, clientId: client.id });
  }
  send(client.ws, 'voice:cancel-request-ok', {}, id);
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleGrantVoice(client, data, id) {
  if (!client.permissions.has(PERMISSIONS.VOICE_GRANT)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'Admin access required.' }, id);
  }
  const { clientId } = data;
  const channel = state.channels.get(client.channelId);
  if (!channel || !channel.moderated) {
    return send(client.ws, 'server:error', { code: 'NOT_MODERATED', message: 'Channel is not moderated.' }, id);
  }
  const target = state.clients.get(clientId);
  if (!target || target.channelId !== client.channelId) {
    return send(client.ws, 'server:error', { code: 'CLIENT_NOT_FOUND', message: 'Client not found in this channel.' }, id);
  }
  channel.voiceGranted.add(clientId);
  channel.voiceRequests.delete(clientId);
  for (const peer of state.clients.values()) {
    send(peer.ws, 'channel:voice-granted', { channelId: channel.id, clientId });
  }
  send(client.ws, 'admin:grant-voice-ok', { clientId }, id);
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleRevokeVoice(client, data, id) {
  if (!client.permissions.has(PERMISSIONS.VOICE_REVOKE)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'Admin access required.' }, id);
  }
  const { clientId } = data;
  const channel = state.channels.get(client.channelId);
  if (!channel || !channel.moderated) {
    return send(client.ws, 'server:error', { code: 'NOT_MODERATED', message: 'Channel is not moderated.' }, id);
  }
  const target = state.clients.get(clientId);
  if (!target || target.channelId !== client.channelId) {
    return send(client.ws, 'server:error', { code: 'CLIENT_NOT_FOUND', message: 'Client not found in this channel.' }, id);
  }
  channel.voiceGranted.delete(clientId);
  for (const [producerId, producer] of target.producers) {
    if (producer.kind === 'audio' && !producer.appData?.screen) {
      producer.close();
      target.producers.delete(producerId);
    }
  }
  for (const peer of state.clients.values()) {
    send(peer.ws, 'channel:voice-revoked', { channelId: channel.id, clientId });
  }
  send(client.ws, 'admin:revoke-voice-ok', { clientId }, id);
}

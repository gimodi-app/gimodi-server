import { createRouter } from './workers.js';
import state from '../state.js';
import logger from '../logger.js';

/**
 * Ensures a mediasoup Router exists for the given channel, creating one if needed.
 * @param {string} channelId
 * @returns {Promise<import('mediasoup').types.Router|null>}
 */
export async function ensureRouter(channelId) {
  const channel = state.channels.get(channelId);
  if (!channel) {
    return null;
  }
  if (!channel.router) {
    channel.router = await createRouter();
    logger.info(`[media] Created Router for channel "${channel.name}" (${channelId})`);
  }
  return channel.router;
}

/**
 * Closes the Router for a channel if no clients remain.
 * @param {string} channelId
 */
export function maybeCloseRouter(channelId) {
  const channel = state.channels.get(channelId);
  if (!channel || !channel.router) {
    return;
  }
  if (channel.clients.size === 0) {
    channel.router.close();
    channel.router = null;
    logger.info(`[media] Closed Router for channel "${channel.name}" (${channelId})`);
  }
}

/**
 * Creates a WebRTC transport on the given Router.
 * @param {import('mediasoup').types.Router} router
 * @returns {Promise<{transport: import('mediasoup').types.WebRtcTransport, params: object}>}
 */
export async function createWebRtcTransport(router) {
  logger.info(`[media] Creating WebRtcTransport via WebRtcServer`);

  const transport = await router.createWebRtcTransport({
    webRtcServer: router._webRtcServer,
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
  });

  return {
    transport,
    params: {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    },
  };
}

/**
 * Closes all media transports, producers, and consumers for a client.
 * @param {object} client
 */
export function cleanupClientMedia(client) {
  const consumerCount = client.consumers?.size || 0;
  const producerCount = client.producers?.size || 0;
  logger.info(`[media] Cleaning up ${client.nickname}: ${producerCount} producers, ${consumerCount} consumers`);

  if (client.consumers) {
    for (const consumer of client.consumers.values()) {
      consumer.close();
    }
    client.consumers.clear();
  }

  if (client.producers) {
    for (const producer of client.producers.values()) {
      producer.close();
    }
    client.producers.clear();
  }

  if (client.sendTransport) {
    client.sendTransport.close();
    client.sendTransport = null;
  }
  if (client.recvTransport) {
    client.recvTransport.close();
    client.recvTransport = null;
  }
}

/**
 * Creates consumers on all peers in the channel for a new producer.
 * @param {object} producerClient
 * @param {import('mediasoup').types.Producer} producer
 */
export async function createConsumersForProducer(producerClient, producer) {
  const channel = state.channels.get(producerClient.channelId);
  if (!channel || !channel.router) {
    logger.info(`[media] createConsumersForProducer: no channel/router`);
    return;
  }

  const peers = [...channel.clients].filter((id) => id !== producerClient.id);
  logger.info(`[media] Creating consumers for producer ${producer.id} (${producer.kind}) from ${producerClient.nickname} -> ${peers.length} peer(s)`);

  for (const clientId of peers) {
    const peer = state.clients.get(clientId);
    if (!peer) {
      logger.info(`[media]   skip ${clientId}: not found`);
      continue;
    }
    if (!peer.recvTransport) {
      logger.info(`[media]   skip ${peer.nickname}: no recvTransport`);
      continue;
    }
    if (!peer.rtpCapabilities) {
      logger.info(`[media]   skip ${peer.nickname}: no rtpCapabilities`);
      continue;
    }

    if (!channel.router.canConsume({ producerId: producer.id, rtpCapabilities: peer.rtpCapabilities })) {
      logger.info(`[media]   skip ${peer.nickname}: canConsume=false`);
      continue;
    }

    try {
      const consumer = await peer.recvTransport.consume({
        producerId: producer.id,
        rtpCapabilities: peer.rtpCapabilities,
        paused: true,
      });

      peer.consumers.set(consumer.id, consumer);
      logger.info(`[media]   -> ${peer.nickname}: consumer ${consumer.id} (${consumer.kind}) created`);

      send(peer.ws, 'voice:consume', {
        consumerId: consumer.id,
        producerId: producer.id,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        clientId: producerClient.id,
        nickname: producerClient.nickname,
        screen: !!producer.appData?.screen,
        screenAudio: !!producer.appData?.screenAudio,
        webcam: !!producer.appData?.webcam,
      });
    } catch (err) {
      logger.error(`[media]   FAIL ${peer.nickname}: ${err.message}`);
    }
  }
}

/**
 * Consumes all existing producers in a channel for a newly joined client.
 * @param {object} newClient
 */
export async function consumeExistingProducers(newClient) {
  const channel = state.channels.get(newClient.channelId);
  if (!channel || !channel.router) {
    logger.info(`[media] consumeExisting: no channel/router for ${newClient.nickname}`);
    return;
  }
  if (!newClient.recvTransport) {
    logger.info(`[media] consumeExisting: ${newClient.nickname} has no recvTransport`);
    return;
  }
  if (!newClient.rtpCapabilities) {
    logger.info(`[media] consumeExisting: ${newClient.nickname} has no rtpCapabilities`);
    return;
  }

  const peers = [...channel.clients].filter((id) => id !== newClient.id);
  logger.info(`[media] consumeExisting for ${newClient.nickname}: checking ${peers.length} peer(s)`);

  for (const clientId of peers) {
    const peer = state.clients.get(clientId);
    if (!peer || !peer.producers) {
      continue;
    }

    logger.info(`[media]   peer ${peer.nickname}: ${peer.producers.size} producer(s)`);

    let hasScreen = false;
    let hasWebcam = false;

    for (const producer of peer.producers.values()) {
      if (producer.appData?.screen) {
        hasScreen = true;
      }
      if (producer.appData?.webcam) {
        hasWebcam = true;
      }

      if (!channel.router.canConsume({ producerId: producer.id, rtpCapabilities: newClient.rtpCapabilities })) {
        logger.info(`[media]   skip producer ${producer.id}: canConsume=false`);
        continue;
      }

      try {
        const consumer = await newClient.recvTransport.consume({
          producerId: producer.id,
          rtpCapabilities: newClient.rtpCapabilities,
          paused: true,
        });

        newClient.consumers.set(consumer.id, consumer);
        logger.info(`[media]   -> consuming ${peer.nickname}'s producer ${producer.id} (${consumer.kind}) as consumer ${consumer.id}`);

        send(newClient.ws, 'voice:consume', {
          consumerId: consumer.id,
          producerId: producer.id,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
          clientId: peer.id,
          nickname: peer.nickname,
          screen: !!producer.appData?.screen,
          screenAudio: !!producer.appData?.screenAudio,
          webcam: !!producer.appData?.webcam,
        });
      } catch (err) {
        logger.error(`[media]   FAIL consume from ${peer.nickname}: ${err.message}`);
      }
    }

    if (hasScreen) {
      send(newClient.ws, 'screen:started', {
        clientId: peer.id,
        userId: peer.userId || null,
        nickname: peer.nickname,
      });
    }
    if (hasWebcam) {
      send(newClient.ws, 'webcam:started', {
        clientId: peer.id,
        userId: peer.userId || null,
        nickname: peer.nickname,
      });
    }
  }
}

/**
 * Sends a JSON message over a WebSocket (local helper to avoid circular import with handler.js).
 * @param {import('ws').WebSocket} ws
 * @param {string} type
 * @param {object} data
 * @param {string} [id]
 */
function send(ws, type, data, id) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type, data, ...(id && { id }) }));
  }
}

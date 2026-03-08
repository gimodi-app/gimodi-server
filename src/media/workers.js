import mediasoup from 'mediasoup';
import { cpus } from 'node:os';
import config from '../config.js';
import logger from '../logger.js';

/** @type {import('mediasoup').types.Worker[]} */
const workers = [];

/** @type {import('mediasoup').types.WebRtcServer[]} */
const webRtcServers = [];

let nextWorkerIdx = 0;

/** @type {import('mediasoup').types.RtpCodecCapability[]} */
const mediaCodecs = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: {
      'x-google-start-bitrate': 1000,
    },
  },
];

/**
 * Creates mediasoup Workers and their associated WebRtcServers.
 */
export async function initWorkers() {
  const numWorkers = config.media.workers > 0 ? config.media.workers : Math.max(1, cpus().length);
  const basePort = config.media.rtcPort;
  const listenIp = config.media.listenIp || '0.0.0.0';
  const announcedAddress = config.media.announcedIp || undefined;

  logger.info(`Creating ${numWorkers} mediasoup Worker(s)...`);

  for (let i = 0; i < numWorkers; i++) {
    const worker = await mediasoup.createWorker({
      logLevel: config.media.logLevel,
    });

    worker.on('died', () => {
      if (workers.length > 0) {
        logger.error(`mediasoup Worker ${worker.pid} died unexpectedly, exiting.`);
        process.exit(1);
      }
    });

    const port = basePort + i;
    const webRtcServer = await worker.createWebRtcServer({
      listenInfos: [
        { protocol: 'udp', ip: listenIp, announcedAddress, port },
        { protocol: 'tcp', ip: listenIp, announcedAddress, port },
      ],
    });

    workers.push(worker);
    webRtcServers.push(webRtcServer);

    logger.info(`  Worker ${worker.pid} → WebRtcServer on port ${port}`);
  }

  logger.info(`mediasoup Workers ready (ports ${basePort}-${basePort + numWorkers - 1}).`);
}

/**
 * Returns the next Worker and WebRtcServer in round-robin fashion.
 * @returns {{worker: import('mediasoup').types.Worker, webRtcServer: import('mediasoup').types.WebRtcServer}}
 */
export function getNextWorker() {
  const idx = nextWorkerIdx;
  nextWorkerIdx = (nextWorkerIdx + 1) % workers.length;
  return { worker: workers[idx], webRtcServer: webRtcServers[idx] };
}

/**
 * Creates a new mediasoup Router on the next available Worker.
 * @returns {Promise<import('mediasoup').types.Router>}
 */
export async function createRouter() {
  const { worker, webRtcServer } = getNextWorker();
  const router = await worker.createRouter({ mediaCodecs });
  router._webRtcServer = webRtcServer;
  return router;
}

/**
 * Returns the configured media codecs.
 * @returns {import('mediasoup').types.RtpCodecCapability[]}
 */
export function getMediaCodecs() {
  return mediaCodecs;
}

/**
 * Closes all WebRtcServers and Workers.
 */
export function closeWorkers() {
  for (const server of webRtcServers) {
    server.close();
  }
  webRtcServers.length = 0;
  for (const worker of workers) {
    worker.close();
  }
  workers.length = 0;
}

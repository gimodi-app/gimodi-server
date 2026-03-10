import state from './state.js';
import config from './config.js';

const startTime = Date.now();

const counters = {
  messagesTotal: 0,
  dmMessagesTotal: 0,
  filesUploadedTotal: 0,
  websocketMessagesTotal: 0,
  connectionsTotal: 0,
};

/**
 * Increments a counter metric by the given amount.
 * @param {keyof counters} name
 * @param {number} [amount]
 */
export function incrementCounter(name, amount = 1) {
  if (name in counters) {
    counters[name] += amount;
  }
}

/**
 * Collects all metrics and returns Prometheus exposition format text.
 * @returns {string}
 */
export function collectMetrics() {
  const lines = [];

  const connectedClients = state.clients.size;
  const totalChannels = state.channels.size;
  let activeChannels = 0;
  let voiceRooms = 0;
  let totalProducers = 0;
  let totalConsumers = 0;
  let screenShares = 0;
  let webcamStreams = 0;

  for (const channel of state.channels.values()) {
    if (channel.clients.size > 0) activeChannels++;
    if (channel.router) voiceRooms++;
  }

  for (const client of state.clients.values()) {
    if (client.producers) {
      for (const producer of client.producers.values()) {
        totalProducers++;
        if (producer.appData?.screen || producer.appData?.screenAudio) screenShares++;
        if (producer.appData?.webcam) webcamStreams++;
      }
    }
    if (client.consumers) totalConsumers += client.consumers.size;
  }

  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);

  lines.push('# HELP gimodi_server_info Server metadata.');
  lines.push('# TYPE gimodi_server_info gauge');
  lines.push(`gimodi_server_info{name=${escapeLabel(config.name)}} 1`);

  lines.push('# HELP gimodi_server_uptime_seconds Time since server started.');
  lines.push('# TYPE gimodi_server_uptime_seconds gauge');
  lines.push(`gimodi_server_uptime_seconds ${uptimeSeconds}`);

  lines.push('# HELP gimodi_clients_connected Current number of connected clients.');
  lines.push('# TYPE gimodi_clients_connected gauge');
  lines.push(`gimodi_clients_connected ${connectedClients}`);

  lines.push('# HELP gimodi_clients_max Maximum allowed concurrent clients.');
  lines.push('# TYPE gimodi_clients_max gauge');
  lines.push(`gimodi_clients_max ${config.maxClients}`);

  lines.push('# HELP gimodi_channels_total Total number of channels.');
  lines.push('# TYPE gimodi_channels_total gauge');
  lines.push(`gimodi_channels_total ${totalChannels}`);

  lines.push('# HELP gimodi_channels_active Channels with at least one client.');
  lines.push('# TYPE gimodi_channels_active gauge');
  lines.push(`gimodi_channels_active ${activeChannels}`);

  lines.push('# HELP gimodi_voice_rooms_active Channels with an active voice router.');
  lines.push('# TYPE gimodi_voice_rooms_active gauge');
  lines.push(`gimodi_voice_rooms_active ${voiceRooms}`);

  lines.push('# HELP gimodi_voice_producers_total Current number of active media producers.');
  lines.push('# TYPE gimodi_voice_producers_total gauge');
  lines.push(`gimodi_voice_producers_total ${totalProducers}`);

  lines.push('# HELP gimodi_voice_consumers_total Current number of active media consumers.');
  lines.push('# TYPE gimodi_voice_consumers_total gauge');
  lines.push(`gimodi_voice_consumers_total ${totalConsumers}`);

  lines.push('# HELP gimodi_screen_shares_active Current number of active screen shares.');
  lines.push('# TYPE gimodi_screen_shares_active gauge');
  lines.push(`gimodi_screen_shares_active ${screenShares}`);

  lines.push('# HELP gimodi_webcam_streams_active Current number of active webcam streams.');
  lines.push('# TYPE gimodi_webcam_streams_active gauge');
  lines.push(`gimodi_webcam_streams_active ${webcamStreams}`);

  lines.push('# HELP gimodi_connections_total Total client connections since server start.');
  lines.push('# TYPE gimodi_connections_total counter');
  lines.push(`gimodi_connections_total ${counters.connectionsTotal}`);

  lines.push('# HELP gimodi_messages_total Total chat messages sent since server start.');
  lines.push('# TYPE gimodi_messages_total counter');
  lines.push(`gimodi_messages_total ${counters.messagesTotal}`);

  lines.push('# HELP gimodi_dm_messages_total Total direct messages sent since server start.');
  lines.push('# TYPE gimodi_dm_messages_total counter');
  lines.push(`gimodi_dm_messages_total ${counters.dmMessagesTotal}`);

  lines.push('# HELP gimodi_files_uploaded_total Total files uploaded since server start.');
  lines.push('# TYPE gimodi_files_uploaded_total counter');
  lines.push(`gimodi_files_uploaded_total ${counters.filesUploadedTotal}`);

  lines.push('# HELP gimodi_websocket_messages_total Total WebSocket messages processed since server start.');
  lines.push('# TYPE gimodi_websocket_messages_total counter');
  lines.push(`gimodi_websocket_messages_total ${counters.websocketMessagesTotal}`);

  lines.push('');
  return lines.join('\n');
}

/**
 * Escapes a string for use as a Prometheus label value.
 * @param {string} str
 * @returns {string}
 */
function escapeLabel(str) {
  return '"' + String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}

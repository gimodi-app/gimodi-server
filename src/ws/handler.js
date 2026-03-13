import { WebSocketServer } from 'ws';
import state from '../state.js';
import logger from '../logger.js';
import config from '../config.js';
import { handleConnect, handleDisconnect } from './connection.js';
import { handleJoinChannel, handleLeaveChannel, handleCreateChannel, handleDeleteChannel, handleUpdateChannel, handleListChannels } from './channels.js';
import {
  handleChatSend,
  handleChatHistory,
  handleChatContext,
  handleChatDelete,
  handleChatEdit,
  handleRemovePreview,
  handleServerChatSend,
  handleServerChatHistory,
  handleServerChatDelete,
  handleTypingIndicator,
  handleReact,
  handleUnreact,
  handlePinMessage,
  handleUnpinMessage,
  handleChatSubscribe,
  handleChatUnsubscribe,
  handleFileList,
  handleFileDelete,
  handleChatSearch,
} from './chat.js';
import { handleChatCommand } from './commands.js';
import {
  handleGetRtpCapabilities,
  handleRtpCapabilities,
  handleCreateTransport,
  handleConnectTransport,
  handleProduce,
  handleConsumerResume,
  handleMuteState,
  handleVoiceRequest,
  handleVoiceCancelRequest,
  handleGrantVoice,
  handleRevokeVoice,
} from './voice.js';
import { handleScreenStart, handleScreenStop } from './screen.js';
import { handleWebcamStart, handleWebcamStop } from './webcam.js';
import { handleTokenRedeem, handleTokenList, handleTokenCreate, handleTokenDelete } from './tokens.js';
import {
  handleGetUserRoles,
  handleAssignRole,
  handleRemoveRole,
  handleAssignRoleByUserId,
  handleRemoveRoleByUserId,
  handleGetUserRolesByUserId,
  handleRoleList,
  handleRoleListPermissions,
  handleRoleCreate,
  handleRoleUpdate,
  handleRoleDelete,
  handleRoleSetPermissions,
  handleRoleGetMembers,
  handleRoleRemoveMember,
  handleRoleReorder,
} from './roles.js';
import {
  handleKick,
  handleBan,
  handlePoke,
  handleListBans,
  handleRemoveBan,
  handleGetAuditLog,
  handleMoveUser,
  handleListUsers,
  handleDeleteUser,
  handleBulkDeleteUsers,
  handleBanByUserId,
  handleDeleteNickname,
  handleAddNickname,
  handleGetAnalytics,
} from './admin.js';
import { handleGetUserInfo, handleGetPublicKey, handleGetNicknames } from './users.js';
import { handleGetSettings, handleSetSettings } from './settings.js';
import { handleDmSend, handleDmHistory, handleDmDelete, handleDmConversations } from './dm.js';
import { handlePresenceSubscribe, handlePresenceUnsubscribe } from './presence.js';
import { incrementCounter } from '../metrics.js';

let wss;

/** @type {Map<string, number>} */
const ipConnectionCounts = new Map();

const HEARTBEAT_TIMEOUT = 20_000;
const HEARTBEAT_INTERVAL = 10_000;

/**
 * Initializes the WebSocket server and attaches it to the given HTTP server.
 * @param {import('node:https').Server} server
 */
export function initWebSocket(server) {
  wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

  setInterval(() => {
    for (const client of state.clients.values()) {
      send(client.ws, 'server:ping', {});
    }
  }, HEARTBEAT_INTERVAL);

  wss.on('connection', (ws, req) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
    ws._ip = ip;

    const maxPerIp = config.maxConnectionsPerIp;
    if (maxPerIp > 0) {
      const current = ipConnectionCounts.get(ip) || 0;
      if (current >= maxPerIp) {
        send(ws, 'server:error', { code: 'TOO_MANY_CONNECTIONS', message: 'Too many connections from your IP address.' });
        ws.close();
        return;
      }
      ipConnectionCounts.set(ip, current + 1);
    }

    let heartbeatTimer = setTimeout(() => ws.terminate(), HEARTBEAT_TIMEOUT);
    const resetHeartbeat = () => {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = setTimeout(() => ws.terminate(), HEARTBEAT_TIMEOUT);
    };

    ws.on('message', (raw) => {
      resetHeartbeat();
      incrementCounter('websocketMessagesTotal');

      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return send(ws, 'server:error', { code: 'INVALID_JSON', message: 'Invalid JSON.' });
      }

      const { type, id, data } = msg;
      if (!type || typeof type !== 'string') {
        return send(ws, 'server:error', { code: 'INVALID_TYPE', message: 'Missing message type.' });
      }

      if (type === 'server:connect') {
        return handleConnect(ws, data || {}, id, ip);
      }

      const clientId = ws._clientId;
      if (!clientId) {
        return send(ws, 'server:error', { code: 'NOT_CONNECTED', message: 'Send server:connect first.' }, id);
      }

      const client = state.clients.get(clientId);
      if (!client) {
        return send(ws, 'server:error', { code: 'NOT_CONNECTED', message: 'Client not found.' }, id);
      }

      routeMessage(client, type, data || {}, id);
    });

    let closed = false;
    const onClose = () => {
      if (closed) {
        return;
      }
      closed = true;
      clearTimeout(heartbeatTimer);
      if (maxPerIp > 0) {
        const count = (ipConnectionCounts.get(ip) || 1) - 1;
        if (count <= 0) {
          ipConnectionCounts.delete(ip);
        } else {
          ipConnectionCounts.set(ip, count);
        }
      }
      handleDisconnect(ws);
    };
    ws.on('close', onClose);
    ws.on('error', onClose);
  });

  logger.info('WebSocket server attached.');
}

/**
 * Routes an incoming WebSocket message to the appropriate handler.
 * @param {object} client
 * @param {string} type - Message type (e.g. "channel:join")
 * @param {object} data - Message payload
 * @param {string} [id] - Request ID for response matching
 */
async function routeMessage(client, type, data, id) {
  try {
    switch (type) {
      case 'channel:join':
        return handleJoinChannel(client, data, id);
      case 'channel:leave':
        return handleLeaveChannel(client, data, id);
      case 'channel:create':
        return handleCreateChannel(client, data, id);
      case 'channel:delete':
        return handleDeleteChannel(client, data, id);
      case 'channel:update':
        return handleUpdateChannel(client, data, id);
      case 'channel:list':
        return handleListChannels(client, data, id);

      case 'user:get-info':
        return handleGetUserInfo(client, data, id);
      case 'user:get-public-key':
        return handleGetPublicKey(client, data, id);
      case 'user:get-nicknames':
        return handleGetNicknames(client, data, id);

      case 'chat:send':
        return handleChatSend(client, data, id);
      case 'chat:history':
        return handleChatHistory(client, data, id);
      case 'chat:context':
        return handleChatContext(client, data, id);
      case 'chat:delete':
        return handleChatDelete(client, data, id);
      case 'chat:edit':
        return handleChatEdit(client, data, id);
      case 'chat:remove-preview':
        return handleRemovePreview(client, data, id);
      case 'chat:server-send':
        return handleServerChatSend(client, data, id);
      case 'chat:server-history':
        return handleServerChatHistory(client, data, id);
      case 'chat:server-delete':
        return handleServerChatDelete(client, data, id);
      case 'chat:typing':
        return handleTypingIndicator(client, data, id);
      case 'chat:react':
        return handleReact(client, data, id);
      case 'chat:unreact':
        return handleUnreact(client, data, id);
      case 'chat:pin-message':
        return handlePinMessage(client, data, id);
      case 'chat:unpin-message':
        return handleUnpinMessage(client, data, id);
      case 'chat:command':
        return handleChatCommand(client, data, id);
      case 'chat:search':
        return handleChatSearch(client, data, id);
      case 'chat:subscribe':
        return handleChatSubscribe(client, data, id);
      case 'chat:unsubscribe':
        return handleChatUnsubscribe(client, data);

      case 'file:list':
        return handleFileList(client, data, id);
      case 'file:delete':
        return handleFileDelete(client, data, id);

      case 'voice:get-rtp-capabilities':
        return await handleGetRtpCapabilities(client, data, id);
      case 'voice:rtp-capabilities':
        return handleRtpCapabilities(client, data, id);
      case 'voice:create-transport':
        return await handleCreateTransport(client, data, id);
      case 'voice:connect-transport':
        return await handleConnectTransport(client, data, id);
      case 'voice:produce':
        return await handleProduce(client, data, id);
      case 'voice:consumer-resume':
        return await handleConsumerResume(client, data, id);
      case 'voice:mute-state':
        return handleMuteState(client, data, id);
      case 'voice:request':
        return handleVoiceRequest(client, data, id);
      case 'voice:cancel-request':
        return handleVoiceCancelRequest(client, data, id);

      case 'screen:start':
        return handleScreenStart(client, data, id);
      case 'screen:stop':
        return handleScreenStop(client, data, id);

      case 'webcam:start':
        return handleWebcamStart(client, data, id);
      case 'webcam:stop':
        return handleWebcamStop(client, data, id);

      case 'token:redeem':
        return handleTokenRedeem(client, data, id);
      case 'token:list':
        return handleTokenList(client, data, id);
      case 'token:create':
        return handleTokenCreate(client, data, id);
      case 'token:delete':
        return handleTokenDelete(client, data, id);

      case 'admin:get-user-roles':
        return handleGetUserRoles(client, data, id);
      case 'admin:assign-role':
        return handleAssignRole(client, data, id);
      case 'admin:remove-role':
        return handleRemoveRole(client, data, id);
      case 'admin:assign-role-by-userid':
        return handleAssignRoleByUserId(client, data, id);
      case 'admin:remove-role-by-userid':
        return handleRemoveRoleByUserId(client, data, id);
      case 'admin:get-user-roles-by-userid':
        return handleGetUserRolesByUserId(client, data, id);

      case 'role:list':
        return handleRoleList(client, data, id);
      case 'role:list-permissions':
        return handleRoleListPermissions(client, data, id);
      case 'role:create':
        return handleRoleCreate(client, data, id);
      case 'role:update':
        return handleRoleUpdate(client, data, id);
      case 'role:delete':
        return handleRoleDelete(client, data, id);
      case 'role:set-permissions':
        return handleRoleSetPermissions(client, data, id);
      case 'role:get-members':
        return handleRoleGetMembers(client, data, id);
      case 'role:remove-member':
        return handleRoleRemoveMember(client, data, id);
      case 'role:reorder':
        return handleRoleReorder(client, data, id);

      case 'admin:kick':
        return handleKick(client, data, id);
      case 'admin:ban':
        return handleBan(client, data, id);
      case 'admin:move-user':
        return await handleMoveUser(client, data, id);
      case 'admin:list-bans':
        return handleListBans(client, data, id);
      case 'admin:remove-ban':
        return handleRemoveBan(client, data, id);
      case 'admin:audit-log':
        return handleGetAuditLog(client, data, id);
      case 'admin:grant-voice':
        return handleGrantVoice(client, data, id);
      case 'admin:revoke-voice':
        return handleRevokeVoice(client, data, id);
      case 'admin:poke':
        return handlePoke(client, data, id);
      case 'admin:list-users':
        return handleListUsers(client, data, id);
      case 'admin:delete-user':
        return handleDeleteUser(client, data, id);
      case 'admin:bulk-delete-users':
        return handleBulkDeleteUsers(client, data, id);
      case 'admin:ban-user':
        return handleBanByUserId(client, data, id);
      case 'admin:delete-nickname':
        return handleDeleteNickname(client, data, id);
      case 'admin:add-nickname':
        return handleAddNickname(client, data, id);
      case 'admin:get-analytics':
        return handleGetAnalytics(client, data, id);

      case 'dm:send':
        return handleDmSend(client, data, id);
      case 'dm:history':
        return handleDmHistory(client, data, id);
      case 'dm:delete':
        return handleDmDelete(client, data, id);
      case 'dm:conversations':
        return handleDmConversations(client, data, id);

      case 'presence:subscribe':
        return handlePresenceSubscribe(client, data, id);
      case 'presence:unsubscribe':
        return handlePresenceUnsubscribe(client, data, id);

      case 'server:get-settings':
        return handleGetSettings(client, data, id);
      case 'server:set-settings':
        return handleSetSettings(client, data, id);

      case 'server:set-mode':
        return handleSetMode(client, data, id);

      case 'server:ping':
        return;

      default:
        return send(client.ws, 'server:error', { code: 'UNKNOWN_TYPE', message: `Unknown message type: ${type}` }, id);
    }
  } catch (err) {
    logger.error(`[ws] ERROR handling ${type} for ${client.nickname}: ${err.stack || err}`);
    send(client.ws, 'server:error', { code: 'INTERNAL_ERROR', message: err.message || 'Internal server error.' }, id);
  }
}

/**
 * Handles switching a client between active and background mode.
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
function handleSetMode(client, data, id) {
  const { mode } = data;
  if (mode !== 'active' && mode !== 'background') {
    return send(client.ws, 'server:error', { code: 'INVALID_MODE', message: 'Mode must be "active" or "background".' }, id);
  }
  client.mode = mode;
  send(client.ws, 'server:set-mode', { mode }, id);
}

const BACKGROUND_ALLOWED_PREFIXES = ['dm:', 'presence:', 'server:'];

/**
 * Checks whether a message type should be delivered to background clients.
 * @param {string} type
 * @returns {boolean}
 */
function isBackgroundAllowed(type) {
  return BACKGROUND_ALLOWED_PREFIXES.some((p) => type.startsWith(p));
}

/**
 * Sends a JSON message over a WebSocket connection.
 * @param {import('ws').WebSocket} ws
 * @param {string} type - Message type
 * @param {object} data - Message payload
 * @param {string} [id] - Request ID for response matching
 */
export function send(ws, type, data, id) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type, data, ...(id !== undefined && { id }) }));
  }
}

/**
 * Gracefully closes all WebSocket connections and shuts down the server.
 * @param {string} reason - Shutdown reason sent to clients
 */
export function closeWebSocket(reason) {
  if (!wss) {
    return;
  }
  for (const client of state.clients.values()) {
    send(client.ws, 'server:shutdown', { reason });
    client.ws.close();
  }
  wss.close();
}

/**
 * Broadcasts a message to all connected clients, optionally excluding one.
 * @param {string} type - Message type
 * @param {object} data - Message payload
 * @param {string} [excludeClientId] - Client ID to exclude from broadcast
 */
export function broadcast(type, data, excludeClientId) {
  const bgAllowed = isBackgroundAllowed(type);
  for (const client of state.clients.values()) {
    if (client.id === excludeClientId) {
      continue;
    }
    if (client.mode === 'background' && !bgAllowed) {
      continue;
    }
    send(client.ws, type, data);
  }
}

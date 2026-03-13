import { randomUUID } from 'node:crypto';
import state from '../state.js';
import { PERMISSIONS } from '../permissions.js';
import {
  addBan,
  getAllBans,
  deleteBan,
  logAuditEvent,
  getAuditLog,
  getIdentity,
  getAllIdentities,
  getUserRoles,
  deleteIdentity,
  deleteUserRoles,
  deleteUserDmMessages,
  getRegisteredNicknames,
  deleteNicknameRegistration,
  getNicknameOwner,
  registerNickname,
  getUserHighestRolePosition,
  getAnalyticsData,
} from '../db/database.js';
import { counters, startTime } from '../metrics.js';
import { send } from './handler.js';

/**
 * Checks whether the actor outranks the target in the role hierarchy.
 * @param {object} actor
 * @param {string|null} targetUserId
 * @returns {boolean}
 */
function actorOutranksTarget(actor, targetUserId) {
  const actorPos = actor.userId ? getUserHighestRolePosition(actor.userId) : Infinity;
  if (actorPos === 0) {
    return true;
  }
  const targetPos = targetUserId ? getUserHighestRolePosition(targetUserId) : Infinity;
  return actorPos < targetPos;
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleKick(client, data, id) {
  if (!client.permissions.has(PERMISSIONS.USER_KICK)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'Admin access required.' }, id);
  }
  const { clientId } = data;
  const target = state.clients.get(clientId);
  if (!target) {
    return send(client.ws, 'server:error', { code: 'CLIENT_NOT_FOUND', message: 'Client not found.' }, id);
  }
  if (!actorOutranksTarget(client, target.userId)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'You cannot kick a user with equal or higher rank.' }, id);
  }
  const reason = data.reason || 'Kicked by admin.';
  send(target.ws, 'server:kicked', { reason });
  target.ws.close();
  send(client.ws, 'admin:kick-ok', { clientId }, id);

  logAuditEvent('kick', client.userId, client.nickname, target.userId, target.nickname, reason);
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handlePoke(client, data, id) {
  if (!client.permissions.has(PERMISSIONS.USER_POKE)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'You do not have permission to poke users.' }, id);
  }
  const { clientId, message } = data;
  const target = state.clients.get(clientId);
  if (!target) {
    return send(client.ws, 'server:error', { code: 'CLIENT_NOT_FOUND', message: 'Client not found.' }, id);
  }
  if (clientId === client.id) {
    return send(client.ws, 'server:error', { code: 'INVALID_TARGET', message: 'You cannot poke yourself.' }, id);
  }
  if (!actorOutranksTarget(client, target.userId)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'You cannot poke a user with equal or higher rank.' }, id);
  }
  const pokeMessage = (typeof message === 'string' ? message.trim().slice(0, 200) : '') || null;
  send(target.ws, 'server:poked', { fromNickname: client.nickname, message: pokeMessage });
  send(client.ws, 'admin:poke-ok', { clientId }, id);
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleBan(client, data, id) {
  if (!client.permissions.has(PERMISSIONS.USER_BAN)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'Admin access required.' }, id);
  }
  const { clientId, reason, duration } = data;
  const target = state.clients.get(clientId);
  if (!target) {
    return send(client.ws, 'server:error', { code: 'CLIENT_NOT_FOUND', message: 'Client not found.' }, id);
  }
  if (!actorOutranksTarget(client, target.userId)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'You cannot ban a user with equal or higher rank.' }, id);
  }
  const expiresAt = duration && duration > 0 ? Date.now() + duration * 1000 : null;
  const banReason = reason || 'Banned by admin.';
  addBan({
    id: randomUUID(),
    ip: target.ip,
    nickname: target.nickname,
    reason: banReason,
    createdAt: Date.now(),
    expiresAt,
  });
  send(target.ws, 'server:banned', { reason: banReason });
  target.ws.close();
  send(client.ws, 'admin:ban-ok', { clientId }, id);

  const details = duration > 0 ? `Duration: ${duration}s, Reason: ${banReason}` : `Permanent, Reason: ${banReason}`;
  logAuditEvent('ban', client.userId, client.nickname, target.userId, target.nickname, details);
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleListBans(client, data, id) {
  if (!client.permissions.has(PERMISSIONS.BAN_LIST)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'Admin access required.' }, id);
  }
  const bans = getAllBans();
  const now = Date.now();
  const bansWithExpiry = bans.map((ban) => ({
    ...ban,
    isExpired: ban.expires_at ? ban.expires_at <= now : false,
  }));
  send(client.ws, 'admin:bans-list', { bans: bansWithExpiry }, id);
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleRemoveBan(client, data, id) {
  if (!client.permissions.has(PERMISSIONS.BAN_REMOVE)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'Admin access required.' }, id);
  }
  const { banId } = data;
  deleteBan(banId);
  send(client.ws, 'admin:ban-removed', { banId }, id);

  logAuditEvent('unban', client.userId, client.nickname, null, null, `Ban ID: ${banId}`);
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleGetAuditLog(client, data, id) {
  if (!client.permissions.has(PERMISSIONS.SERVER_ADMIN_MENU)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'Admin access required.' }, id);
  }
  const limit = Math.min(data.limit || 100, 500);
  const logs = getAuditLog(limit);
  send(client.ws, 'admin:audit-log-result', { logs }, id);
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export async function handleMoveUser(client, data, id) {
  if (!client.permissions.has(PERMISSIONS.USER_MOVE)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'Admin access required.' }, id);
  }
  const { clientId, channelId } = data;
  const target = state.clients.get(clientId);
  if (!target) {
    return send(client.ws, 'server:error', { code: 'CLIENT_NOT_FOUND', message: 'Client not found.' }, id);
  }
  if (!actorOutranksTarget(client, target.userId)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'You cannot move a user with equal or higher rank.' }, id);
  }
  const channel = state.channels.get(channelId);
  if (!channel) {
    return send(client.ws, 'server:error', { code: 'UNKNOWN_CHANNEL', message: 'Channel not found.' }, id);
  }
  if (target.channelId === channelId) {
    return send(client.ws, 'admin:move-user-ok', { clientId, channelId }, id);
  }

  const { handleJoinChannel } = await import('./channels.js');
  handleJoinChannel(target, { channelId, password: channel.password, _bypassRoleCheck: true }, null);
  send(client.ws, 'admin:move-user-ok', { clientId, channelId }, id);
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleListUsers(client, data, id) {
  if (!client.permissions.has(PERMISSIONS.SERVER_ADMIN_MENU)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'Admin access required.' }, id);
  }

  const identities = getAllIdentities();
  const onlineByUserId = new Map();
  for (const c of state.clients.values()) {
    if (c.userId) {
      onlineByUserId.set(c.userId, c);
    }
  }

  const users = identities.map((identity) => {
    const onlineClient = onlineByUserId.get(identity.user_id);
    const roles = getUserRoles(identity.user_id);
    const registeredNicknames = getRegisteredNicknames(identity.user_id);
    return {
      userId: identity.user_id,
      name: identity.name,
      createdAt: identity.created_at,
      roles,
      online: !!onlineClient,
      clientId: onlineClient?.id || null,
      channelId: onlineClient?.channelId || null,
      lastSeenAt: identity.last_seen_at || null,
      registeredNicknames,
      nickname: onlineClient?.nickname || registeredNicknames[0] || identity.name,
    };
  });

  send(client.ws, 'admin:users-list', { users }, id);
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleDeleteUser(client, data, id) {
  if (!client.permissions.has(PERMISSIONS.USER_BAN)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'Admin access required.' }, id);
  }
  const { userId } = data;
  if (!userId || typeof userId !== 'string') {
    return send(client.ws, 'server:error', { code: 'INVALID_REQUEST', message: 'userId is required.' }, id);
  }

  const identity = getIdentity(userId);
  if (!identity) {
    return send(client.ws, 'server:error', { code: 'USER_NOT_FOUND', message: 'User not found.' }, id);
  }

  if (!actorOutranksTarget(client, userId)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'You cannot delete a user with equal or higher rank.' }, id);
  }

  for (const c of state.clients.values()) {
    if (c.userId === userId) {
      send(c.ws, 'server:kicked', { reason: 'Your identity has been deleted by an administrator.' });
      c.ws.close();
    }
  }

  deleteUserRoles(userId);
  deleteUserDmMessages(userId);
  deleteIdentity(userId);

  logAuditEvent('delete_user', client.userId, client.nickname, userId, identity.name, null);
  send(client.ws, 'admin:delete-user-ok', { userId }, id);
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleBulkDeleteUsers(client, data, id) {
  if (!client.permissions.has(PERMISSIONS.USER_BAN)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'Admin access required.' }, id);
  }
  const { userIds } = data;
  if (!Array.isArray(userIds) || userIds.length === 0) {
    return send(client.ws, 'server:error', { code: 'INVALID_REQUEST', message: 'userIds array is required.' }, id);
  }

  let deleted = 0;
  for (const userId of userIds) {
    if (typeof userId !== 'string') {
      continue;
    }
    const identity = getIdentity(userId);
    if (!identity) {
      continue;
    }
    if (!actorOutranksTarget(client, userId)) {
      continue;
    }

    for (const c of state.clients.values()) {
      if (c.userId === userId) {
        send(c.ws, 'server:kicked', { reason: 'Your identity has been deleted by an administrator.' });
        c.ws.close();
      }
    }

    deleteUserRoles(userId);
    deleteUserDmMessages(userId);
    deleteIdentity(userId);
    deleted++;
  }

  logAuditEvent('bulk_delete_users', client.userId, client.nickname, null, null, `Deleted ${deleted} users`);
  send(client.ws, 'admin:bulk-delete-users-ok', { deleted }, id);
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleBanByUserId(client, data, id) {
  if (!client.permissions.has(PERMISSIONS.USER_BAN)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'Admin access required.' }, id);
  }
  const { userId, reason, duration } = data;
  if (!userId || typeof userId !== 'string') {
    return send(client.ws, 'server:error', { code: 'INVALID_REQUEST', message: 'userId is required.' }, id);
  }

  const identity = getIdentity(userId);
  if (!identity) {
    return send(client.ws, 'server:error', { code: 'USER_NOT_FOUND', message: 'User not found.' }, id);
  }

  if (!actorOutranksTarget(client, userId)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'You cannot ban a user with equal or higher rank.' }, id);
  }

  const expiresAt = duration && duration > 0 ? Date.now() + duration * 1000 : null;
  const banReason = reason || 'Banned by admin.';

  addBan({
    id: randomUUID(),
    ip: null,
    userId,
    nickname: identity.name,
    reason: banReason,
    createdAt: Date.now(),
    expiresAt,
  });

  for (const c of state.clients.values()) {
    if (c.userId === userId) {
      addBan({
        id: randomUUID(),
        ip: c.ip,
        nickname: c.nickname,
        reason: banReason,
        createdAt: Date.now(),
        expiresAt,
      });
      send(c.ws, 'server:banned', { reason: banReason });
      c.ws.close();
    }
  }

  const details = duration > 0 ? `Duration: ${duration}s, Reason: ${banReason}` : `Permanent, Reason: ${banReason}`;
  logAuditEvent('ban_user', client.userId, client.nickname, userId, identity.name, details);
  send(client.ws, 'admin:ban-user-ok', { userId }, id);
}

/**
 * Handles deleting a single registered nickname from a user identity.
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleDeleteNickname(client, data, id) {
  if (!client.permissions.has(PERMISSIONS.USER_BAN)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'Admin access required.' }, id);
  }
  const { userId, nickname } = data;
  if (!userId || typeof userId !== 'string' || !nickname || typeof nickname !== 'string') {
    return send(client.ws, 'server:error', { code: 'INVALID_REQUEST', message: 'userId and nickname are required.' }, id);
  }

  if (!actorOutranksTarget(client, userId)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'You cannot manage a user with equal or higher rank.' }, id);
  }

  const remaining = getRegisteredNicknames(userId);
  if (remaining.length <= 1) {
    return send(client.ws, 'server:error', { code: 'LAST_NICKNAME', message: 'Cannot delete the last nickname. Delete the user instead.' }, id);
  }

  const deleted = deleteNicknameRegistration(userId, nickname);
  if (!deleted) {
    return send(client.ws, 'server:error', { code: 'NOT_FOUND', message: 'Nickname not found for this user.' }, id);
  }

  logAuditEvent('delete_nickname', client.userId, client.nickname, userId, nickname, null);
  send(client.ws, 'admin:delete-nickname-ok', { userId, nickname }, id);
}

/**
 * Adds a nickname registration for a user identity.
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleAddNickname(client, data, id) {
  if (!client.permissions.has(PERMISSIONS.USER_BAN)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'Admin access required.' }, id);
  }
  const { userId, nickname } = data;
  if (!userId || typeof userId !== 'string' || !nickname || typeof nickname !== 'string') {
    return send(client.ws, 'server:error', { code: 'INVALID_REQUEST', message: 'userId and nickname are required.' }, id);
  }

  const trimmed = nickname.trim();
  if (!trimmed || trimmed.length > 32) {
    return send(client.ws, 'server:error', { code: 'INVALID_REQUEST', message: 'Nickname must be between 1 and 32 characters.' }, id);
  }

  if (!actorOutranksTarget(client, userId)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'You cannot manage a user with equal or higher rank.' }, id);
  }

  const existingOwner = getNicknameOwner(trimmed);
  if (existingOwner) {
    return send(client.ws, 'server:error', { code: 'NICKNAME_TAKEN', message: `The nickname "${trimmed}" is already registered to another user.` }, id);
  }

  registerNickname(userId, trimmed);
  logAuditEvent('add_nickname', client.userId, client.nickname, userId, trimmed, null);
  send(client.ws, 'admin:add-nickname-ok', { userId, nickname: trimmed }, id);
}

/**
 * Handles requesting server analytics data including live and historical metrics.
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleGetAnalytics(client, data, id) {
  if (!client.permissions.has(PERMISSIONS.SERVER_ADMIN_MENU)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'Admin access required.' }, id);
  }

  const connectedClients = state.clients.size;
  let clientsInVoice = 0;
  let totalProducers = 0;
  let totalConsumers = 0;
  let screenShares = 0;
  let webcamStreams = 0;
  let voiceRooms = 0;
  let activeChannels = 0;

  for (const channel of state.channels.values()) {
    if (channel.clients.size > 0) {
      activeChannels++;
    }
    if (channel.router) {
      voiceRooms++;
    }
  }

  for (const c of state.clients.values()) {
    if (c.sendTransport) {
      clientsInVoice++;
    }
    if (c.producers) {
      for (const producer of c.producers.values()) {
        totalProducers++;
        if (producer.appData?.screen || producer.appData?.screenAudio) {
          screenShares++;
        }
        if (producer.appData?.webcam) {
          webcamStreams++;
        }
      }
    }
    if (c.consumers) {
      totalConsumers += c.consumers.size;
    }
  }

  const uptimeMs = Date.now() - startTime;
  const dbData = getAnalyticsData();

  send(
    client.ws,
    'admin:analytics',
    {
      live: {
        connectedClients,
        clientsInVoice,
        activeChannels,
        voiceRooms,
        totalProducers,
        totalConsumers,
        screenShares,
        webcamStreams,
        uptimeMs,
        sessionsTotal: counters.connectionsTotal,
        wsMessagesTotal: counters.websocketMessagesTotal,
        sessionMessagesTotal: counters.messagesTotal,
        sessionDmsTotal: counters.dmMessagesTotal,
        sessionFilesTotal: counters.filesUploadedTotal,
      },
      db: dbData,
    },
    id,
  );
}

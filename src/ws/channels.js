import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import state from '../state.js';
import { insertChannel, deleteChannel as dbDeleteChannel, updateChannel as dbUpdateChannel, getUserRoles, setChannelAllowedRoles, setChannelWriteRoles, setChannelReadRoles, setChannelVisibilityRoles, logAuditEvent, getChannelFileIds } from '../db/database.js';
import { send, broadcast } from './handler.js';
import { ensureRouter, cleanupClientMedia, maybeCloseRouter, createConsumersForProducer, consumeExistingProducers } from '../media/room.js';
import { PERMISSIONS } from '../permissions.js';
import config from '../config.js';
import logger from '../logger.js';

/**
 * Deletes all uploaded files from disk for a given channel.
 * @param {string} channelId
 */
function deleteChannelFiles(channelId) {
  const uploadsDir = resolve(config.files.storagePath);
  const fileIds = getChannelFileIds(channelId);
  for (const fileId of fileIds) {
    try {
      rmSync(join(uploadsDir, fileId), { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Checks if a client has read access to a channel based on role restrictions.
 * @param {object} client
 * @param {object} channel
 * @returns {boolean}
 */
function hasChannelReadAccess(client, channel) {
  if (!channel.readRoles || channel.readRoles.length === 0) return true;
  if (client.permissions.has(PERMISSIONS.CHANNEL_BYPASS_READ_RESTRICTION)) return true;
  if (!client.userId) return false;
  const userRoles = getUserRoles(client.userId);
  return userRoles.some(r => channel.readRoles.includes(r.id));
}

/**
 * Checks if a client has write access to a channel based on role restrictions.
 * @param {object} client
 * @param {object} channel
 * @returns {boolean}
 */
function hasChannelWriteAccess(client, channel) {
  if (!channel.writeRoles || channel.writeRoles.length === 0) return true;
  if (client.permissions.has(PERMISSIONS.CHANNEL_BYPASS_WRITE_RESTRICTION)) return true;
  if (!client.userId) return false;
  const userRoles = getUserRoles(client.userId);
  return userRoles.some(r => channel.writeRoles.includes(r.id));
}

/**
 * Checks if a client can see a channel based on visibility role restrictions.
 * @param {object} client
 * @param {object} channel
 * @returns {boolean}
 */
export function hasChannelVisibility(client, channel) {
  if (!channel.visibilityRoles || channel.visibilityRoles.length === 0) return true;
  if (client.permissions.has(PERMISSIONS.CHANNEL_BYPASS_VISIBILITY_RESTRICTION)) return true;
  if (client.channelId === channel.id) return true;
  if (!client.userId) return false;
  const userRoles = getUserRoles(client.userId);
  return userRoles.some(r => channel.visibilityRoles.includes(r.id));
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [msgId]
 */
export function handleLeaveChannel(client, data, msgId) {
  const channelId = client.channelId;
  if (!channelId) {
    return send(client.ws, 'channel:left', {}, msgId);
  }

  const channel = state.channels.get(channelId);

  if (channel) {
    const hasScreenProducer = [...client.producers.values()].some(p => p.appData?.screen && p.kind === 'video');
    if (hasScreenProducer) {
      for (const id of channel.clients) {
        if (id === client.id) continue;
        const peer = state.clients.get(id);
        if (peer) {
          send(peer.ws, 'screen:stopped', { clientId: client.id });
        }
      }
    }
  }

  cleanupClientMedia(client);

  if (channel) {
    for (const id of channel.clients) {
      if (id === client.id) continue;
      const peer = state.clients.get(id);
      if (peer) {
        send(peer.ws, 'channel:user-left', { channelId, clientId: client.id });
      }
    }
  }

  if (channel) {
    channel.clients.delete(client.id);
    channel.voiceGranted.delete(client.id);
    channel.voiceRequests.delete(client.id);
  }
  client.channelId = null;

  if (channel) {
    maybeCloseRouter(channelId);
    checkTemporaryChannel(channelId);
  }

  send(client.ws, 'channel:left', { channelId }, msgId);

  if (channel && !hasChannelVisibility(client, channel)) {
    send(client.ws, 'channel:deleted', { channelId });
  }
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [msgId]
 */
export async function handleJoinChannel(client, data, msgId) {
  const { channelId, password } = data;

  const channel = state.channels.get(channelId);
  if (!channel) {
    return send(client.ws, 'server:error', { code: 'UNKNOWN_CHANNEL', message: 'Channel not found.' }, msgId);
  }

  if (channel.type === 'group') {
    return send(client.ws, 'server:error', { code: 'CANNOT_JOIN_GROUP', message: 'Cannot join a channel group.' }, msgId);
  }

  if (channel.password && password !== channel.password && !client.permissions.has(PERMISSIONS.CHANNEL_BYPASS_PASSWORD)) {
    return send(client.ws, 'server:error', { code: 'BAD_PASSWORD', message: 'Incorrect channel password.' }, msgId);
  }

  if (channel.maxUsers && channel.clients.size >= channel.maxUsers && !client.permissions.has(PERMISSIONS.CHANNEL_BYPASS_USER_LIMIT)) {
    return send(client.ws, 'server:error', { code: 'CHANNEL_FULL', message: 'Channel is full.' }, msgId);
  }

  if (!data._bypassRoleCheck && !hasChannelVisibility(client, channel)) {
    return send(client.ws, 'server:error', { code: 'CHANNEL_HIDDEN', message: 'Channel not found.' }, msgId);
  }

  if (channel.allowedRoles && channel.allowedRoles.length > 0 && !data._bypassRoleCheck && !client.permissions.has(PERMISSIONS.CHANNEL_BYPASS_ROLE_RESTRICTION)) {
    let hasRole = false;
    if (client.userId) {
      const userRoles = getUserRoles(client.userId);
      hasRole = userRoles.some(r => channel.allowedRoles.includes(r.id));
    }
    if (!hasRole) {
      return send(client.ws, 'server:error', { code: 'ROLE_RESTRICTED', message: 'You do not have the required role to join this channel.' }, msgId);
    }
  }

  if (client.channelId === channelId) {
    return send(client.ws, 'server:error', { code: 'ALREADY_IN_CHANNEL', message: 'Already in this channel.' }, msgId);
  }

  const oldChannelId = client.channelId;
  const oldChannel = state.channels.get(oldChannelId);

  if (oldChannel) {
    const hasScreenProducer = [...client.producers.values()].some(p => p.appData?.screen && p.kind === 'video');
    if (hasScreenProducer) {
      for (const id of oldChannel.clients) {
        if (id === client.id) continue;
        const peer = state.clients.get(id);
        if (peer) {
          send(peer.ws, 'screen:stopped', { clientId: client.id });
        }
      }
    }
  }

  cleanupClientMedia(client);

  if (oldChannel) {
    for (const id of oldChannel.clients) {
      if (id === client.id) continue;
      const peer = state.clients.get(id);
      if (peer) {
        send(peer.ws, 'channel:user-left', { channelId: oldChannelId, clientId: client.id });
      }
    }
  }

  state.moveClientToChannel(client.id, channelId);

  if (oldChannel) maybeCloseRouter(oldChannelId);
  if (oldChannel) checkTemporaryChannel(oldChannelId);
  checkTemporaryChannel(channelId);

  if (oldChannel && !hasChannelVisibility(client, oldChannel)) {
    send(client.ws, 'channel:deleted', { channelId: oldChannelId });
  }

  if (channel.visibilityRoles && channel.visibilityRoles.length > 0) {
    const channelInfo = {
      id: channel.id,
      name: channel.name,
      parentId: channel.parentId,
      hasPassword: !!channel.password,
      maxUsers: channel.maxUsers,
      description: channel.description,
      isDefault: channel.isDefault,
      sortOrder: channel.sortOrder,
      moderated: channel.moderated,
      type: channel.type || 'channel',
      isTemporary: channel.isTemporary || false,
      allowedRoles: channel.allowedRoles || [],
      writeRoles: channel.writeRoles || [],
      readRoles: channel.readRoles || [],
      visibilityRoles: channel.visibilityRoles || [],
      userCount: channel.clients.size,
    };
    send(client.ws, 'channel:created', { channel: channelInfo });
  }

  const channelClients = state.getClientsByChannel(channelId).map(c => ({
    id: c.id,
    nickname: c.nickname,
  }));

  const joinData = { channelId, clients: channelClients };
  if (channel.moderated) {
    joinData.moderated = true;
    joinData.voiceGranted = [...channel.voiceGranted];
  }
  if (!hasChannelReadAccess(client, channel)) {
    joinData.readRestricted = true;
  }
  if (!hasChannelWriteAccess(client, channel)) {
    joinData.writeRestricted = true;
  }
  send(client.ws, 'channel:joined', joinData, msgId);

  for (const id of channel.clients) {
    if (id === client.id) continue;
    const peer = state.clients.get(id);
    if (peer) {
      send(peer.ws, 'channel:user-joined', {
        channelId,
        clientId: client.id,
        userId: client.userId || null,
        nickname: client.nickname,
      });
    }
  }

  broadcast('server:client-moved', {
    clientId: client.id,
    fromChannelId: oldChannelId,
    toChannelId: channelId,
  });
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [msgId]
 */
export function handleCreateChannel(client, data, msgId) {
  const type = data.type || 'channel';

  if (type !== 'channel' && type !== 'group') {
    return send(client.ws, 'server:error', { code: 'INVALID_TYPE', message: 'Invalid channel type.' }, msgId);
  }

  const isTemporary = !!data.temporary;

  if (type === 'group') {
    if (!client.permissions.has(PERMISSIONS.CHANNEL_GROUP_CREATE)) {
      return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'No permission to create channel groups.' }, msgId);
    }
  } else if (isTemporary) {
    if (!client.permissions.has(PERMISSIONS.CHANNEL_CREATE_TEMPORARY)) {
      return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'No permission to create temporary channels.' }, msgId);
    }
  } else {
    if (!client.permissions.has(PERMISSIONS.CHANNEL_CREATE)) {
      return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'Only admins can create channels.' }, msgId);
    }
  }

  if (isTemporary && type === 'group') {
    return send(client.ws, 'server:error', { code: 'INVALID_TYPE', message: 'Temporary channels cannot be groups.' }, msgId);
  }

  const { name, parentId, password, maxUsers, description, moderated } = data;

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return send(client.ws, 'server:error', { code: 'INVALID_NAME', message: 'Channel name is required.' }, msgId);
  }

  if (type === 'group' && parentId) {
    return send(client.ws, 'server:error', { code: 'INVALID_PARENT', message: 'Groups must be top-level (no parent).' }, msgId);
  }

  if (type === 'group' && password) {
    return send(client.ws, 'server:error', { code: 'INVALID_GROUP', message: 'Groups cannot have a password.' }, msgId);
  }

  if (parentId && !state.channels.has(parentId)) {
    return send(client.ws, 'server:error', { code: 'UNKNOWN_PARENT', message: 'Parent channel not found.' }, msgId);
  }

  if (parentId) {
    const parent = state.channels.get(parentId);
    if (parent && parent.type !== 'group') {
      return send(client.ws, 'server:error', { code: 'INVALID_PARENT', message: 'Parent must be a channel group.' }, msgId);
    }
  }

  const channel = {
    id: randomUUID(),
    name: name.trim(),
    parentId: parentId || null,
    password: (type === 'group') ? null : (password || null),
    maxUsers: maxUsers || null,
    description: description || '',
    isDefault: false,
    sortOrder: state.channels.size,
    moderated: !!moderated,
    type,
    isTemporary,
  };

  insertChannel(channel);

  state.channels.set(channel.id, {
    ...channel,
    allowedRoles: [],
    writeRoles: [],
    readRoles: [],
    visibilityRoles: [],
    clients: new Set(),
    router: null,
    voiceGranted: new Set(),
    voiceRequests: new Set(),
    deleteTimer: null,
    lastMessageAt: null,
  });

  if (isTemporary) {
    scheduleTemporaryChannelDelete(channel.id);
  }

  const channelInfo = {
    id: channel.id,
    name: channel.name,
    parentId: channel.parentId,
    hasPassword: !!channel.password,
    maxUsers: channel.maxUsers,
    description: channel.description,
    isDefault: false,
    sortOrder: channel.sortOrder,
    moderated: channel.moderated,
    type: channel.type,
    isTemporary: channel.isTemporary,
    allowedRoles: [],
    writeRoles: [],
    readRoles: [],
    visibilityRoles: [],
    userCount: 0,
  };

  broadcast('channel:created', { channel: channelInfo });
  send(client.ws, 'channel:created', { channel: channelInfo }, msgId);

  logAuditEvent('channel_create', client.userId, client.nickname, null, null, `Channel: ${channel.name} (${channel.type}${channel.isTemporary ? ', temporary' : ''})`);

  if (isTemporary) {
    handleJoinChannel(client, { channelId: channel.id, password: channel.password });
  }
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [msgId]
 */
export function handleDeleteChannel(client, data, msgId) {
  if (!client.permissions.has(PERMISSIONS.CHANNEL_DELETE)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'Only admins can delete channels.' }, msgId);
  }

  const { channelId } = data;

  const channel = state.channels.get(channelId);
  if (!channel) {
    return send(client.ws, 'server:error', { code: 'UNKNOWN_CHANNEL', message: 'Channel not found.' }, msgId);
  }

  if (channel.isDefault) {
    return send(client.ws, 'server:error', { code: 'CANNOT_DELETE_DEFAULT', message: 'Cannot delete the default channel.' }, msgId);
  }

  const defaultChannelId = state.getDefaultChannelId();

  for (const clientId of [...channel.clients]) {
    const peer = state.clients.get(clientId);
    if (peer) {
      cleanupClientMedia(peer);
      state.moveClientToChannel(clientId, defaultChannelId);
      send(peer.ws, 'channel:joined', {
        channelId: defaultChannelId,
        clients: state.getClientsByChannel(defaultChannelId).map(c => ({ id: c.id, nickname: c.nickname })),
      });
    }
  }

  for (const ch of state.channels.values()) {
    if (ch.parentId === channelId) {
      if (channel.type === 'group') {
        ch.parentId = null;
        dbUpdateChannel(ch.id, { parentId: null });
        broadcast('channel:updated', {
          channel: {
            id: ch.id, name: ch.name, parentId: null,
            hasPassword: !!ch.password, maxUsers: ch.maxUsers,
            description: ch.description, isDefault: ch.isDefault,
            sortOrder: ch.sortOrder, moderated: ch.moderated,
            type: ch.type || 'channel', allowedRoles: ch.allowedRoles || [],
            writeRoles: ch.writeRoles || [],
            readRoles: ch.readRoles || [],
            userCount: ch.clients.size,
          },
        });
      } else {
        for (const clientId of [...ch.clients]) {
          const peer = state.clients.get(clientId);
          if (peer) {
            cleanupClientMedia(peer);
            state.moveClientToChannel(clientId, defaultChannelId);
            send(peer.ws, 'channel:joined', {
              channelId: defaultChannelId,
              clients: state.getClientsByChannel(defaultChannelId).map(c => ({ id: c.id, nickname: c.nickname })),
            });
          }
        }
        if (ch.router) ch.router.close();
        deleteChannelFiles(ch.id);
        state.channels.delete(ch.id);
        dbDeleteChannel(ch.id);
      }
    }
  }

  if (channel.deleteTimer) {
    clearTimeout(channel.deleteTimer);
    channel.deleteTimer = null;
  }

  if (channel.router) channel.router.close();

  deleteChannelFiles(channelId);
  state.channels.delete(channelId);
  dbDeleteChannel(channelId);

  broadcast('channel:deleted', { channelId });

  logAuditEvent('channel_delete', client.userId, client.nickname, null, null, `Channel: ${channel.name}`);
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [msgId]
 */
export function handleUpdateChannel(client, data, msgId) {
  if (!client.permissions.has(PERMISSIONS.CHANNEL_UPDATE)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'Only admins can edit channels.' }, msgId);
  }

  const { channelId, ...props } = data;

  const channel = state.channels.get(channelId);
  if (!channel) {
    return send(client.ws, 'server:error', { code: 'UNKNOWN_CHANNEL', message: 'Channel not found.' }, msgId);
  }

  if (props.parentId !== undefined) {
    if (props.parentId === channelId) {
      return send(client.ws, 'server:error', { code: 'INVALID_PARENT', message: 'A channel cannot be its own parent.' }, msgId);
    }
    if (props.parentId !== null && !state.channels.has(props.parentId)) {
      return send(client.ws, 'server:error', { code: 'UNKNOWN_PARENT', message: 'Parent channel not found.' }, msgId);
    }
    if (props.parentId !== null) {
      let current = props.parentId;
      while (current) {
        if (current === channelId) {
          return send(client.ws, 'server:error', { code: 'CIRCULAR_PARENT', message: 'Cannot create circular channel hierarchy.' }, msgId);
        }
        const parent = state.channels.get(current);
        current = parent ? parent.parentId : null;
      }

      const parentChannel = state.channels.get(props.parentId);
      if (parentChannel && parentChannel.type !== 'group') {
        return send(client.ws, 'server:error', { code: 'INVALID_PARENT', message: 'Parent must be a channel group.' }, msgId);
      }
    }

    if (channel.type === 'group' && props.parentId !== null) {
      return send(client.ws, 'server:error', { code: 'INVALID_PARENT', message: 'Groups must be top-level (no parent).' }, msgId);
    }
  }

  if (props.name !== undefined) channel.name = props.name;
  if (props.password !== undefined) channel.password = props.password || null;
  if (props.maxUsers !== undefined) channel.maxUsers = props.maxUsers || null;
  if (props.description !== undefined) channel.description = props.description;
  if (props.parentId !== undefined) channel.parentId = props.parentId;
  if (props.sortOrder !== undefined) channel.sortOrder = props.sortOrder;
  if (props.moderated !== undefined) channel.moderated = !!props.moderated;
  if (props.allowedRoles !== undefined && Array.isArray(props.allowedRoles)) {
    channel.allowedRoles = props.allowedRoles;
    setChannelAllowedRoles(channelId, props.allowedRoles);
  }
  if (props.writeRoles !== undefined && Array.isArray(props.writeRoles)) {
    channel.writeRoles = props.writeRoles;
    setChannelWriteRoles(channelId, props.writeRoles);
  }
  if (props.readRoles !== undefined && Array.isArray(props.readRoles)) {
    channel.readRoles = props.readRoles;
    setChannelReadRoles(channelId, props.readRoles);
  }
  if (props.visibilityRoles !== undefined && Array.isArray(props.visibilityRoles)) {
    channel.visibilityRoles = props.visibilityRoles;
    setChannelVisibilityRoles(channelId, props.visibilityRoles);
  }

  dbUpdateChannel(channelId, props);

  if (props.moderated && channel.moderated) {
    for (const cid of channel.clients) {
      const peer = state.clients.get(cid);
      if (!peer || peer.permissions.has(PERMISSIONS.CHANNEL_BYPASS_MODERATION)) continue;
      if (channel.voiceGranted.has(cid)) continue;
      for (const [producerId, producer] of peer.producers) {
        if (producer.kind === 'audio' && !producer.appData?.screen) {
          producer.close();
          peer.producers.delete(producerId);
        }
      }
    }
  }

  if (props.moderated !== undefined && !channel.moderated) {
    channel.voiceGranted.clear();
    channel.voiceRequests.clear();
  }

  const channelInfo = {
    id: channel.id,
    name: channel.name,
    parentId: channel.parentId,
    hasPassword: !!channel.password,
    maxUsers: channel.maxUsers,
    description: channel.description,
    isDefault: channel.isDefault,
    sortOrder: channel.sortOrder,
    moderated: channel.moderated,
    type: channel.type || 'channel',
    isTemporary: channel.isTemporary || false,
    allowedRoles: channel.allowedRoles || [],
    writeRoles: channel.writeRoles || [],
    readRoles: channel.readRoles || [],
    visibilityRoles: channel.visibilityRoles || [],
    userCount: channel.clients.size,
  };

  for (const c of state.clients.values()) {
    if (hasChannelVisibility(c, channel)) {
      send(c.ws, 'channel:updated', { channel: channelInfo });
    } else {
      send(c.ws, 'channel:deleted', { channelId: channel.id });
    }
  }

  logAuditEvent('channel_update', client.userId, client.nickname, null, null, `Channel: ${channel.name}`);
}

/**
 * Schedules auto-deletion of a temporary channel after the configured delay.
 * @param {string} channelId
 */
function scheduleTemporaryChannelDelete(channelId) {
  const channel = state.channels.get(channelId);
  if (!channel || !channel.isTemporary) return;

  if (channel.deleteTimer) {
    clearTimeout(channel.deleteTimer);
    channel.deleteTimer = null;
  }

  const delayMs = (config.chat.tempChannelDeleteDelay || 180) * 1000;

  channel.deleteTimer = setTimeout(() => {
    const ch = state.channels.get(channelId);
    if (!ch || !ch.isTemporary) return;

    if (ch.clients.size > 0) {
      ch.deleteTimer = null;
      return;
    }

    if (ch.router) ch.router.close();

    deleteChannelFiles(channelId);
    state.channels.delete(channelId);
    dbDeleteChannel(channelId);

    broadcast('channel:deleted', { channelId });

    logger.info(`Temporary channel auto-deleted: ${ch.name} (${channelId})`);
    logAuditEvent('channel_auto_delete', null, null, null, null, `Temporary channel: ${ch.name}`);
  }, delayMs);
}

/**
 * Manages auto-deletion timers for temporary channels when clients join/leave.
 * @param {string} channelId
 */
export function checkTemporaryChannel(channelId) {
  const channel = state.channels.get(channelId);
  if (!channel || !channel.isTemporary) return;

  if (channel.clients.size === 0) {
    scheduleTemporaryChannelDelete(channelId);
  } else {
    if (channel.deleteTimer) {
      clearTimeout(channel.deleteTimer);
      channel.deleteTimer = null;
    }
  }
}

import { randomUUID } from 'node:crypto';
import * as openpgp from 'openpgp';
import state from '../state.js';
import config from '../config.js';
import logger from '../logger.js';
import { send, broadcast } from './handler.js';
import { PERMISSIONS } from '../permissions.js';
import {
  createMeetInvite,
  getMeetInvite,
  incrementMeetInviteUse,
  deleteMeetInvite,
  listMeetInvites,
  findIdentityByFingerprint,
  insertIdentity,
  assignRole,
  getUserPermissions,
  getUserBadge,
  getUserRoleColor,
  getUserHighestRolePosition,
  isBanned,
  getChannel,
} from '../db/database.js';

/**
 * Validates an invite and returns it if usable, or null.
 * @param {string} inviteId
 * @returns {object|null}
 */
export function getValidInvite(inviteId) {
  const invite = getMeetInvite(inviteId);
  if (!invite) {
    return null;
  }
  if (invite.expires_at && Date.now() > invite.expires_at) {
    return null;
  }
  if (invite.max_uses && invite.use_count >= invite.max_uses) {
    return null;
  }
  return invite;
}

/**
 * Handles a meet:join message — connects a guest user via invite link.
 * Called before authentication (like server:connect), so receives raw ws + ip.
 * @param {import('ws').WebSocket} ws
 * @param {object} data
 * @param {string} [msgId]
 * @param {string} ip
 */
export async function handleMeetJoin(ws, data, msgId, ip) {
  const { inviteId, nickname, publicKey } = data;

  if (!inviteId || typeof inviteId !== 'string') {
    return send(ws, 'server:error', { code: 'INVALID_INVITE', message: 'Invite ID is required.' }, msgId);
  }

  if (!nickname || typeof nickname !== 'string' || nickname.trim().length === 0) {
    return send(ws, 'server:error', { code: 'INVALID_NICKNAME', message: 'Nickname is required.' }, msgId);
  }

  const trimmed = nickname.trim();
  if (trimmed.length > 32) {
    return send(ws, 'server:error', { code: 'INVALID_NICKNAME', message: 'Nickname too long (max 32).' }, msgId);
  }

  if (isBanned(ip)) {
    return send(ws, 'server:error', { code: 'BANNED', message: 'You are banned from this server.' }, msgId);
  }

  if (state.isNicknameTaken(trimmed)) {
    return send(ws, 'server:error', { code: 'NICKNAME_TAKEN', message: 'Nickname is already in use.' }, msgId);
  }

  const invite = getValidInvite(inviteId);
  if (!invite) {
    return send(ws, 'server:error', { code: 'INVALID_INVITE', message: 'Invite is invalid or expired.' }, msgId);
  }

  const channel = state.channels.get(invite.channel_id);
  if (!channel) {
    return send(ws, 'server:error', { code: 'INVALID_INVITE', message: 'The channel for this invite no longer exists.' }, msgId);
  }

  if (!publicKey || typeof publicKey !== 'string') {
    return send(ws, 'server:error', { code: 'INVALID_KEY', message: 'Public key is required.' }, msgId);
  }

  let fingerprint;
  try {
    const key = await openpgp.readKey({ armoredKey: publicKey });
    fingerprint = key.getFingerprint();
  } catch {
    return send(ws, 'server:error', { code: 'INVALID_KEY', message: 'Invalid public key.' }, msgId);
  }

  const clientId = randomUUID();
  let userId;

  const existing = findIdentityByFingerprint(fingerprint);
  if (existing) {
    userId = existing.user_id;
  } else {
    userId = randomUUID();
    insertIdentity({
      userId,
      publicKey,
      fingerprint,
      name: trimmed,
      createdAt: Date.now(),
    });
    assignRole(userId, 'guest');
  }

  const permissions = getUserPermissions(userId);
  const badge = getUserBadge(userId);
  const roleColor = getUserRoleColor(userId);
  const rolePosition = getUserHighestRolePosition(userId);

  const client = {
    id: clientId,
    userId,
    fingerprint: null,
    nickname: trimmed,
    ws,
    channelId: null,
    ip,
    connectedAt: Date.now(),
    clientVersion: null,
    sendTransport: null,
    recvTransport: null,
    producers: new Map(),
    consumers: new Map(),
    rtpCapabilities: null,
    muted: false,
    deafened: false,
    badge,
    roleColor,
    rolePosition,
    permissions,
    chatSubscriptions: new Set(),
    observe: false,
    meetGuest: true,
  };

  state.addClient(client);
  ws._clientId = clientId;

  incrementMeetInviteUse(invite.id);

  state.moveClientToChannel(clientId, channel.id);

  const channelClients = state.getClientsByChannel(channel.id).map((c) => ({
    id: c.id,
    userId: c.userId || null,
    nickname: c.nickname,
    muted: c.muted,
    deafened: c.deafened,
  }));

  send(
    ws,
    'meet:welcome',
    {
      clientId,
      userId,
      channelId: channel.id,
      channelName: channel.name,
      participants: channelClients,
      permissions: [...permissions],
    },
    msgId,
  );

  for (const id of channel.clients) {
    if (id === clientId) {
      continue;
    }
    const peer = state.clients.get(id);
    if (peer) {
      send(peer.ws, 'channel:user-joined', {
        channelId: channel.id,
        clientId,
        userId,
        nickname: trimmed,
      });
    }
  }

  broadcast('server:client-joined', {
    clientId,
    userId,
    nickname: trimmed,
    channelId: channel.id,
    badge,
    roleColor,
    rolePosition,
    fingerprint: null,
  }, clientId);

  logger.info(`Meet guest connected: ${trimmed} (${clientId}, invite=${inviteId}, channel=${channel.name})`);
}

/**
 * Creates a meet invite for a channel.
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleMeetCreateInvite(client, data, id) {
  if (!client.permissions.has(PERMISSIONS.MEET_CREATE_INVITE)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'Permission denied.' }, id);
  }

  const { channelId, expiresIn, maxUses } = data;
  if (!channelId) {
    return send(client.ws, 'server:error', { code: 'INVALID_CHANNEL', message: 'channelId is required.' }, id);
  }

  const channel = state.channels.get(channelId);
  if (!channel) {
    return send(client.ws, 'server:error', { code: 'UNKNOWN_CHANNEL', message: 'Channel not found.' }, id);
  }

  const inviteId = randomUUID();
  const now = Date.now();
  const expiresAt = expiresIn ? now + expiresIn : null;

  createMeetInvite({
    id: inviteId,
    channelId,
    createdBy: client.userId,
    createdAt: now,
    expiresAt,
    maxUses: maxUses || null,
  });

  const meetUrl = config.meetUrl ? `${config.meetUrl.replace(/\/$/, '')}/invite/${inviteId}` : null;

  send(client.ws, 'meet:invite-created', { inviteId, channelId, expiresAt, maxUses: maxUses || null, meetUrl }, id);
}

/**
 * Deletes a meet invite.
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleMeetDeleteInvite(client, data, id) {
  if (!client.permissions.has(PERMISSIONS.MEET_CREATE_INVITE)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'Permission denied.' }, id);
  }

  const { inviteId } = data;
  if (!inviteId) {
    return send(client.ws, 'server:error', { code: 'INVALID_INVITE', message: 'inviteId is required.' }, id);
  }

  deleteMeetInvite(inviteId);
  send(client.ws, 'meet:invite-deleted', { inviteId }, id);
}

/**
 * Lists meet invites, optionally filtered by channel.
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleMeetListInvites(client, data, id) {
  if (!client.permissions.has(PERMISSIONS.MEET_CREATE_INVITE)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'Permission denied.' }, id);
  }

  const invites = listMeetInvites(data.channelId);
  send(client.ws, 'meet:invites', { invites }, id);
}

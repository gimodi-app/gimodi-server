import { randomUUID } from 'node:crypto';
import state from '../state.js';
import logger from '../logger.js';
import {
  findIdentityByFingerprint,
  insertFriendRequest,
  getFriendRequest,
  getPendingRequestBetween,
  getPendingFriendRequests,
  getUnnotifiedAcceptedRequests,
  updateFriendRequestStatus,
  deleteFriendRequest,
} from '../db/database.js';
import { send } from './handler.js';

/**
 * Finds a connected client by their OpenPGP fingerprint.
 * @param {string} fingerprint
 * @returns {object|undefined}
 */
function findClientByFingerprint(fingerprint) {
  for (const client of state.clients.values()) {
    if (client.fingerprint === fingerprint) {
      return client;
    }
  }
  return undefined;
}

/**
 * Handles a friend request from one user to another.
 * @param {object} client
 * @param {object} data
 * @param {string} [msgId]
 */
export function handleFriendRequest(client, data, msgId) {
  if (!client.fingerprint) {
    return send(client.ws, 'server:error', { code: 'NO_IDENTITY', message: 'An identity is required to send friend requests.' }, msgId);
  }

  const { recipientFingerprint } = data;
  if (!recipientFingerprint || typeof recipientFingerprint !== 'string') {
    return send(client.ws, 'server:error', { code: 'INVALID_DATA', message: 'recipientFingerprint is required.' }, msgId);
  }

  if (recipientFingerprint === client.fingerprint) {
    return send(client.ws, 'server:error', { code: 'SELF_REQUEST', message: 'You cannot send a friend request to yourself.' }, msgId);
  }

  const existing = getPendingRequestBetween(client.fingerprint, recipientFingerprint);
  if (existing) {
    if (existing.sender_fingerprint === client.fingerprint) {
      return send(client.ws, 'server:error', { code: 'REQUEST_EXISTS', message: 'A friend request is already pending.' }, msgId);
    }

    acceptRequest(existing, client, msgId);
    return;
  }

  const senderIdentity = findIdentityByFingerprint(client.fingerprint);
  if (!senderIdentity) {
    return send(client.ws, 'server:error', { code: 'NO_IDENTITY', message: 'Identity not found.' }, msgId);
  }

  const id = randomUUID();
  const createdAt = Date.now();

  insertFriendRequest({
    id,
    senderFingerprint: client.fingerprint,
    recipientFingerprint,
    senderPublicKey: senderIdentity.public_key,
    senderNickname: client.nickname,
    createdAt,
  });

  send(client.ws, 'friend:request', { success: true, requestId: id }, msgId);

  const recipient = findClientByFingerprint(recipientFingerprint);
  if (recipient) {
    logger.info(`[friends] Recipient ${recipientFingerprint} is online (clientId=${recipient.id}, nickname=${recipient.nickname}), sending friend:request-received`);
    send(recipient.ws, 'friend:request-received', {
      requestId: id,
      senderFingerprint: client.fingerprint,
      senderNickname: client.nickname,
      senderPublicKey: senderIdentity.public_key,
      createdAt,
    });
  } else {
    logger.info(`[friends] Recipient ${recipientFingerprint} is offline, request stored for later delivery`);
  }

  logger.info(`[friends] Friend request from ${client.nickname} (${client.fingerprint}) to ${recipientFingerprint}`);
}

/**
 * Accepts a friend request, exchanging public keys between both parties.
 * The server only acts as a relay — once both parties have been notified,
 * the request is deleted. Friendships are maintained client-side only.
 * @param {object} request - The friend_requests DB row
 * @param {object} acceptor - The accepting client
 * @param {string} [msgId]
 */
function acceptRequest(request, acceptor, msgId) {
  const acceptorIdentity = findIdentityByFingerprint(acceptor.fingerprint);
  const acceptorPublicKey = acceptorIdentity?.public_key || null;

  send(acceptor.ws, 'friend:accept', {
    success: true,
    requestId: request.id,
    friendFingerprint: request.sender_fingerprint,
    friendNickname: request.sender_nickname,
    friendPublicKey: request.sender_public_key,
  }, msgId);

  const sender = findClientByFingerprint(request.sender_fingerprint);
  if (sender) {
    send(sender.ws, 'friend:accepted', {
      requestId: request.id,
      friendFingerprint: acceptor.fingerprint,
      friendNickname: acceptor.nickname,
      friendPublicKey: acceptorPublicKey,
    });

    deleteFriendRequest(request.id);
  } else {
    updateFriendRequestStatus(request.id, 'accepted');
  }

  logger.info(`Friend request accepted: ${acceptor.nickname} accepted ${request.sender_nickname}`);
}

/**
 * Handles accepting a pending friend request.
 * @param {object} client
 * @param {object} data
 * @param {string} [msgId]
 */
export function handleFriendAccept(client, data, msgId) {
  if (!client.fingerprint) {
    return send(client.ws, 'server:error', { code: 'NO_IDENTITY', message: 'An identity is required.' }, msgId);
  }

  const { requestId } = data;
  if (!requestId) {
    return send(client.ws, 'server:error', { code: 'INVALID_DATA', message: 'requestId is required.' }, msgId);
  }

  const request = getFriendRequest(requestId);
  if (!request) {
    return send(client.ws, 'server:error', { code: 'NOT_FOUND', message: 'Friend request not found.' }, msgId);
  }

  if (request.recipient_fingerprint !== client.fingerprint) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'You can only accept requests sent to you.' }, msgId);
  }

  if (request.status !== 'pending') {
    return send(client.ws, 'server:error', { code: 'ALREADY_RESOLVED', message: 'This request has already been resolved.' }, msgId);
  }

  acceptRequest(request, client, msgId);
}

/**
 * Handles rejecting a pending friend request.
 * @param {object} client
 * @param {object} data
 * @param {string} [msgId]
 */
export function handleFriendReject(client, data, msgId) {
  if (!client.fingerprint) {
    return send(client.ws, 'server:error', { code: 'NO_IDENTITY', message: 'An identity is required.' }, msgId);
  }

  const { requestId } = data;
  if (!requestId) {
    return send(client.ws, 'server:error', { code: 'INVALID_DATA', message: 'requestId is required.' }, msgId);
  }

  const request = getFriendRequest(requestId);
  if (!request) {
    return send(client.ws, 'server:error', { code: 'NOT_FOUND', message: 'Friend request not found.' }, msgId);
  }

  if (request.recipient_fingerprint !== client.fingerprint) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'You can only reject requests sent to you.' }, msgId);
  }

  if (request.status !== 'pending') {
    return send(client.ws, 'server:error', { code: 'ALREADY_RESOLVED', message: 'This request has already been resolved.' }, msgId);
  }

  deleteFriendRequest(request.id);

  send(client.ws, 'friend:reject', { success: true, requestId: request.id }, msgId);

  const sender = findClientByFingerprint(request.sender_fingerprint);
  if (sender) {
    send(sender.ws, 'friend:rejected', {
      requestId: request.id,
      rejectorFingerprint: client.fingerprint,
    });
  }

  logger.info(`Friend request rejected: ${client.nickname} rejected ${request.sender_nickname}`);
}

/**
 * Handles listing pending friend requests for the requesting client.
 * Friendships themselves are maintained client-side only.
 * @param {object} client
 * @param {object} data
 * @param {string} [msgId]
 */
export function handleFriendList(client, data, msgId) {
  if (!client.fingerprint) {
    return send(client.ws, 'server:error', { code: 'NO_IDENTITY', message: 'An identity is required.' }, msgId);
  }

  const pendingIncoming = getPendingFriendRequests(client.fingerprint).map((r) => ({
    requestId: r.id,
    senderFingerprint: r.sender_fingerprint,
    senderNickname: r.sender_nickname,
    senderPublicKey: r.sender_public_key,
    createdAt: r.created_at,
  }));

  send(client.ws, 'friend:list', { pendingIncoming }, msgId);
}

/**
 * Handles notifying an online peer that a friendship has been removed.
 * This is best-effort — the server holds no friendship state.
 * @param {object} client
 * @param {object} data
 * @param {string} [msgId]
 */
export function handleFriendRemove(client, data, msgId) {
  if (!client.fingerprint) {
    return send(client.ws, 'server:error', { code: 'NO_IDENTITY', message: 'An identity is required.' }, msgId);
  }

  const { friendFingerprint } = data;
  if (!friendFingerprint || typeof friendFingerprint !== 'string') {
    return send(client.ws, 'server:error', { code: 'INVALID_DATA', message: 'friendFingerprint is required.' }, msgId);
  }

  send(client.ws, 'friend:remove', { success: true, friendFingerprint }, msgId);

  const peer = findClientByFingerprint(friendFingerprint);
  if (peer) {
    send(peer.ws, 'friend:removed', { friendFingerprint: client.fingerprint });
  }

  logger.info(`Friendship removed: ${client.nickname} removed ${friendFingerprint}`);
}

/**
 * Delivers pending friend requests and accepted notifications to a newly connected client.
 * Accepted requests are deleted after delivery since both parties now have each other's keys.
 * @param {object} client
 */
export function deliverPendingFriendRequests(client) {
  if (!client.fingerprint) {
    return;
  }

  const pending = getPendingFriendRequests(client.fingerprint);
  logger.info(`[friends] Delivering ${pending.length} pending friend request(s) to ${client.nickname} (${client.fingerprint})`);
  for (const req of pending) {
    logger.info(`[friends]   - pending request ${req.id} from ${req.sender_nickname} (${req.sender_fingerprint})`);
    send(client.ws, 'friend:request-received', {
      requestId: req.id,
      senderFingerprint: req.sender_fingerprint,
      senderNickname: req.sender_nickname,
      senderPublicKey: req.sender_public_key,
      createdAt: req.created_at,
    });
  }

  const accepted = getUnnotifiedAcceptedRequests(client.fingerprint);
  logger.info(`[friends] Delivering ${accepted.length} accepted friend request(s) to ${client.nickname} (${client.fingerprint})`);
  for (const req of accepted) {
    const acceptorIdentity = findIdentityByFingerprint(req.recipient_fingerprint);
    logger.info(`[friends]   - accepted request ${req.id} by ${acceptorIdentity?.name || 'unknown'} (${req.recipient_fingerprint})`);
    send(client.ws, 'friend:accepted', {
      requestId: req.id,
      friendFingerprint: req.recipient_fingerprint,
      friendNickname: acceptorIdentity?.name || null,
      friendPublicKey: acceptorIdentity?.public_key || null,
    });

    deleteFriendRequest(req.id);
  }
}

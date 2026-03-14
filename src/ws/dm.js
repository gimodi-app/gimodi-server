import { randomUUID } from 'node:crypto';
import state from '../state.js';
import { insertDmMessage, markDmDelivered, getPendingDmMessages, getDmHistory } from '../db/database.js';
import { send } from './handler.js';

const MAX_DM_LENGTH = 8000;

/**
 * Finds a connected client by their identity fingerprint.
 * @param {string} fingerprint
 * @returns {object|null}
 */
function findClientByFingerprint(fingerprint) {
  for (const client of state.clients.values()) {
    if (client.fingerprint === fingerprint) {
      return client;
    }
  }
  return null;
}

/**
 * Handles a client sending a direct message.
 * Stores the message and relays it to the recipient if they are currently connected.
 * @param {object} client
 * @param {object} data
 * @param {string} msgId
 */
export function handleDmSend(client, data, msgId) {
  if (!client.fingerprint) {
    return send(client.ws, 'server:error', { code: 'NO_IDENTITY', message: 'You must have an identity to send direct messages.' }, msgId);
  }

  const { id, recipientFingerprint, content } = data;

  if (!id || typeof id !== 'string') {
    return send(client.ws, 'server:error', { code: 'INVALID_ID', message: 'Message ID is required.' }, msgId);
  }

  if (!recipientFingerprint || typeof recipientFingerprint !== 'string') {
    return send(client.ws, 'server:error', { code: 'INVALID_RECIPIENT', message: 'Recipient fingerprint is required.' }, msgId);
  }

  if (recipientFingerprint === client.fingerprint) {
    return send(client.ws, 'server:error', { code: 'SELF_MESSAGE', message: 'You cannot send a direct message to yourself.' }, msgId);
  }

  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    return send(client.ws, 'server:error', { code: 'EMPTY_MESSAGE', message: 'Message cannot be empty.' }, msgId);
  }

  if (content.length > MAX_DM_LENGTH) {
    return send(client.ws, 'server:error', { code: 'MESSAGE_TOO_LONG', message: `Message exceeds ${MAX_DM_LENGTH} characters.` }, msgId);
  }

  const now = Date.now();

  insertDmMessage({
    id,
    senderFingerprint: client.fingerprint,
    recipientFingerprint,
    content: content.trim(),
    createdAt: now,
  });

  send(client.ws, 'dm:sent', { id }, msgId);

  const recipient = findClientByFingerprint(recipientFingerprint);
  if (recipient) {
    send(recipient.ws, 'dm:receive', {
      id,
      senderFingerprint: client.fingerprint,
      senderNickname: client.nickname,
      content: content.trim(),
      createdAt: now,
    });
  }
}

/**
 * Handles a client acknowledging receipt of a direct message.
 * Marks the message as delivered and notifies the sender if connected.
 * @param {object} client
 * @param {object} data
 * @param {string} msgId
 */
export function handleDmAck(client, data, msgId) {
  if (!client.fingerprint) {
    return;
  }

  const { id } = data;

  if (!id || typeof id !== 'string') {
    return send(client.ws, 'server:error', { code: 'INVALID_ID', message: 'Message ID is required.' }, msgId);
  }

  const deliveredAt = Date.now();
  markDmDelivered(id, deliveredAt);

  // Notify sender if still connected
  // We don't know the sender fingerprint from just the ID here, so we look it up via a history query trick:
  // Instead, we rely on the client sending back the senderFingerprint in the ack.
  const { senderFingerprint } = data;
  if (senderFingerprint) {
    const sender = findClientByFingerprint(senderFingerprint);
    if (sender) {
      send(sender.ws, 'dm:delivered', { id, deliveredAt });
    }
  }
}

/**
 * Returns DM history between the requesting client and a peer fingerprint.
 * @param {object} client
 * @param {object} data
 * @param {string} msgId
 */
export function handleDmHistory(client, data, msgId) {
  if (!client.fingerprint) {
    return send(client.ws, 'server:error', { code: 'NO_IDENTITY', message: 'You must have an identity to access direct messages.' }, msgId);
  }

  const { peerFingerprint, before, limit } = data;

  if (!peerFingerprint || typeof peerFingerprint !== 'string') {
    return send(client.ws, 'server:error', { code: 'INVALID_PEER', message: 'Peer fingerprint is required.' }, msgId);
  }

  const messages = getDmHistory(client.fingerprint, peerFingerprint, { before, limit });

  send(client.ws, 'dm:history', { peerFingerprint, messages }, msgId);
}

/**
 * Pushes all pending (undelivered) DM messages to a newly connected client.
 * Called from the connection handler after a client successfully connects.
 * @param {object} client
 */
export function deliverPendingDms(client) {
  if (!client.fingerprint) {
    return;
  }

  const pending = getPendingDmMessages(client.fingerprint);
  for (const msg of pending) {
    send(client.ws, 'dm:receive', {
      id: msg.id,
      senderFingerprint: msg.sender_fingerprint,
      content: msg.content,
      createdAt: msg.created_at,
    });
  }
}

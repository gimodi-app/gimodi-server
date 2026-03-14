import state from '../state.js';
import { insertDmMessage, markDmDelivered, getPendingDmMessages, getConversationMessages, getConversation, isConversationParticipant } from '../db/database.js';

/**
 * Sends a JSON message to a WebSocket client if the connection is open.
 * @param {import('ws').WebSocket} ws
 * @param {string} type
 * @param {object} data
 * @param {string} [id]
 */
function send(ws, type, data, id) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type, data, ...(id !== undefined && { id }) }));
  }
}

const MAX_DM_LENGTH = 16000;

/**
 * Returns all connected clients matching a fingerprint.
 * @param {string} fingerprint
 * @returns {Array<object>}
 */
function findClientsByFingerprint(fingerprint) {
  const results = [];
  for (const client of state.clients.values()) {
    if (client.fingerprint === fingerprint) {
      results.push(client);
    }
  }
  return results;
}

/**
 * Handles a client sending a direct message within a conversation.
 * @param {object} client
 * @param {object} data
 * @param {string} msgId
 */
export function handleDmSend(client, data, msgId) {
  if (!client.fingerprint) {
    return send(client.ws, 'server:error', { code: 'NO_IDENTITY', message: 'You must have an identity to send direct messages.' }, msgId);
  }

  const { id, conversationId, content, keyIndex, replyTo, replyToNickname, replyToContent } = data;

  if (!id || typeof id !== 'string') {
    return send(client.ws, 'server:error', { code: 'INVALID_ID', message: 'Message ID is required.' }, msgId);
  }

  if (!conversationId || typeof conversationId !== 'string') {
    return send(client.ws, 'server:error', { code: 'INVALID_CONVERSATION', message: 'Conversation ID is required.' }, msgId);
  }

  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    return send(client.ws, 'server:error', { code: 'EMPTY_MESSAGE', message: 'Message cannot be empty.' }, msgId);
  }

  if (content.length > MAX_DM_LENGTH) {
    return send(client.ws, 'server:error', { code: 'MESSAGE_TOO_LONG', message: `Message exceeds ${MAX_DM_LENGTH} characters.` }, msgId);
  }

  const conv = getConversation(conversationId);
  if (!conv) {
    return send(client.ws, 'server:error', { code: 'NOT_FOUND', message: 'Conversation not found.' }, msgId);
  }

  if (!isConversationParticipant(conversationId, client.fingerprint)) {
    return send(client.ws, 'server:error', { code: 'NOT_PARTICIPANT', message: 'You are not a participant in this conversation.' }, msgId);
  }

  const now = Date.now();
  const trimmedContent = content.trim();
  const safeReplyTo = replyTo && typeof replyTo === 'string' ? replyTo : null;
  const safeReplyToNickname = replyToNickname && typeof replyToNickname === 'string' ? replyToNickname : null;
  const safeReplyToContent = replyToContent && typeof replyToContent === 'string' ? replyToContent : null;

  insertDmMessage({
    id,
    conversationId,
    senderFingerprint: client.fingerprint,
    content: trimmedContent,
    keyIndex: keyIndex ?? 0,
    createdAt: now,
    replyTo: safeReplyTo,
    replyToNickname: safeReplyToNickname,
    replyToContent: safeReplyToContent,
  });

  send(client.ws, 'dm:sent', { id }, msgId);

  for (const p of conv.participants) {
    if (p.fingerprint === client.fingerprint) continue;
    const recipients = findClientsByFingerprint(p.fingerprint);
    for (const recipient of recipients) {
      send(recipient.ws, 'dm:receive', {
        id,
        conversationId,
        senderFingerprint: client.fingerprint,
        senderNickname: client.nickname,
        content: trimmedContent,
        keyIndex: keyIndex ?? 0,
        createdAt: now,
        ...(safeReplyTo && { replyTo: safeReplyTo, replyToNickname: safeReplyToNickname, replyToContent: safeReplyToContent }),
      });
    }
  }
}

/**
 * Handles a client acknowledging receipt of a direct message.
 * @param {object} client
 * @param {object} data
 * @param {string} msgId
 */
export function handleDmAck(client, data, msgId) {
  if (!client.fingerprint) return;

  const { id, senderFingerprint } = data;

  if (!id || typeof id !== 'string') {
    return send(client.ws, 'server:error', { code: 'INVALID_ID', message: 'Message ID is required.' }, msgId);
  }

  const deliveredAt = Date.now();
  markDmDelivered(id, deliveredAt);

  if (senderFingerprint) {
    const senders = findClientsByFingerprint(senderFingerprint);
    for (const sender of senders) {
      send(sender.ws, 'dm:delivered', { id, deliveredAt });
    }
  }
}

/**
 * Returns message history for a conversation.
 * @param {object} client
 * @param {object} data
 * @param {string} msgId
 */
export function handleDmHistory(client, data, msgId) {
  if (!client.fingerprint) {
    return send(client.ws, 'server:error', { code: 'NO_IDENTITY', message: 'You must have an identity to access direct messages.' }, msgId);
  }

  const { conversationId, before, limit } = data;

  if (!conversationId || typeof conversationId !== 'string') {
    return send(client.ws, 'server:error', { code: 'INVALID_CONVERSATION', message: 'Conversation ID is required.' }, msgId);
  }

  if (!isConversationParticipant(conversationId, client.fingerprint)) {
    return send(client.ws, 'server:error', { code: 'NOT_PARTICIPANT', message: 'You are not a participant in this conversation.' }, msgId);
  }

  const messages = getConversationMessages(conversationId, { before, limit });

  send(client.ws, 'dm:history', { conversationId, messages }, msgId);
}

/**
 * Pushes all pending (undelivered) DM messages to a newly connected client.
 * @param {object} client
 */
export function deliverPendingDms(client) {
  if (!client.fingerprint) return;

  const pending = getPendingDmMessages(client.fingerprint);
  for (const msg of pending) {
    send(client.ws, 'dm:receive', {
      id: msg.id,
      conversationId: msg.conversation_id,
      senderFingerprint: msg.sender_fingerprint,
      content: msg.content,
      keyIndex: msg.key_index,
      createdAt: msg.created_at,
      ...(msg.reply_to && { replyTo: msg.reply_to, replyToNickname: msg.reply_to_nickname, replyToContent: msg.reply_to_content }),
    });
  }
}

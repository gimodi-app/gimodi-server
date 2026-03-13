import { randomUUID } from 'node:crypto';

const MAX_MESSAGE_LENGTH = 4000;
import state from '../state.js';
import {
  insertDmMessage,
  getDmMessages,
  getDmMessage,
  deleteDmMessage,
  updateDmMessagePreviews,
  getDmConversations,
  getIdentity,
} from '../db/database.js';
import { send } from './handler.js';
import { fetchLinkPreviews } from '../link-preview.js';

/**
 * Computes a deterministic conversation ID from two user IDs.
 * @param {string} userIdA
 * @param {string} userIdB
 * @returns {string}
 */
function getConversationId(userIdA, userIdB) {
  return [userIdA, userIdB].sort().join(':');
}

/**
 * Sends a payload to all connected sessions of a given userId.
 * @param {string} userId
 * @param {string} type
 * @param {object} data
 */
function sendToUser(userId, type, data) {
  for (const client of state.getClientsByUserId(userId)) {
    send(client.ws, type, data);
  }
}

/**
 * Handles sending a direct message.
 * @param {object} client
 * @param {object} data
 * @param {string} [msgId]
 */
export function handleDmSend(client, data, msgId) {
  const { recipientUserId, content, replyTo } = data;

  if (!client.userId) {
    return send(client.ws, 'server:error', { code: 'IDENTITY_REQUIRED', message: 'An identity is required to send direct messages.' }, msgId);
  }

  if (!recipientUserId || typeof recipientUserId !== 'string') {
    return send(client.ws, 'server:error', { code: 'INVALID_RECIPIENT', message: 'Recipient userId is required.' }, msgId);
  }

  if (recipientUserId === client.userId) {
    return send(client.ws, 'server:error', { code: 'SELF_DM', message: 'Cannot send a direct message to yourself.' }, msgId);
  }

  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    return send(client.ws, 'server:error', { code: 'EMPTY_MESSAGE', message: 'Message cannot be empty.' }, msgId);
  }

  if (content.length > MAX_MESSAGE_LENGTH) {
    return send(client.ws, 'server:error', { code: 'MESSAGE_TOO_LONG', message: `Message exceeds ${MAX_MESSAGE_LENGTH} characters.` }, msgId);
  }

  const conversationId = getConversationId(client.userId, recipientUserId);

  let replyToContent = null;
  let replyToUserId = null;
  if (replyTo) {
    const repliedMsg = getDmMessage(replyTo);
    if (repliedMsg) {
      replyToUserId = repliedMsg.sender_user_id || null;
      replyToContent = repliedMsg.content || null;
    }
  }

  const message = {
    id: randomUUID(),
    conversationId,
    senderUserId: client.userId,
    recipientUserId,
    content: content.trim(),
    replyTo: replyTo || null,
    replyToContent,
    replyToUserId,
    createdAt: Date.now(),
  };

  insertDmMessage(message);

  const senderIdentity = getIdentity(client.userId);
  const payload = {
    id: message.id,
    conversationId,
    senderUserId: client.userId,
    recipientUserId,
    senderNickname: client.nickname,
    senderBadge: client.badge || null,
    senderRoleColor: client.roleColor || null,
    content: message.content,
    replyTo: message.replyTo,
    replyToContent: message.replyToContent,
    replyToUserId: message.replyToUserId,
    timestamp: message.createdAt,
  };

  sendToUser(client.userId, 'dm:receive', payload);
  sendToUser(recipientUserId, 'dm:receive', payload);

  send(client.ws, 'dm:send', { id: message.id }, msgId);

  fetchLinkPreviews(message.content)
    .then((previews) => {
      if (previews.length === 0) {
        return;
      }
      updateDmMessagePreviews(message.id, JSON.stringify(previews));
      const previewPayload = { messageId: message.id, conversationId, previews };
      sendToUser(client.userId, 'dm:link-preview', previewPayload);
      sendToUser(recipientUserId, 'dm:link-preview', previewPayload);
    })
    .catch(() => {});
}

/**
 * Handles fetching DM history for a conversation.
 * @param {object} client
 * @param {object} data
 * @param {string} [msgId]
 */
export function handleDmHistory(client, data, msgId) {
  const { recipientUserId, before, limit = 50 } = data;

  if (!client.userId) {
    return send(client.ws, 'server:error', { code: 'IDENTITY_REQUIRED', message: 'An identity is required for direct messages.' }, msgId);
  }

  if (!recipientUserId || typeof recipientUserId !== 'string') {
    return send(client.ws, 'server:error', { code: 'INVALID_RECIPIENT', message: 'Recipient userId is required.' }, msgId);
  }

  const conversationId = getConversationId(client.userId, recipientUserId);
  const clampedLimit = Math.min(Math.max(1, limit), 100);
  const rows = getDmMessages(conversationId, { before, limit: clampedLimit });

  const messages = rows.map((r) => ({
    id: r.id,
    conversationId: r.conversation_id,
    senderUserId: r.sender_user_id,
    recipientUserId: r.recipient_user_id,
    content: r.content,
    replyTo: r.reply_to || null,
    replyToContent: r.reply_to_content || null,
    replyToUserId: r.reply_to_user_id || null,
    linkPreviews: r.link_previews ? JSON.parse(r.link_previews) : undefined,
    timestamp: r.created_at,
    editedAt: r.edited_at || null,
  }));

  send(client.ws, 'dm:history', { conversationId, recipientUserId, messages }, msgId);
}

/**
 * Handles deleting a DM message.
 * @param {object} client
 * @param {object} data
 * @param {string} [msgId]
 */
export function handleDmDelete(client, data, msgId) {
  const { messageId } = data;

  if (!client.userId) {
    return send(client.ws, 'server:error', { code: 'IDENTITY_REQUIRED', message: 'An identity is required for direct messages.' }, msgId);
  }

  if (!messageId) {
    return send(client.ws, 'server:error', { code: 'INVALID_MESSAGE', message: 'Message ID is required.' }, msgId);
  }

  const message = getDmMessage(messageId);
  if (!message) {
    return send(client.ws, 'server:error', { code: 'NOT_FOUND', message: 'Message not found.' }, msgId);
  }

  if (message.sender_user_id !== client.userId) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'You can only delete your own messages.' }, msgId);
  }

  deleteDmMessage(messageId);

  const conversationId = message.conversation_id;
  const otherUserId = message.sender_user_id === client.userId ? message.recipient_user_id : message.sender_user_id;
  const deletePayload = { messageId, conversationId };

  sendToUser(client.userId, 'dm:deleted', deletePayload);
  sendToUser(otherUserId, 'dm:deleted', deletePayload);

  send(client.ws, 'dm:delete', { success: true }, msgId);
}

/**
 * Handles fetching a list of DM conversations for the current user.
 * @param {object} client
 * @param {object} data
 * @param {string} [msgId]
 */
export function handleDmConversations(client, data, msgId) {
  if (!client.userId) {
    return send(client.ws, 'server:error', { code: 'IDENTITY_REQUIRED', message: 'An identity is required for direct messages.' }, msgId);
  }

  const rows = getDmConversations(client.userId);

  const conversations = rows.map((r) => ({
    conversationId: r.conversation_id,
    partnerUserId: r.sender_user_id === client.userId ? r.recipient_user_id : r.sender_user_id,
    partnerFingerprint: r.partner_fingerprint || null,
    lastMessage: {
      id: r.id,
      content: r.content,
      senderUserId: r.sender_user_id,
      timestamp: r.created_at,
    },
  }));

  send(client.ws, 'dm:conversations', { conversations }, msgId);
}

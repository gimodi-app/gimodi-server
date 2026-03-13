import { randomUUID } from 'node:crypto';

const MAX_MESSAGE_LENGTH = 4000;
import state from '../state.js';
import config from '../config.js';
import { incrementCounter } from '../metrics.js';
import {
  insertMessage,
  getMessages,
  getMessagesAround,
  getMessage,
  updateMessage,
  deleteMessage,
  updateMessagePreviews,
  clearMessagePreviews,
  getUserBadge,
  getUserRoleColor,
  insertServerMessage,
  getServerMessages,
  getServerMessage,
  deleteServerMessage,
  addReaction,
  removeReaction,
  getReactions,
  pinMessage,
  unpinMessage,
  getPinnedMessages,
  isMessagePinned,
  getUserRoles,
  getIdentity,
  getChannelFiles,
  getFile,
  deleteFile,
  getMessageByFileId,
  searchMessages,
} from '../db/database.js';
import { rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { send } from './handler.js';
import { fetchLinkPreviews } from '../link-preview.js';
import { PERMISSIONS } from '../permissions.js';

/**
 * Checks whether a client has read access to a channel's chat.
 * @param {object} client
 * @param {object} channel
 * @returns {boolean}
 */
function hasChannelReadAccess(client, channel) {
  if (channel.parentId) {
    const parent = state.channels.get(channel.parentId);
    if (parent && !hasChannelReadAccess(client, parent)) {
      return false;
    }
  }
  if (!channel.readRoles || channel.readRoles.length === 0) {
    return true;
  }
  if (client.permissions.has(PERMISSIONS.CHANNEL_BYPASS_READ_RESTRICTION)) {
    return true;
  }
  if (!client.userId) {
    return false;
  }
  const userRoles = getUserRoles(client.userId);
  return userRoles.some((r) => channel.readRoles.includes(r.id));
}

/**
 * Checks whether a client has write access to a channel's chat.
 * @param {object} client
 * @param {object} channel
 * @returns {boolean}
 */
function hasChannelWriteAccess(client, channel) {
  if (channel.parentId) {
    const parent = state.channels.get(channel.parentId);
    if (parent && !hasChannelWriteAccess(client, parent)) {
      return false;
    }
  }
  if (!channel.writeRoles || channel.writeRoles.length === 0) {
    return true;
  }
  if (client.permissions.has(PERMISSIONS.CHANNEL_BYPASS_WRITE_RESTRICTION)) {
    return true;
  }
  if (!client.userId) {
    return false;
  }
  const userRoles = getUserRoles(client.userId);
  return userRoles.some((r) => channel.writeRoles.includes(r.id));
}

/**
 * Checks whether a client is allowed to access a channel's chat without being in it.
 * @param {object} client
 * @param {string} channelId
 * @param {string} [password]
 * @returns {null|{code: string, message: string}} Null if access granted, error object if denied.
 */
function checkChannelChatAccess(client, channelId, password) {
  if (client.channelId === channelId) {
    return null;
  }

  const channel = state.channels.get(channelId);
  if (!channel) {
    return { code: 'UNKNOWN_CHANNEL', message: 'Channel not found.' };
  }

  if (channel.password && !client.permissions.has(PERMISSIONS.CHANNEL_BYPASS_PASSWORD)) {
    if (password !== channel.password) {
      return { code: 'BAD_PASSWORD', message: 'Incorrect channel password.' };
    }
  }

  if (channel.allowedRoles && channel.allowedRoles.length > 0 && !client.permissions.has(PERMISSIONS.CHANNEL_BYPASS_ROLE_RESTRICTION)) {
    let hasRole = false;
    if (client.userId) {
      const userRoles = getUserRoles(client.userId);
      hasRole = userRoles.some((r) => channel.allowedRoles.includes(r.id));
    }
    if (!hasRole) {
      return { code: 'ROLE_RESTRICTED', message: 'You do not have the required role to access this channel.' };
    }
  }

  if (!hasChannelReadAccess(client, channel)) {
    return { code: 'READ_RESTRICTED', message: 'You do not have permission to read this channel.' };
  }

  return null;
}

/**
 * Sends a chat message payload to all clients in a channel and its subscribers that have read access.
 * @param {object} channel
 * @param {string} channelId
 * @param {string} eventType
 * @param {object} payload
 */
function notifyChannelAndSubscribers(channel, channelId, eventType, payload) {
  const notified = new Set(channel.clients);
  for (const peerId of notified) {
    const peer = state.clients.get(peerId);
    if (peer) {
      send(peer.ws, eventType, payload);
    }
  }
  for (const peer of state.clients.values()) {
    if (!notified.has(peer.id) && peer.chatSubscriptions.has(channelId)) {
      send(peer.ws, eventType, payload);
    }
  }
}

/**
 * Handles sending a chat message to a channel.
 * @param {object} client
 * @param {object} data
 * @param {string} [msgId]
 */
export function handleChatSend(client, data, msgId) {
  const { channelId, content, replyTo } = data;

  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    return send(client.ws, 'server:error', { code: 'EMPTY_MESSAGE', message: 'Message cannot be empty.' }, msgId);
  }

  if (content.length > MAX_MESSAGE_LENGTH) {
    return send(client.ws, 'server:error', { code: 'MESSAGE_TOO_LONG', message: `Message exceeds ${MAX_MESSAGE_LENGTH} characters.` }, msgId);
  }

  if (client.channelId !== channelId && !client.chatSubscriptions.has(channelId)) {
    return send(client.ws, 'server:error', { code: 'NOT_IN_CHANNEL', message: 'You are not in this channel.' }, msgId);
  }

  const channel = state.channels.get(channelId);
  if (!channel) {
    return;
  }

  if (channel.writeRoles && channel.writeRoles.length > 0 && !client.permissions.has(PERMISSIONS.CHANNEL_BYPASS_WRITE_RESTRICTION)) {
    let hasRole = false;
    if (client.userId) {
      const userRoles = getUserRoles(client.userId);
      hasRole = userRoles.some((r) => channel.writeRoles.includes(r.id));
    }
    if (!hasRole) {
      return send(client.ws, 'server:error', { code: 'WRITE_RESTRICTED', message: 'You do not have permission to send messages in this channel.' }, msgId);
    }
  }

  let replyToNickname = null;
  let replyToUserId = null;
  let replyToContent = null;
  if (replyTo) {
    const repliedMsg = getMessage(replyTo);
    if (repliedMsg) {
      replyToUserId = repliedMsg.user_id || null;
      replyToContent = repliedMsg.content || null;
      if (repliedMsg.user_id) {
        const identity = getIdentity(repliedMsg.user_id);
        if (identity) {
          replyToNickname = identity.name;
        }
      }
      if (!replyToNickname && repliedMsg.client_id) {
        const replyAuthor = state.clients.get(repliedMsg.client_id);
        if (replyAuthor) {
          replyToNickname = replyAuthor.nickname;
        }
      }
    }
  }

  const message = {
    id: randomUUID(),
    channelId,
    clientId: client.id,
    userId: client.userId || null,
    content: content.trim(),
    replyTo: replyTo || null,
    replyToNickname,
    replyToUserId,
    replyToContent,
    createdAt: Date.now(),
  };

  if (config.chat.persistMessages) {
    insertMessage({
      id: message.id,
      channelId: message.channelId,
      clientId: client.id,
      userId: client.userId || null,
      badge: client.badge || null,
      content: message.content,
      replyTo: message.replyTo,
      replyToNickname: message.replyToNickname,
      replyToUserId: message.replyToUserId,
      replyToContent: message.replyToContent,
      createdAt: message.createdAt,
    });
  }

  channel.lastMessageAt = message.createdAt;

  const msgPayload = {
    id: message.id,
    channelId,
    clientId: client.id,
    userId: client.userId || null,
    nickname: client.nickname,
    badge: client.badge || null,
    roleColor: client.roleColor || null,
    content: message.content,
    replyTo: message.replyTo,
    replyToNickname: message.replyToNickname,
    replyToContent: message.replyToContent,
    replyToUserId: message.replyToUserId,
    timestamp: message.createdAt,
  };

  incrementCounter('messagesTotal');

  const notified = new Set(channel.clients);
  for (const peerId of notified) {
    const peer = state.clients.get(peerId);
    if (peer && hasChannelReadAccess(peer, channel)) {
      send(peer.ws, 'chat:receive', msgPayload);
    }
  }
  for (const peer of state.clients.values()) {
    if (!notified.has(peer.id) && peer.chatSubscriptions.has(channelId) && hasChannelReadAccess(peer, channel)) {
      send(peer.ws, 'chat:receive', msgPayload);
    }
  }

  fetchLinkPreviews(message.content)
    .then((previews) => {
      if (previews.length === 0) {
        return;
      }

      if (config.chat.persistMessages) {
        updateMessagePreviews(message.id, previews);
      }

      const ch = state.channels.get(channelId);
      if (!ch) {
        return;
      }

      const notifiedPrev = new Set(ch.clients);
      for (const peerId of notifiedPrev) {
        const peer = state.clients.get(peerId);
        if (peer && hasChannelReadAccess(peer, ch)) {
          send(peer.ws, 'chat:link-preview', { messageId: message.id, channelId, previews });
        }
      }
      for (const peer of state.clients.values()) {
        if (!notifiedPrev.has(peer.id) && peer.chatSubscriptions.has(channelId) && hasChannelReadAccess(peer, ch)) {
          send(peer.ws, 'chat:link-preview', { messageId: message.id, channelId, previews });
        }
      }
    })
    .catch(() => {});
}

/**
 * Handles fetching chat history for a channel.
 * @param {object} client
 * @param {object} data
 * @param {string} [msgId]
 */
export function handleChatHistory(client, data, msgId) {
  const { channelId, before, limit, password } = data;

  if (!config.chat.persistMessages) {
    return send(client.ws, 'chat:history-result', { channelId, messages: [] }, msgId);
  }

  const accessError = checkChannelChatAccess(client, channelId, password);
  if (accessError) {
    return send(client.ws, 'server:error', accessError, msgId);
  }

  if (client.channelId === channelId) {
    const channel = state.channels.get(channelId);
    if (channel && !hasChannelReadAccess(client, channel)) {
      return send(client.ws, 'server:error', { code: 'READ_RESTRICTED', message: 'You do not have permission to read this channel.' }, msgId);
    }
  }

  const rows = getMessages(channelId, {
    before: before || undefined,
    limit: Math.min(limit || 50, 200),
  });

  const badgeCache = new Map();
  const colorCache = new Map();
  const messages = rows.map((r) => {
    const userId = r.user_id || null;
    let badge;
    let roleColor = null;
    if (userId) {
      if (!badgeCache.has(userId)) {
        badgeCache.set(userId, getUserBadge(userId) ?? null);
        colorCache.set(userId, getUserRoleColor(userId) ?? null);
      }
      badge = badgeCache.get(userId) ?? null;
      roleColor = colorCache.get(userId) ?? null;
    } else {
      badge = r.badge || null;
    }
    const reactions = aggregateReactions(getReactions(r.id), client.userId);
    return {
      id: r.id,
      channelId: r.channel_id,
      clientId: r.client_id,
      userId,
      badge,
      roleColor,
      content: r.content,
      replyTo: r.reply_to || undefined,
      replyToNickname: r.reply_to_nickname || undefined,
      replyToUserId: r.reply_to_user_id || undefined,
      replyToContent: r.reply_to_content || undefined,
      timestamp: r.created_at,
      editedAt: r.edited_at || undefined,
      linkPreviews: r.link_previews ? JSON.parse(r.link_previews) : undefined,
      reactions: reactions.length > 0 ? reactions : undefined,
    };
  });

  const pinnedRows = getPinnedMessages(channelId);
  const pinnedMessageIds = pinnedRows.map((r) => r.message_id);

  send(client.ws, 'chat:history-result', { channelId, messages, pinnedMessageIds }, msgId);
}

/**
 * Returns messages surrounding a target timestamp for jump-to-message.
 * @param {object} client
 * @param {object} data
 * @param {string} [msgId]
 */
export function handleChatContext(client, data, msgId) {
  const { channelId, timestamp, password } = data;

  if (!config.chat.persistMessages) {
    return send(client.ws, 'chat:context-result', { channelId, messages: [] }, msgId);
  }

  const accessError = checkChannelChatAccess(client, channelId, password);
  if (accessError) {
    return send(client.ws, 'server:error', accessError, msgId);
  }

  const rows = getMessagesAround(channelId, timestamp, 25);

  const badgeCache = new Map();
  const colorCache = new Map();
  const messages = rows.map((r) => {
    const userId = r.user_id || null;
    let badge;
    let roleColor = null;
    if (userId) {
      if (!badgeCache.has(userId)) {
        badgeCache.set(userId, getUserBadge(userId) ?? null);
        colorCache.set(userId, getUserRoleColor(userId) ?? null);
      }
      badge = badgeCache.get(userId) ?? null;
      roleColor = colorCache.get(userId) ?? null;
    } else {
      badge = r.badge || null;
    }
    return {
      id: r.id,
      channelId: r.channel_id,
      clientId: r.client_id,
      userId,
      badge,
      roleColor,
      content: r.content,
      timestamp: r.created_at,
      replyTo: r.reply_to || undefined,
      replyToNickname: r.reply_to_nickname || undefined,
      replyToUserId: r.reply_to_user_id || undefined,
      replyToContent: r.reply_to_content || undefined,
      editedAt: r.edited_at || undefined,
      linkPreviews: r.link_previews ? JSON.parse(r.link_previews) : undefined,
    };
  });

  send(client.ws, 'chat:context-result', { channelId, messages }, msgId);
}

/**
 * Handles sending a message to the server-wide chat.
 * @param {object} client
 * @param {object} data
 * @param {string} [msgId]
 */
export function handleServerChatSend(client, data, msgId) {
  const { content } = data;

  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    return send(client.ws, 'server:error', { code: 'EMPTY_MESSAGE', message: 'Message cannot be empty.' }, msgId);
  }

  if (content.length > MAX_MESSAGE_LENGTH) {
    return send(client.ws, 'server:error', { code: 'MESSAGE_TOO_LONG', message: `Message exceeds ${MAX_MESSAGE_LENGTH} characters.` }, msgId);
  }

  if (!client.permissions.has(PERMISSIONS.CHAT_SERVER)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'You do not have permission to use server chat.' }, msgId);
  }

  const id = randomUUID();
  const createdAt = Date.now();
  const trimmed = content.trim();

  if (config.chat.persistMessages) {
    insertServerMessage({
      id,
      userId: client.userId || null,
      clientId: client.id,
      content: trimmed,
      createdAt,
    });
  }

  const msgData = {
    id,
    userId: client.userId || null,
    clientId: client.id,
    nickname: client.nickname,
    badge: client.badge || null,
    roleColor: client.roleColor || null,
    content: trimmed,
    timestamp: createdAt,
  };

  for (const peer of state.clients.values()) {
    send(peer.ws, 'chat:server-receive', msgData);
  }
}

/**
 * Handles fetching server-wide chat history.
 * @param {object} client
 * @param {object} data
 * @param {string} [msgId]
 */
export function handleServerChatHistory(client, data, msgId) {
  const { before, limit } = data;

  if (!config.chat.persistMessages) {
    return send(client.ws, 'chat:server-history-result', { messages: [] }, msgId);
  }

  const rows = getServerMessages({
    before: before || undefined,
    limit: Math.min(limit || 50, 200),
  });

  const badgeCache = new Map();
  const colorCache = new Map();
  const messages = rows.map((r) => {
    const userId = r.user_id || null;
    let badge;
    let roleColor = null;
    if (userId) {
      if (!badgeCache.has(userId)) {
        badgeCache.set(userId, getUserBadge(userId) ?? null);
        colorCache.set(userId, getUserRoleColor(userId) ?? null);
      }
      badge = badgeCache.get(userId) ?? null;
      roleColor = colorCache.get(userId) ?? null;
    } else {
      badge = r.badge || null;
    }
    return {
      id: r.id,
      type: r.type || 'message',
      userId,
      clientId: r.client_id,
      badge,
      roleColor,
      content: r.content,
      timestamp: r.created_at,
    };
  });

  send(client.ws, 'chat:server-history-result', { messages }, msgId);
}

/**
 * Handles deleting a channel chat message.
 * @param {object} client
 * @param {object} data
 * @param {string} [msgId]
 */
export function handleChatDelete(client, data, msgId) {
  const { messageId } = data;

  if (!messageId || typeof messageId !== 'string') {
    return send(client.ws, 'server:error', { code: 'INVALID_MESSAGE', message: 'Message ID required.' }, msgId);
  }

  if (!client.userId) {
    return send(client.ws, 'server:error', { code: 'IDENTITY_REQUIRED', message: 'Identity required to delete messages.' }, msgId);
  }

  const msg = getMessage(messageId);
  if (!msg) {
    return send(client.ws, 'server:error', { code: 'MESSAGE_NOT_FOUND', message: 'Message not found.' }, msgId);
  }

  if (msg.user_id !== client.userId && !client.permissions.has(PERMISSIONS.CHAT_DELETE_ANY)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'You can only delete your own messages.' }, msgId);
  }

  try {
    const parsed = JSON.parse(msg.content);
    if (parsed.fileId) {
      const file = getFile(parsed.fileId);
      if (file) {
        const uploadsDir = resolve(config.files.storagePath);
        try {
          rmSync(join(uploadsDir, parsed.fileId), { recursive: true, force: true });
        } catch {
          /* file cleanup is best-effort */
        }
        deleteFile(parsed.fileId);
      }
    }
  } catch {
    /* content may not be JSON */
  }

  deleteMessage(messageId);

  const wasPinned = isMessagePinned(messageId, msg.channel_id);
  if (wasPinned) {
    unpinMessage(messageId, msg.channel_id);
  }

  const channel = state.channels.get(msg.channel_id);
  if (channel) {
    const notified = new Set();
    for (const peerId of channel.clients) {
      const peer = state.clients.get(peerId);
      if (peer) {
        send(peer.ws, 'chat:deleted', { messageId, channelId: msg.channel_id });
        if (wasPinned) {
          send(peer.ws, 'chat:message-unpinned', { messageId, channelId: msg.channel_id });
        }
        notified.add(peer.id);
      }
    }
    for (const peer of state.clients.values()) {
      if (!notified.has(peer.id) && peer.chatSubscriptions.has(msg.channel_id)) {
        send(peer.ws, 'chat:deleted', { messageId, channelId: msg.channel_id });
        if (wasPinned) {
          send(peer.ws, 'chat:message-unpinned', { messageId, channelId: msg.channel_id });
        }
      }
    }
  }

  send(client.ws, 'chat:delete-ok', { messageId }, msgId);
}

/**
 * Handles removing link previews from a message.
 * @param {object} client
 * @param {object} data
 * @param {string} [msgId]
 */
export function handleRemovePreview(client, data, msgId) {
  const { messageId } = data;

  if (!messageId || typeof messageId !== 'string') {
    return send(client.ws, 'server:error', { code: 'INVALID_MESSAGE', message: 'Message ID required.' }, msgId);
  }

  if (!client.userId) {
    return send(client.ws, 'server:error', { code: 'IDENTITY_REQUIRED', message: 'Identity required to remove previews.' }, msgId);
  }

  const msg = getMessage(messageId);
  if (!msg) {
    return send(client.ws, 'server:error', { code: 'MESSAGE_NOT_FOUND', message: 'Message not found.' }, msgId);
  }

  if (msg.user_id !== client.userId && !client.permissions.has(PERMISSIONS.CHAT_DELETE_ANY)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'You can only remove previews from your own messages.' }, msgId);
  }

  clearMessagePreviews(messageId);

  const channel = state.channels.get(msg.channel_id);
  if (channel) {
    notifyChannelAndSubscribers(channel, msg.channel_id, 'chat:preview-removed', { messageId, channelId: msg.channel_id });
  }

  send(client.ws, 'chat:remove-preview-ok', { messageId }, msgId);
}

/**
 * Handles editing a channel chat message.
 * @param {object} client
 * @param {object} data
 * @param {string} [msgId]
 */
export function handleChatEdit(client, data, msgId) {
  const { messageId, newContent } = data;

  if (!messageId || typeof messageId !== 'string') {
    return send(client.ws, 'server:error', { code: 'INVALID_MESSAGE', message: 'Message ID required.' }, msgId);
  }

  if (!newContent || typeof newContent !== 'string' || newContent.trim().length === 0) {
    return send(client.ws, 'server:error', { code: 'EMPTY_MESSAGE', message: 'Message content cannot be empty.' }, msgId);
  }

  if (newContent.length > MAX_MESSAGE_LENGTH) {
    return send(client.ws, 'server:error', { code: 'MESSAGE_TOO_LONG', message: `Message exceeds ${MAX_MESSAGE_LENGTH} characters.` }, msgId);
  }

  if (!client.userId) {
    return send(client.ws, 'server:error', { code: 'IDENTITY_REQUIRED', message: 'Identity required to edit messages.' }, msgId);
  }

  const msg = getMessage(messageId);
  if (!msg) {
    return send(client.ws, 'server:error', { code: 'MESSAGE_NOT_FOUND', message: 'Message not found.' }, msgId);
  }

  if (msg.user_id !== client.userId) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'You can only edit your own messages.' }, msgId);
  }

  const editedAt = Date.now();
  const trimmed = newContent.trim();
  updateMessage(messageId, trimmed, editedAt);

  const channel = state.channels.get(msg.channel_id);
  if (channel) {
    notifyChannelAndSubscribers(channel, msg.channel_id, 'chat:message-edited', { messageId, channelId: msg.channel_id, newContent: trimmed, editedAt });
  }

  send(client.ws, 'chat:edit-ok', { messageId }, msgId);
}

/**
 * Handles broadcasting a typing indicator to channel members.
 * @param {object} client
 * @param {object} data
 * @param {string} [msgId]
 */
export function handleTypingIndicator(client, data, _msgId) {
  const { channelId } = data;

  if (!channelId) {
    return;
  }
  if (client.channelId !== channelId && !client.chatSubscriptions.has(channelId)) {
    return;
  }

  const channel = state.channels.get(channelId);
  if (!channel) {
    return;
  }

  const typingPayload = { clientId: client.id, nickname: client.nickname, channelId };
  const notified = new Set();

  for (const peerId of channel.clients) {
    if (peerId === client.id) {
      continue;
    }
    const peer = state.clients.get(peerId);
    if (peer) {
      send(peer.ws, 'chat:typing', typingPayload);
      notified.add(peer.id);
    }
  }
  for (const peer of state.clients.values()) {
    if (!notified.has(peer.id) && peer.id !== client.id && peer.chatSubscriptions.has(channelId)) {
      send(peer.ws, 'chat:typing', typingPayload);
    }
  }
}

/**
 * Handles deleting a server-wide chat message.
 * @param {object} client
 * @param {object} data
 * @param {string} [msgId]
 */
export function handleServerChatDelete(client, data, msgId) {
  const { messageId } = data;

  if (!messageId || typeof messageId !== 'string') {
    return send(client.ws, 'server:error', { code: 'INVALID_MESSAGE', message: 'Message ID required.' }, msgId);
  }

  if (!client.userId) {
    return send(client.ws, 'server:error', { code: 'IDENTITY_REQUIRED', message: 'Identity required to delete messages.' }, msgId);
  }

  const msg = getServerMessage(messageId);
  if (!msg) {
    return send(client.ws, 'server:error', { code: 'MESSAGE_NOT_FOUND', message: 'Message not found.' }, msgId);
  }

  if (msg.user_id !== client.userId && !client.permissions.has(PERMISSIONS.CHAT_SERVER_DELETE)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'You can only delete your own messages.' }, msgId);
  }

  deleteServerMessage(messageId);

  for (const peer of state.clients.values()) {
    send(peer.ws, 'chat:server-deleted', { messageId });
  }

  send(client.ws, 'chat:server-delete-ok', { messageId }, msgId);
}

/**
 * Handles adding a reaction to a message.
 * @param {object} client
 * @param {object} data
 * @param {string} [msgId]
 */
export function handleReact(client, data, msgId) {
  const { messageId, emoji } = data;

  if (!messageId || typeof messageId !== 'string') {
    return send(client.ws, 'server:error', { code: 'INVALID_MESSAGE', message: 'Message ID required.' }, msgId);
  }

  if (!emoji || typeof emoji !== 'string' || emoji.length > 10) {
    return send(client.ws, 'server:error', { code: 'INVALID_EMOJI', message: 'Invalid emoji.' }, msgId);
  }

  if (!client.userId) {
    return send(client.ws, 'server:error', { code: 'IDENTITY_REQUIRED', message: 'Identity required to react.' }, msgId);
  }

  const msg = getMessage(messageId);
  if (!msg) {
    return send(client.ws, 'server:error', { code: 'MESSAGE_NOT_FOUND', message: 'Message not found.' }, msgId);
  }

  const reaction = {
    id: randomUUID(),
    messageId,
    userId: client.userId,
    emoji,
    createdAt: Date.now(),
  };

  const added = addReaction(reaction);
  if (!added) {
    return send(client.ws, 'server:error', { code: 'DUPLICATE_REACTION', message: 'You already reacted with this emoji.' }, msgId);
  }

  broadcastReactionUpdate(msg, messageId);
}

/**
 * Handles removing a reaction from a message.
 * @param {object} client
 * @param {object} data
 * @param {string} [msgId]
 */
export function handleUnreact(client, data, msgId) {
  const { messageId, emoji } = data;

  if (!messageId || typeof messageId !== 'string') {
    return send(client.ws, 'server:error', { code: 'INVALID_MESSAGE', message: 'Message ID required.' }, msgId);
  }

  if (!emoji || typeof emoji !== 'string') {
    return send(client.ws, 'server:error', { code: 'INVALID_EMOJI', message: 'Invalid emoji.' }, msgId);
  }

  if (!client.userId) {
    return send(client.ws, 'server:error', { code: 'IDENTITY_REQUIRED', message: 'Identity required to unreact.' }, msgId);
  }

  const msg = getMessage(messageId);
  if (!msg) {
    return send(client.ws, 'server:error', { code: 'MESSAGE_NOT_FOUND', message: 'Message not found.' }, msgId);
  }

  removeReaction(messageId, client.userId, emoji);

  broadcastReactionUpdate(msg, messageId);
}

/**
 * Broadcasts a reaction update to all clients in a message's channel and its subscribers.
 * @param {object} msg - The database message row.
 * @param {string} messageId
 */
function broadcastReactionUpdate(msg, messageId) {
  const channel = state.channels.get(msg.channel_id);
  if (!channel) {
    return;
  }

  const rawReactions = getReactions(messageId);
  const notified = new Set();
  for (const peerId of channel.clients) {
    const peer = state.clients.get(peerId);
    if (peer) {
      const reactions = aggregateReactions(rawReactions, peer.userId);
      send(peer.ws, 'chat:reaction-update', { messageId, reactions });
      notified.add(peer.id);
    }
  }
  for (const peer of state.clients.values()) {
    if (!notified.has(peer.id) && peer.chatSubscriptions.has(msg.channel_id)) {
      const reactions = aggregateReactions(rawReactions, peer.userId);
      send(peer.ws, 'chat:reaction-update', { messageId, reactions });
    }
  }
}

/**
 * Handles subscribing a client to a channel's chat without joining the voice channel.
 * @param {object} client
 * @param {object} data
 * @param {string} [msgId]
 */
export function handleChatSubscribe(client, data, msgId) {
  const { channelId, password } = data;
  if (!channelId || !state.channels.has(channelId)) {
    return;
  }

  const accessError = checkChannelChatAccess(client, channelId, password);
  if (accessError) {
    if (msgId) {
      send(client.ws, 'server:error', accessError, msgId);
    }
    return;
  }

  client.chatSubscriptions.add(channelId);

  const channel = state.channels.get(channelId);
  const response = { channelId };
  if (!hasChannelReadAccess(client, channel)) {
    response.readRestricted = true;
  }
  if (!hasChannelWriteAccess(client, channel)) {
    response.writeRestricted = true;
  }
  send(client.ws, 'chat:subscribed', response, msgId);
}

/**
 * Handles unsubscribing a client from a channel's chat.
 * @param {object} client
 * @param {object} data
 */
export function handleChatUnsubscribe(client, data) {
  const { channelId } = data;
  if (!channelId) {
    return;
  }
  client.chatSubscriptions.delete(channelId);
}

/**
 * Aggregates raw reaction rows by emoji into a summary with counts and current-user flags.
 * @param {Array<{emoji: string, user_id: string}>} rows
 * @param {string|null} currentUserId
 * @returns {Array<{emoji: string, count: number, userIds: string[], currentUser: boolean}>}
 */
function aggregateReactions(rows, currentUserId) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.emoji)) {
      map.set(r.emoji, { emoji: r.emoji, count: 0, userIds: [], currentUser: false });
    }
    const entry = map.get(r.emoji);
    entry.count++;
    entry.userIds.push(r.user_id);
    if (r.user_id === currentUserId) {
      entry.currentUser = true;
    }
  }
  return Array.from(map.values());
}

/**
 * Handles pinning a message in a channel.
 * @param {object} client
 * @param {object} data
 * @param {string} [msgId]
 */
export function handlePinMessage(client, data, msgId) {
  const { messageId } = data;

  if (!messageId || typeof messageId !== 'string') {
    return send(client.ws, 'server:error', { code: 'INVALID_MESSAGE', message: 'Message ID required.' }, msgId);
  }

  if (!client.permissions.has(PERMISSIONS.CHAT_PIN)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'No permission to pin messages.' }, msgId);
  }

  const msg = getMessage(messageId);
  if (!msg) {
    return send(client.ws, 'server:error', { code: 'MESSAGE_NOT_FOUND', message: 'Message not found.' }, msgId);
  }

  const success = pinMessage(messageId, msg.channel_id, client.userId);
  if (!success) {
    return send(client.ws, 'server:error', { code: 'PIN_FAILED', message: 'Failed to pin message.' }, msgId);
  }

  const channel = state.channels.get(msg.channel_id);
  if (channel) {
    notifyChannelAndSubscribers(channel, msg.channel_id, 'chat:message-pinned', { messageId, channelId: msg.channel_id, pinnedByUserId: client.userId });
  }
}

/**
 * Handles unpinning a message in a channel.
 * @param {object} client
 * @param {object} data
 * @param {string} [msgId]
 */
export function handleUnpinMessage(client, data, msgId) {
  const { messageId } = data;

  if (!messageId || typeof messageId !== 'string') {
    return send(client.ws, 'server:error', { code: 'INVALID_MESSAGE', message: 'Message ID required.' }, msgId);
  }

  if (!client.permissions.has(PERMISSIONS.CHAT_PIN)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'No permission to unpin messages.' }, msgId);
  }

  const msg = getMessage(messageId);
  if (!msg) {
    return send(client.ws, 'server:error', { code: 'MESSAGE_NOT_FOUND', message: 'Message not found.' }, msgId);
  }

  unpinMessage(messageId, msg.channel_id);

  const channel = state.channels.get(msg.channel_id);
  if (channel) {
    notifyChannelAndSubscribers(channel, msg.channel_id, 'chat:message-unpinned', { messageId, channelId: msg.channel_id });
  }
}

/**
 * Handles listing files uploaded to a channel.
 * @param {object} client
 * @param {object} data
 * @param {string} [msgId]
 */
export function handleFileList(client, data, msgId) {
  const { channelId, before, limit } = data;

  if (!client.permissions.has(PERMISSIONS.FILE_BROWSE)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'No permission to browse files.' }, msgId);
  }

  if (!channelId || !state.channels.has(channelId)) {
    return send(client.ws, 'server:error', { code: 'UNKNOWN_CHANNEL', message: 'Channel not found.' }, msgId);
  }

  const rows = getChannelFiles(channelId, {
    before: before || undefined,
    limit: Math.min(limit || 50, 200),
  });

  const files = rows.map((r) => ({
    id: r.id,
    channelId: r.channel_id,
    nickname: r.nickname,
    userId: r.user_id || null,
    filename: r.filename,
    size: r.size,
    mimeType: r.mime_type,
    createdAt: r.created_at,
    url: `/files/${r.id}/${encodeURIComponent(r.filename)}`,
  }));

  send(client.ws, 'file:list-result', { channelId, files }, msgId);
}

/**
 * Handles deleting a file and its associated chat message.
 * @param {object} client
 * @param {object} data
 * @param {string} [msgId]
 */
export function handleFileDelete(client, data, msgId) {
  const { fileId } = data;

  if (!fileId || typeof fileId !== 'string') {
    return send(client.ws, 'server:error', { code: 'INVALID_FILE', message: 'File ID required.' }, msgId);
  }

  if (!client.permissions.has(PERMISSIONS.FILE_DELETE)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'No permission to delete files.' }, msgId);
  }

  const file = getFile(fileId);
  if (!file) {
    return send(client.ws, 'server:error', { code: 'FILE_NOT_FOUND', message: 'File not found.' }, msgId);
  }

  const msg = getMessageByFileId(fileId);
  if (msg) {
    if (isMessagePinned(msg.id, msg.channel_id)) {
      unpinMessage(msg.id, msg.channel_id);
    }
    deleteMessage(msg.id);

    const channel = state.channels.get(msg.channel_id);
    if (channel) {
      for (const peerId of channel.clients) {
        const peer = state.clients.get(peerId);
        if (peer) {
          send(peer.ws, 'chat:deleted', { messageId: msg.id, channelId: msg.channel_id });
        }
      }
      for (const peer of state.clients.values()) {
        if (!channel.clients.has(peer.id) && peer.chatSubscriptions.has(msg.channel_id)) {
          send(peer.ws, 'chat:deleted', { messageId: msg.id, channelId: msg.channel_id });
        }
      }
    }
  }

  const uploadsDir = resolve(config.files.storagePath);
  try {
    rmSync(join(uploadsDir, fileId), { recursive: true, force: true });
  } catch {
    /* file cleanup is best-effort */
  }

  deleteFile(fileId);

  send(client.ws, 'file:delete-ok', { fileId }, msgId);
}

/**
 * Handles searching messages in a channel.
 * @param {object} client
 * @param {object} data
 * @param {string} [msgId]
 */
export function handleChatSearch(client, data, msgId) {
  const { channelId, query, limit } = data;

  if (!channelId || !state.channels.has(channelId)) {
    return send(client.ws, 'server:error', { code: 'UNKNOWN_CHANNEL', message: 'Channel not found.' }, msgId);
  }

  if (!query || typeof query !== 'string' || query.trim().length < 3) {
    return send(client.ws, 'server:error', { code: 'QUERY_TOO_SHORT', message: 'Search query must be at least 3 characters.' }, msgId);
  }

  if (!config.chat.persistMessages) {
    return send(client.ws, 'chat:search-result', { channelId, query: query.trim(), messages: [] }, msgId);
  }

  const accessError = checkChannelChatAccess(client, channelId);
  if (accessError) {
    return send(client.ws, 'server:error', accessError, msgId);
  }

  const channel = state.channels.get(channelId);
  if (channel && !hasChannelReadAccess(client, channel)) {
    return send(client.ws, 'server:error', { code: 'READ_RESTRICTED', message: 'You do not have permission to read this channel.' }, msgId);
  }

  const rows = searchMessages(channelId, query.trim(), {
    limit: Math.min(limit || 50, 100),
  });

  const badgeCache = new Map();
  const colorCache = new Map();
  const messages = rows.map((r) => {
    const userId = r.user_id || null;
    let badge;
    let roleColor = null;
    if (userId) {
      if (!badgeCache.has(userId)) {
        badgeCache.set(userId, getUserBadge(userId) ?? null);
        colorCache.set(userId, getUserRoleColor(userId) ?? null);
      }
      badge = badgeCache.get(userId) ?? null;
      roleColor = colorCache.get(userId) ?? null;
    } else {
      badge = r.badge || null;
    }
    return {
      id: r.id,
      channelId: r.channel_id,
      clientId: r.client_id,
      userId,
      badge,
      roleColor,
      content: r.content,
      timestamp: r.created_at,
    };
  });

  send(client.ws, 'chat:search-result', { channelId, query: query.trim(), messages }, msgId);
}

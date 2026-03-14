import { randomUUID } from 'node:crypto';
import state from '../state.js';
import {
  createConversation,
  addConversationParticipant,
  removeConversationParticipant,
  getConversation,
  getConversationsForUser,
  getConversationParticipantCount,
  isConversationParticipant,
  updateAllSessionKeys,
  findDirectConversation,
  findIdentityByFingerprint,
} from '../db/database.js';

const MAX_PARTICIPANTS = 10;

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
 * Resolves participant fingerprints to nickname using connected clients or identities table.
 * @param {Array<string>} fingerprints
 * @returns {Array<{ fingerprint: string, nickname: string }>}
 */
function resolveParticipantInfo(fingerprints) {
  return fingerprints.map((fp) => {
    const clients = findClientsByFingerprint(fp);
    const nickname = clients.length > 0 ? clients[0].nickname : fp.slice(0, 12) + '…';
    const identity = findIdentityByFingerprint(fp);
    return { fingerprint: fp, nickname, publicKeyArmored: identity?.public_key ?? null };
  });
}

/**
 * Handles creating a new conversation (1:1 or group).
 * @param {object} client
 * @param {object} data
 * @param {string} msgId
 */
export function handleConversationCreate(client, data, msgId) {
  if (!client.fingerprint) {
    return send(client.ws, 'server:error', { code: 'NO_IDENTITY', message: 'You must have an identity to create conversations.' }, msgId);
  }

  const { participants, encryptedKeys, name } = data;

  if (!Array.isArray(participants) || participants.length === 0) {
    return send(client.ws, 'server:error', { code: 'INVALID_PARTICIPANTS', message: 'At least one participant is required.' }, msgId);
  }

  const allParticipants = [...new Set([client.fingerprint, ...participants])];

  if (allParticipants.length > MAX_PARTICIPANTS) {
    return send(client.ws, 'server:error', { code: 'TOO_MANY_PARTICIPANTS', message: `Maximum ${MAX_PARTICIPANTS} participants allowed.` }, msgId);
  }

  if (allParticipants.length < 2) {
    return send(client.ws, 'server:error', { code: 'INVALID_PARTICIPANTS', message: 'A conversation requires at least 2 participants.' }, msgId);
  }

  const isGroup = allParticipants.length > 2;
  const type = isGroup ? 'group' : 'direct';

  if (type === 'direct') {
    const otherFp = allParticipants.find((fp) => fp !== client.fingerprint);
    const existing = findDirectConversation(client.fingerprint, otherFp);
    if (existing) {
      return send(client.ws, 'server:error', { code: 'CONVERSATION_EXISTS', message: 'A direct conversation with this user already exists.', conversationId: existing }, msgId);
    }
  }

  if (isGroup && (!encryptedKeys || typeof encryptedKeys !== 'object')) {
    return send(client.ws, 'server:error', { code: 'MISSING_KEYS', message: 'Encrypted session keys are required for group conversations.' }, msgId);
  }

  const now = Date.now();
  const convId = randomUUID();

  createConversation({
    id: convId,
    name: isGroup ? (name || null) : null,
    type,
    creatorFingerprint: client.fingerprint,
    createdAt: now,
  });

  for (const fp of allParticipants) {
    const encKey = isGroup ? (encryptedKeys?.[fp] ?? null) : null;
    addConversationParticipant(convId, fp, encKey, now);
  }

  const participantInfo = resolveParticipantInfo(allParticipants);

  send(client.ws, 'conversation:created', {
    id: convId,
    name: isGroup ? (name || null) : null,
    type,
    participants: participantInfo,
    creatorFingerprint: client.fingerprint,
    createdAt: now,
    encryptedSessionKey: isGroup ? (encryptedKeys?.[client.fingerprint] ?? null) : null,
  }, msgId);

  for (const fp of participants) {
    if (fp === client.fingerprint) continue;
    const clients = findClientsByFingerprint(fp);
    for (const c of clients) {
      send(c.ws, 'conversation:invite', {
        conversationId: convId,
        name: isGroup ? (name || null) : null,
        type,
        creatorFingerprint: client.fingerprint,
        participants: participantInfo,
        encryptedKey: isGroup ? (encryptedKeys?.[fp] ?? null) : null,
      });
    }
  }
}

/**
 * Handles a participant acknowledging a conversation invite.
 * @param {object} client
 * @param {object} data
 * @param {string} msgId
 */
export function handleConversationJoined(client, data, msgId) {
  if (!client.fingerprint) return;

  const { conversationId } = data;
  const conv = getConversation(conversationId);
  if (!conv) return;

  if (!isConversationParticipant(conversationId, client.fingerprint)) return;

  for (const p of conv.participants) {
    if (p.fingerprint === client.fingerprint) continue;
    const clients = findClientsByFingerprint(p.fingerprint);
    for (const c of clients) {
      send(c.ws, 'conversation:participant-joined', {
        conversationId,
        fingerprint: client.fingerprint,
        nickname: client.nickname,
      });
    }
  }
}

/**
 * Handles a participant leaving a conversation.
 * @param {object} client
 * @param {object} data
 * @param {string} msgId
 */
export function handleConversationLeave(client, data, msgId) {
  if (!client.fingerprint) return;

  const { conversationId } = data;
  const conv = getConversation(conversationId);
  if (!conv) return;

  if (!isConversationParticipant(conversationId, client.fingerprint)) return;

  if (conv.conversation.type === 'direct') {
    return send(client.ws, 'server:error', { code: 'CANNOT_LEAVE', message: 'Cannot leave a direct conversation.' }, msgId);
  }

  removeConversationParticipant(conversationId, client.fingerprint);

  for (const p of conv.participants) {
    if (p.fingerprint === client.fingerprint) continue;
    const clients = findClientsByFingerprint(p.fingerprint);
    for (const c of clients) {
      send(c.ws, 'conversation:participant-left', {
        conversationId,
        fingerprint: client.fingerprint,
      });
    }
  }
}

/**
 * Handles the creator removing a participant from a group conversation.
 * @param {object} client
 * @param {object} data
 * @param {string} msgId
 */
export function handleConversationRemoveParticipant(client, data, msgId) {
  if (!client.fingerprint) return;

  const { conversationId, fingerprint } = data;
  const conv = getConversation(conversationId);
  if (!conv) {
    return send(client.ws, 'server:error', { code: 'NOT_FOUND', message: 'Conversation not found.' }, msgId);
  }

  if (conv.conversation.creator_fingerprint !== client.fingerprint) {
    return send(client.ws, 'server:error', { code: 'NOT_CREATOR', message: 'Only the conversation creator can remove participants.' }, msgId);
  }

  if (conv.conversation.type === 'direct') {
    return send(client.ws, 'server:error', { code: 'CANNOT_REMOVE', message: 'Cannot remove participants from a direct conversation.' }, msgId);
  }

  if (fingerprint === client.fingerprint) {
    return send(client.ws, 'server:error', { code: 'CANNOT_REMOVE_SELF', message: 'Use conversation:leave instead.' }, msgId);
  }

  removeConversationParticipant(conversationId, fingerprint);

  for (const p of conv.participants) {
    const clients = findClientsByFingerprint(p.fingerprint);
    for (const c of clients) {
      send(c.ws, 'conversation:participant-left', {
        conversationId,
        fingerprint,
        removedBy: client.fingerprint,
      });
    }
  }
}

/**
 * Handles listing all conversations for the requesting client.
 * @param {object} client
 * @param {object} data
 * @param {string} msgId
 */
export function handleConversationList(client, data, msgId) {
  if (!client.fingerprint) {
    return send(client.ws, 'server:error', { code: 'NO_IDENTITY', message: 'You must have an identity.' }, msgId);
  }

  const convs = getConversationsForUser(client.fingerprint);
  const result = convs.map(({ conversation, participants }) => {
    const myParticipant = participants.find((p) => p.fingerprint === client.fingerprint);
    return {
      id: conversation.id,
      name: conversation.name,
      type: conversation.type,
      creatorFingerprint: conversation.creator_fingerprint,
      createdAt: conversation.created_at,
      participants: resolveParticipantInfo(participants.map((p) => p.fingerprint)),
      encryptedSessionKey: myParticipant?.encrypted_session_key ?? null,
    };
  });

  send(client.ws, 'conversation:list', { conversations: result }, msgId);
}

/**
 * Handles the creator distributing new session keys after key rotation.
 * @param {object} client
 * @param {object} data
 * @param {string} msgId
 */
export function handleConversationKeyUpdate(client, data, msgId) {
  if (!client.fingerprint) return;

  const { conversationId, encryptedKeys, keyIndex } = data;
  const conv = getConversation(conversationId);
  if (!conv) {
    return send(client.ws, 'server:error', { code: 'NOT_FOUND', message: 'Conversation not found.' }, msgId);
  }

  if (conv.conversation.creator_fingerprint !== client.fingerprint) {
    return send(client.ws, 'server:error', { code: 'NOT_CREATOR', message: 'Only the conversation creator can update session keys.' }, msgId);
  }

  if (!encryptedKeys || typeof encryptedKeys !== 'object') {
    return send(client.ws, 'server:error', { code: 'MISSING_KEYS', message: 'Encrypted keys are required.' }, msgId);
  }

  updateAllSessionKeys(conversationId, encryptedKeys);

  for (const p of conv.participants) {
    if (p.fingerprint === client.fingerprint) continue;
    const encryptedKey = encryptedKeys[p.fingerprint];
    if (!encryptedKey) continue;
    const clients = findClientsByFingerprint(p.fingerprint);
    for (const c of clients) {
      send(c.ws, 'conversation:key-update', {
        conversationId,
        encryptedKey,
        keyIndex,
      });
    }
  }
}

/**
 * Handles the creator adding a new participant to a group conversation.
 * @param {object} client
 * @param {object} data
 * @param {string} msgId
 */
export function handleConversationAddParticipant(client, data, msgId) {
  if (!client.fingerprint) return;

  const { conversationId, fingerprint, encryptedKey } = data;
  const conv = getConversation(conversationId);
  if (!conv) {
    return send(client.ws, 'server:error', { code: 'NOT_FOUND', message: 'Conversation not found.' }, msgId);
  }

  if (conv.conversation.creator_fingerprint !== client.fingerprint) {
    return send(client.ws, 'server:error', { code: 'NOT_CREATOR', message: 'Only the conversation creator can add participants.' }, msgId);
  }

  if (conv.conversation.type === 'direct') {
    return send(client.ws, 'server:error', { code: 'CANNOT_ADD', message: 'Cannot add participants to a direct conversation.' }, msgId);
  }

  if (isConversationParticipant(conversationId, fingerprint)) {
    return send(client.ws, 'server:error', { code: 'ALREADY_PARTICIPANT', message: 'User is already a participant.' }, msgId);
  }

  const currentCount = getConversationParticipantCount(conversationId);
  if (currentCount >= MAX_PARTICIPANTS) {
    return send(client.ws, 'server:error', { code: 'TOO_MANY_PARTICIPANTS', message: `Maximum ${MAX_PARTICIPANTS} participants allowed.` }, msgId);
  }

  const now = Date.now();
  addConversationParticipant(conversationId, fingerprint, encryptedKey ?? null, now);

  const updatedConv = getConversation(conversationId);
  const participantInfo = resolveParticipantInfo(updatedConv.participants.map((p) => p.fingerprint));

  const newClients = findClientsByFingerprint(fingerprint);
  for (const c of newClients) {
    send(c.ws, 'conversation:invite', {
      conversationId,
      name: conv.conversation.name,
      type: conv.conversation.type,
      creatorFingerprint: conv.conversation.creator_fingerprint,
      participants: participantInfo,
      encryptedKey: encryptedKey ?? null,
    });
  }

  for (const p of conv.participants) {
    const clients = findClientsByFingerprint(p.fingerprint);
    for (const c of clients) {
      send(c.ws, 'conversation:participant-joined', {
        conversationId,
        fingerprint,
        nickname: newClients.length > 0 ? newClients[0].nickname : fingerprint.slice(0, 12) + '…',
      });
    }
  }
}

/**
 * Delivers pending conversation invites to a newly connected client.
 * @param {object} client
 */
export function deliverPendingConversationInvites(client) {
  if (!client.fingerprint) return;

  const convs = getConversationsForUser(client.fingerprint);
  for (const { conversation, participants } of convs) {
    const myParticipant = participants.find((p) => p.fingerprint === client.fingerprint);
    send(client.ws, 'conversation:invite', {
      conversationId: conversation.id,
      name: conversation.name,
      type: conversation.type,
      creatorFingerprint: conversation.creator_fingerprint,
      participants: resolveParticipantInfo(participants.map((p) => p.fingerprint)),
      encryptedKey: myParticipant?.encrypted_session_key ?? null,
    });
  }
}

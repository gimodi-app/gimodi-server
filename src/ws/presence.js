import state from '../state.js';
import { send } from './handler.js';
import { getIdentity } from '../db/database.js';

/**
 * Handles a client subscribing to presence updates for a set of fingerprints.
 * @param {object} client
 * @param {object} data
 * @param {string} [msgId]
 */
export function handlePresenceSubscribe(client, data, msgId) {
  const { fingerprints } = data;
  if (!Array.isArray(fingerprints)) {
    return send(client.ws, 'server:error', { code: 'INVALID_DATA', message: 'fingerprints must be an array.' }, msgId);
  }

  if (!state.presenceSubscriptions) {
    state.presenceSubscriptions = new Map();
  }

  let subs = state.presenceSubscriptions.get(client.id);
  if (!subs) {
    subs = new Set();
    state.presenceSubscriptions.set(client.id, subs);
  }

  for (const fp of fingerprints) {
    if (typeof fp === 'string') {
      subs.add(fp);
    }
  }

  const onlineStatuses = {};
  for (const fp of subs) {
    onlineStatuses[fp] = isFingerOnline(fp);
  }

  send(client.ws, 'presence:status', { statuses: onlineStatuses }, msgId);
}

/**
 * Handles a client unsubscribing from presence updates.
 * @param {object} client
 * @param {object} data
 * @param {string} [msgId]
 */
export function handlePresenceUnsubscribe(client, data, msgId) {
  const { fingerprints } = data;

  if (!state.presenceSubscriptions) {
    return;
  }

  const subs = state.presenceSubscriptions.get(client.id);
  if (!subs) {
    return;
  }

  if (Array.isArray(fingerprints)) {
    for (const fp of fingerprints) {
      subs.delete(fp);
    }
  } else {
    state.presenceSubscriptions.delete(client.id);
  }
}

/**
 * Checks whether any client with the given fingerprint is currently connected.
 * @param {string} fingerprint
 * @returns {boolean}
 */
function isFingerOnline(fingerprint) {
  for (const c of state.clients.values()) {
    if (c.fingerprint === fingerprint) {
      return true;
    }
  }
  return false;
}

/**
 * Notifies all subscribers about a presence change for the given fingerprint.
 * @param {string} fingerprint
 * @param {boolean} online
 */
export function notifyPresenceChange(fingerprint, online) {
  if (!fingerprint || !state.presenceSubscriptions) {
    return;
  }

  for (const [clientId, subs] of state.presenceSubscriptions) {
    if (!subs.has(fingerprint)) {
      continue;
    }
    const subscriber = state.clients.get(clientId);
    if (subscriber) {
      send(subscriber.ws, 'presence:update', { fingerprint, online });
    }
  }
}

/**
 * Cleans up presence subscriptions for a disconnecting client.
 * @param {string} clientId
 */
export function cleanupPresence(clientId) {
  if (state.presenceSubscriptions) {
    state.presenceSubscriptions.delete(clientId);
  }
}

import state from '../state.js';
import { PERMISSIONS } from '../permissions.js';
import config, { mergeAndSaveConfig, getEnvLockedKeys } from '../config.js';
import HIDDEN_SETTINGS from '../hidden-settings.js';
import { updateChannel } from '../db/database.js';
import { send, broadcast } from './handler.js';

/**
 * Strips hidden settings keys from a nested object.
 * @param {object} obj
 */
function stripHiddenKeys(obj) {
  for (const key of HIDDEN_SETTINGS) {
    const parts = key.split('.');
    let target = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (target === null || target === undefined || typeof target !== 'object') {
        break;
      }
      target = target[parts[i]];
    }
    if (target !== null && target !== undefined && typeof target === 'object') {
      delete target[parts[parts.length - 1]];
    }
  }
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleGetSettings(client, data, id) {
  if (!client.permissions.has(PERMISSIONS.SERVER_MANAGE_SETTINGS)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'Permission denied.' }, id);
  }
  const filtered = JSON.parse(JSON.stringify(config));
  stripHiddenKeys(filtered);
  send(client.ws, 'server:settings', { settings: filtered, envLockedKeys: getEnvLockedKeys() }, id);
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleSetSettings(client, data, id) {
  if (!client.permissions.has(PERMISSIONS.SERVER_MANAGE_SETTINGS)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'Permission denied.' }, id);
  }
  const updates = data.settings;
  if (!updates || typeof updates !== 'object') {
    return send(client.ws, 'server:error', { code: 'INVALID', message: 'Invalid settings payload.' }, id);
  }
  stripHiddenKeys(updates);

  const newDefaultId = updates.defaultChannelId;
  const oldDefaultId = config.defaultChannelId || state.getDefaultChannelId();

  mergeAndSaveConfig(updates);

  if (newDefaultId && newDefaultId !== oldDefaultId) {
    const newCh = state.channels.get(newDefaultId);
    if (newCh) {
      for (const ch of state.channels.values()) {
        if (ch.isDefault) {
          ch.isDefault = false;
          updateChannel(ch.id, { isDefault: false });
          broadcast('channel:updated', { channelId: ch.id, updates: { isDefault: false } });
        }
      }
      newCh.isDefault = true;
      updateChannel(newDefaultId, { isDefault: true });
      broadcast('channel:updated', { channelId: newDefaultId, updates: { isDefault: true } });
    }
  }

  send(client.ws, 'server:settings-saved', {}, id);
}

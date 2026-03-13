import { getAllChannels, getAllChannelAllowedRoles, getAllChannelWriteRoles, getAllChannelReadRoles, getAllChannelVisibilityRoles, getLastMessageTimestamps } from './db/database.js';
import config from './config.js';
import logger from './logger.js';

/**
 * @typedef {object} Client
 * @property {string} id
 * @property {string|null} userId
 * @property {string} nickname
 * @property {import('ws').WebSocket} ws
 * @property {string|null} channelId
 * @property {string} ip
 * @property {number} connectedAt
 * @property {string|null} clientVersion
 * @property {object|null} sendTransport
 * @property {object|null} recvTransport
 * @property {Map} producers
 * @property {Map} consumers
 * @property {object|null} rtpCapabilities
 * @property {boolean} muted
 * @property {boolean} deafened
 * @property {string|null} badge
 * @property {Set<string>} permissions
 * @property {Set<string>} chatSubscriptions
 * @property {boolean} observe
 */

/**
 * @typedef {object} Channel
 * @property {string} id
 * @property {string} name
 * @property {string|null} parentId
 * @property {string|null} password
 * @property {number|null} maxUsers
 * @property {string} description
 * @property {boolean} isDefault
 * @property {number} sortOrder
 * @property {boolean} moderated
 * @property {string} type
 * @property {boolean} isTemporary
 * @property {string[]} allowedRoles
 * @property {string[]} writeRoles
 * @property {string[]} readRoles
 * @property {string[]} visibilityRoles
 * @property {Set<string>} clients
 * @property {object|null} router
 * @property {Set<string>} voiceGranted
 * @property {Set<string>} voiceRequests
 * @property {NodeJS.Timeout|null} deleteTimer
 * @property {number|null} lastMessageAt
 */

class ServerState {
  constructor() {
    /** @type {Map<string, Client>} */
    this.clients = new Map();
    /** @type {Map<string, Channel>} */
    this.channels = new Map();
  }

  /**
   * Loads all channels from the database into memory.
   */
  loadChannelsFromDb() {
    const rows = getAllChannels();
    const allowedRolesMap = getAllChannelAllowedRoles();
    const writeRolesMap = getAllChannelWriteRoles();
    const readRolesMap = getAllChannelReadRoles();
    const visibilityRolesMap = getAllChannelVisibilityRoles();
    const lastMessageMap = getLastMessageTimestamps();
    for (const row of rows) {
      this.channels.set(row.id, {
        id: row.id,
        name: row.name,
        parentId: row.parent_id,
        password: row.password,
        maxUsers: row.max_users,
        description: row.description || '',
        isDefault: !!row.is_default,
        sortOrder: row.sort_order,
        moderated: !!row.moderated,
        type: row.type || 'channel',
        isTemporary: !!row.is_temporary,
        allowedRoles: allowedRolesMap.get(row.id) || [],
        writeRoles: writeRolesMap.get(row.id) || [],
        readRoles: readRolesMap.get(row.id) || [],
        visibilityRoles: visibilityRolesMap.get(row.id) || [],
        clients: new Set(),
        router: null,
        voiceGranted: new Set(),
        voiceRequests: new Set(),
        deleteTimer: null,
        lastMessageAt: lastMessageMap.get(row.id) || null,
      });
    }
    logger.info(`Loaded ${this.channels.size} channel(s) from database.`);
  }

  /**
   * Returns the ID of the default channel.
   * @returns {string|null}
   */
  getDefaultChannelId() {
    if (config.defaultChannelId && this.channels.has(config.defaultChannelId)) {
      return config.defaultChannelId;
    }
    for (const ch of this.channels.values()) {
      if (ch.isDefault) {
        return ch.id;
      }
    }
    const first = this.channels.values().next().value;
    return first?.id ?? null;
  }

  /**
   * Registers a new client in state.
   * @param {Client} client
   */
  addClient(client) {
    this.clients.set(client.id, client);
  }

  /**
   * Removes a client from state and their current channel.
   * @param {string} clientId
   * @returns {Client|null}
   */
  removeClient(clientId) {
    const client = this.clients.get(clientId);
    if (!client) {
      return null;
    }

    const channel = this.channels.get(client.channelId);
    if (channel) {
      channel.clients.delete(clientId);
      channel.voiceGranted.delete(clientId);
      channel.voiceRequests.delete(clientId);
    }

    this.clients.delete(clientId);
    return client;
  }

  /**
   * Moves a client from their current channel to a new one.
   * @param {string} clientId
   * @param {string} channelId
   * @returns {boolean}
   */
  moveClientToChannel(clientId, channelId) {
    const client = this.clients.get(clientId);
    if (!client) {
      return false;
    }

    const oldChannel = this.channels.get(client.channelId);
    if (oldChannel) {
      oldChannel.clients.delete(clientId);
      oldChannel.voiceGranted.delete(clientId);
      oldChannel.voiceRequests.delete(clientId);
    }

    const newChannel = this.channels.get(channelId);
    if (!newChannel) {
      return false;
    }

    newChannel.clients.add(clientId);
    client.channelId = channelId;
    return true;
  }

  /**
   * Returns the number of non-observe clients.
   * @returns {number}
   */
  getFullClientCount() {
    let count = 0;
    for (const client of this.clients.values()) {
      if (!client.observe) {
        count++;
      }
    }
    return count;
  }

  /**
   * Checks if a nickname is already in use (case-insensitive).
   * @param {string} nickname
   * @param {boolean} [excludeObserve] - If true, skip observe-mode clients.
   * @returns {boolean}
   */
  isNicknameTaken(nickname, excludeObserve) {
    for (const client of this.clients.values()) {
      if (excludeObserve && client.observe) {
        continue;
      }
      if (client.nickname.toLowerCase() === nickname.toLowerCase()) {
        return true;
      }
    }
    return false;
  }

  /**
   * Returns all clients in a given channel.
   * @param {string} channelId
   * @returns {Client[]}
   */
  getClientsByChannel(channelId) {
    const channel = this.channels.get(channelId);
    if (!channel) {
      return [];
    }
    return [...channel.clients].map((id) => this.clients.get(id)).filter(Boolean);
  }

  /**
   * Returns the channel list formatted for client consumption.
   * @returns {object[]}
   */
  getChannelList() {
    return [...this.channels.values()].map((ch) => ({
      id: ch.id,
      name: ch.name,
      parentId: ch.parentId,
      hasPassword: !!ch.password,
      maxUsers: ch.maxUsers,
      description: ch.description,
      isDefault: ch.isDefault,
      sortOrder: ch.sortOrder,
      moderated: ch.moderated,
      type: ch.type || 'channel',
      isTemporary: ch.isTemporary || false,
      allowedRoles: ch.allowedRoles || [],
      writeRoles: ch.writeRoles || [],
      readRoles: ch.readRoles || [],
      visibilityRoles: ch.visibilityRoles || [],
      userCount: ch.clients.size,
      lastMessageAt: ch.lastMessageAt || null,
    }));
  }

  /**
   * Returns the client list formatted for client consumption.
   * @returns {object[]}
   */
  getClientList() {
    return [...this.clients.values()].filter((c) => !c.observe).map((c) => ({
      id: c.id,
      userId: c.userId || null,
      nickname: c.nickname,
      channelId: c.channelId,
      badge: c.badge || null,
      roleColor: c.roleColor || null,
      rolePosition: c.rolePosition ?? Infinity,
      muted: !!c.muted,
      deafened: !!c.deafened,
    }));
  }
}

const state = new ServerState();
export default state;

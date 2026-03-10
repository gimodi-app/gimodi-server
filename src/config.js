import { getAllConfigValues, setConfigValue, setConfigValues } from './db/database.js';

/** @type {object} */
const defaults = {
  name: 'Gimodi Server',
  port: 6833,
  password: null,
  maxClients: 100,
  maxConnectionsPerIp: 5,
  media: {
    listenIp: '0.0.0.0',
    announcedIp: null,
    rtcPort: 40000,
    workers: 0,
    logLevel: 'warn',
  },
  chat: {
    persistMessages: true,
    tempChannelDeleteDelay: 180,
  },
  files: {
    maxFileSize: 10 * 1024 * 1024 * 1024,
    storagePath: './data/uploads',
    publicUrl: null,
  },
  defaultChannelId: null,
  generateAdminToken: false,
  ssl: {
    certPath: './data/cert.pem',
    keyPath: './data/key.pem',
  },
  icon: {
    hash: null,
    filename: null,
  },
  metrics: {
    enabled: false,
  },
};

/** @type {Record<string, {key: string, type: string}>} */
const ENV_MAP = {
  GIMODI_NAME:                          { key: 'name', type: 'string' },
  GIMODI_PORT:                          { key: 'port', type: 'number' },
  GIMODI_PASSWORD:                      { key: 'password', type: 'string' },
  GIMODI_MAX_CLIENTS:                   { key: 'maxClients', type: 'number' },
  GIMODI_MAX_CONNECTIONS_PER_IP:        { key: 'maxConnectionsPerIp', type: 'number' },
  GIMODI_MEDIA_LISTEN_IP:              { key: 'media.listenIp', type: 'string' },
  GIMODI_MEDIA_ANNOUNCED_IP:           { key: 'media.announcedIp', type: 'string' },
  GIMODI_MEDIA_RTC_PORT:               { key: 'media.rtcPort', type: 'number' },
  GIMODI_MEDIA_WORKERS:                { key: 'media.workers', type: 'number' },
  GIMODI_MEDIA_LOG_LEVEL:              { key: 'media.logLevel', type: 'string' },
  GIMODI_CHAT_PERSIST_MESSAGES:        { key: 'chat.persistMessages', type: 'boolean' },
  GIMODI_CHAT_TEMP_CHANNEL_DELETE_DELAY: { key: 'chat.tempChannelDeleteDelay', type: 'number' },
  GIMODI_FILES_MAX_FILE_SIZE:          { key: 'files.maxFileSize', type: 'number' },
  GIMODI_FILES_STORAGE_PATH:           { key: 'files.storagePath', type: 'string' },
  GIMODI_FILES_PUBLIC_URL:             { key: 'files.publicUrl', type: 'string' },
  GIMODI_DEFAULT_CHANNEL_ID:           { key: 'defaultChannelId', type: 'string' },
  GIMODI_GENERATE_ADMIN_TOKEN:         { key: 'generateAdminToken', type: 'boolean' },
  GIMODI_SSL_CERT_PATH:               { key: 'ssl.certPath', type: 'string' },
  GIMODI_SSL_KEY_PATH:                 { key: 'ssl.keyPath', type: 'string' },
  GIMODI_ICON_HASH:                    { key: 'icon.hash', type: 'string' },
  GIMODI_ICON_FILENAME:               { key: 'icon.filename', type: 'string' },
  GIMODI_METRICS_ENABLED:             { key: 'metrics.enabled', type: 'boolean' },
};

/**
 * @param {object} obj
 * @param {string} path - Dot-separated path (e.g. "media.listenIp")
 * @returns {*}
 */
function getNestedValue(obj, path) {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

/**
 * @param {object} obj
 * @param {string} path - Dot-separated path
 * @param {*} value
 */
function setNestedValue(obj, path, value) {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current[parts[i]] == null || typeof current[parts[i]] !== 'object') {
      current[parts[i]] = {};
    }
    current = current[parts[i]];
  }
  current[parts[parts.length - 1]] = value;
}

/**
 * @param {string} raw
 * @param {string} type
 * @returns {*}
 */
function parseEnvValue(raw, type) {
  if (raw === '' || raw === 'null') return null;
  switch (type) {
    case 'number': return Number(raw);
    case 'boolean': return raw === 'true' || raw === '1';
    default: return raw;
  }
}

const config = JSON.parse(JSON.stringify(defaults));

const dbValues = getAllConfigValues();
for (const [key, value] of Object.entries(dbValues)) {
  setNestedValue(config, key, value);
}

/** @type {Set<string>} */
const envLockedKeys = new Set();
for (const [envVar, { key, type }] of Object.entries(ENV_MAP)) {
  if (process.env[envVar] !== undefined) {
    setNestedValue(config, key, parseEnvValue(process.env[envVar], type));
    envLockedKeys.add(key);
  }
}

/**
 * Returns the list of config keys locked by environment variables.
 * @returns {string[]}
 */
export function getEnvLockedKeys() {
  return [...envLockedKeys];
}

/**
 * Flattens a nested config object into dot-separated key-value pairs.
 * @param {object} obj
 * @param {string} [prefix]
 * @returns {Record<string, *>}
 */
function flattenConfig(obj, prefix = '') {
  const result = {};
  for (const [key, val] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      Object.assign(result, flattenConfig(val, fullKey));
    } else {
      result[fullKey] = val;
    }
  }
  return result;
}

/**
 * Updates a single config value in memory and persists to DB.
 * @param {string} key - Dot-separated config key
 * @param {*} value
 */
export function updateConfig(key, value) {
  setNestedValue(config, key, value);
  setConfigValue(key, value);
}

/**
 * Merges a nested settings object into config and persists all changed keys.
 * @param {object} updates
 */
export function mergeAndSaveConfig(updates) {
  const flat = flattenConfig(updates);
  const toSave = {};
  for (const [key, value] of Object.entries(flat)) {
    setNestedValue(config, key, value);
    toSave[key] = value;
  }
  setConfigValues(toSave);
}

export default config;

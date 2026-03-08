import { randomUUID } from 'node:crypto';
import state from '../state.js';
import logger from '../logger.js';
import { PERMISSIONS } from '../permissions.js';
import { getAdminToken, redeemAdminToken, getUserPermissions, getUserBadge, getUserRoles, assignRole, removeRole, listAdminTokens, insertAdminToken, deleteAdminToken, deleteExpiredTokens, getRoles, logAuditEvent } from '../db/database.js';
import { send, broadcast } from './handler.js';

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleTokenRedeem(client, data, id) {
  const { token } = data;
  if (!token || typeof token !== 'string') {
    return send(client.ws, 'server:error', { code: 'INVALID_TOKEN', message: 'Token is required.' }, id);
  }
  if (!client.userId) {
    return send(client.ws, 'server:error', { code: 'IDENTITY_REQUIRED', message: 'You must connect with an identity to redeem a token.' }, id);
  }
  const record = getAdminToken(token);
  if (!record) {
    return send(client.ws, 'server:error', { code: 'INVALID_TOKEN', message: 'Invalid token.' }, id);
  }
  if (record.redeemed_at) {
    return send(client.ws, 'server:error', { code: 'TOKEN_REDEEMED', message: 'This token has already been redeemed.' }, id);
  }
  if (record.expires_at && record.expires_at < Date.now()) {
    deleteExpiredTokens();
    return send(client.ws, 'server:error', { code: 'TOKEN_EXPIRED', message: 'This token has expired.' }, id);
  }
  redeemAdminToken(token, client.userId);
  const targetRole = record.role || 'admin';
  const roleExists = getRoles().some(r => r.id === targetRole);
  if (!roleExists) {
    return send(client.ws, 'server:error', { code: 'INVALID_ROLE', message: `Role "${targetRole}" no longer exists.` }, id);
  }
  const existing = getUserRoles(client.userId);
  for (const r of existing) removeRole(client.userId, r.id);
  assignRole(client.userId, targetRole);
  client.permissions = getUserPermissions(client.userId);
  client.badge = getUserBadge(client.userId);
  logger.info(`Admin token redeemed by ${client.nickname} (userId=${client.userId})`);
  broadcast('server:admin-changed', { clientId: client.id, badge: client.badge });
  send(client.ws, 'token:redeemed', { role: record.role, permissions: [...client.permissions], badge: client.badge }, id);
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleTokenList(client, data, id) {
  if (!client.permissions.has(PERMISSIONS.TOKEN_LIST)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'Admin access required.' }, id);
  }
  const tokens = listAdminTokens();
  send(client.ws, 'token:list-result', { tokens }, id);
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleTokenCreate(client, data, id) {
  if (!client.permissions.has(PERMISSIONS.TOKEN_CREATE)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'Admin access required.' }, id);
  }
  const role = data.role || 'admin';
  const validRoles = getRoles();
  if (!validRoles.some(r => r.id === role)) {
    return send(client.ws, 'server:error', { code: 'INVALID_ROLE', message: 'Role does not exist.' }, id);
  }
  const expiresIn = typeof data.expiresIn === 'number' && data.expiresIn > 0
    ? data.expiresIn
    : 24 * 60 * 60 * 1000;
  const now = Date.now();
  const expiresAt = now + expiresIn;
  const token = randomUUID();
  insertAdminToken({ token, role, createdAt: now, expiresAt });
  send(client.ws, 'token:created', { token, role, expiresAt }, id);

  logAuditEvent('token_create', client.userId, client.nickname, null, null, `Role: ${role}`);
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleTokenDelete(client, data, id) {
  if (!client.permissions.has(PERMISSIONS.TOKEN_DELETE)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'Admin access required.' }, id);
  }
  const { token } = data;
  if (!token) {
    return send(client.ws, 'server:error', { code: 'INVALID_TOKEN', message: 'Token is required.' }, id);
  }
  deleteAdminToken(token);
  send(client.ws, 'token:deleted', { token }, id);

  logAuditEvent('token_delete', client.userId, client.nickname, null, null, null);
}

import { randomUUID } from 'node:crypto';
import state from '../state.js';
import { PERMISSIONS, ALL_PERMISSIONS, PERMISSION_LABELS, PERMISSION_GROUPS } from '../permissions.js';
import {
  getUserRoles,
  getUserPermissions,
  getUserBadge,
  getUserRoleColor,
  assignRole,
  removeRole,
  getRoles,
  createRole,
  updateRole,
  deleteRole,
  getRolePermissions,
  setRolePermissions,
  getRoleMembers,
  getIdentity,
  logAuditEvent,
  getUserHighestRolePosition,
  getRolePosition,
  updateRolePositions,
  getNextRolePosition,
} from '../db/database.js';
import { send, broadcast } from './handler.js';

/**
 * Converts a permission key like "channel.bypass_password" to a human-readable label.
 * @param {string} key
 * @returns {string}
 */
function permKeyToLabel(key) {
  const [namespace, ...parts] = key.split('.');
  const ns = namespace.charAt(0).toUpperCase() + namespace.slice(1);
  const action = parts
    .join(' ')
    .replace(/_/g, ' ')
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  return `${ns}: ${action}`;
}

/**
 * Refreshes permissions and badge for an online user and broadcasts the change.
 * @param {string} userId
 */
function refreshOnlineUserPermissions(userId) {
  for (const c of state.clients.values()) {
    if (c.userId === userId) {
      c.permissions = getUserPermissions(userId);
      c.badge = getUserBadge(userId);
      c.roleColor = getUserRoleColor(userId);
      c.rolePosition = getUserHighestRolePosition(userId);
      broadcast('server:admin-changed', { clientId: c.id, badge: c.badge, roleColor: c.roleColor, rolePosition: c.rolePosition });
      send(c.ws, 'server:permissions-changed', { permissions: [...c.permissions] });
    }
  }
}

/**
 * Ensures a user has at least the default 'user' role.
 * @param {string} userId
 */
function ensureDefaultRole(userId) {
  const remaining = getUserRoles(userId);
  if (remaining.length === 0) {
    assignRole(userId, 'user');
  }
}

/**
 * Returns the actor's best (lowest) role position. Returns Infinity if no identity.
 * @param {object} client
 * @returns {number}
 */
function getActorPosition(client) {
  if (!client.userId) {
    return Infinity;
  }
  return getUserHighestRolePosition(client.userId);
}

/**
 * Returns the target user's best (lowest) role position.
 * @param {string|null} userId
 * @returns {number}
 */
function getTargetPosition(userId) {
  if (!userId) {
    return Infinity;
  }
  return getUserHighestRolePosition(userId);
}

/**
 * Checks whether the actor outranks the target in the role hierarchy.
 * @param {object} actor - The acting client
 * @param {string|null} targetUserId - The target user's ID
 * @returns {boolean}
 */
function actorOutranksTarget(actor, targetUserId) {
  const actorPos = getActorPosition(actor);
  if (actorPos === 0) {
    return true;
  }
  const targetPos = getTargetPosition(targetUserId);
  return actorPos < targetPos;
}

/**
 * Checks whether the actor can assign/manage the given role (role must be below actor's rank).
 * Admins (position 0) can manage any role.
 * @param {object} actor - The acting client
 * @param {string} roleId - The role being assigned
 * @returns {boolean}
 */
function actorCanManageRole(actor, roleId) {
  const actorPos = getActorPosition(actor);
  if (actorPos === 0) {
    return true;
  }
  const rolePos = getRolePosition(roleId);
  return actorPos < rolePos;
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleGetUserRoles(client, data, id) {
  if (!client.permissions.has(PERMISSIONS.USER_ASSIGN_ROLE)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'Admin access required.' }, id);
  }
  const { clientId } = data;
  const target = state.clients.get(clientId);
  if (!target) {
    return send(client.ws, 'server:error', { code: 'CLIENT_NOT_FOUND', message: 'Client not found.' }, id);
  }
  if (!target.userId) {
    return send(client.ws, 'admin:user-roles', { clientId, userId: null, roles: [], allRoles: getRoles() }, id);
  }
  const userRoles = getUserRoles(target.userId);
  const allRoles = getRoles();
  send(client.ws, 'admin:user-roles', { clientId, userId: target.userId, roles: userRoles, allRoles }, id);
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleAssignRole(client, data, id) {
  if (!client.permissions.has(PERMISSIONS.USER_ASSIGN_ROLE)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'Admin access required.' }, id);
  }
  const { clientId, roleId } = data;
  const target = state.clients.get(clientId);
  if (!target) {
    return send(client.ws, 'server:error', { code: 'CLIENT_NOT_FOUND', message: 'Client not found.' }, id);
  }
  if (!target.userId) {
    return send(client.ws, 'server:error', { code: 'NO_IDENTITY', message: 'User has no persistent identity. They must connect with a key to be assigned a role.' }, id);
  }
  if (!actorCanManageRole(client, roleId)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'You cannot assign a role equal to or above your own.' }, id);
  }
  if (target.userId !== client.userId && !actorOutranksTarget(client, target.userId)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'You cannot modify roles for a user with equal or higher rank.' }, id);
  }
  const existing = getUserRoles(target.userId);
  for (const r of existing) {
    removeRole(target.userId, r.id);
  }
  assignRole(target.userId, roleId);
  target.permissions = getUserPermissions(target.userId);
  target.badge = getUserBadge(target.userId);
  target.rolePosition = getUserHighestRolePosition(target.userId);
  broadcast('server:admin-changed', { clientId: target.id, badge: target.badge, rolePosition: target.rolePosition });
  send(target.ws, 'server:permissions-changed', { permissions: [...target.permissions] });
  send(client.ws, 'admin:assign-role-ok', { clientId, roleId }, id);

  logAuditEvent('assign_role', client.userId, client.nickname, target.userId, target.nickname, `Role: ${roleId}`);
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleRemoveRole(client, data, id) {
  if (!client.permissions.has(PERMISSIONS.USER_ASSIGN_ROLE)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'Admin access required.' }, id);
  }
  const { clientId, roleId } = data;
  const target = state.clients.get(clientId);
  if (!target) {
    return send(client.ws, 'server:error', { code: 'CLIENT_NOT_FOUND', message: 'Client not found.' }, id);
  }
  if (!target.userId) {
    return send(client.ws, 'server:error', { code: 'NO_IDENTITY', message: 'User has no persistent identity.' }, id);
  }
  if (target.userId !== client.userId && !actorOutranksTarget(client, target.userId)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'You cannot modify roles for a user with equal or higher rank.' }, id);
  }
  removeRole(target.userId, roleId);
  ensureDefaultRole(target.userId);
  target.permissions = getUserPermissions(target.userId);
  target.badge = getUserBadge(target.userId);
  target.rolePosition = getUserHighestRolePosition(target.userId);
  broadcast('server:admin-changed', { clientId: target.id, badge: target.badge, rolePosition: target.rolePosition });
  send(target.ws, 'server:permissions-changed', { permissions: [...target.permissions] });
  send(client.ws, 'admin:remove-role-ok', { clientId, roleId }, id);

  logAuditEvent('remove_role', client.userId, client.nickname, target.userId, target.nickname, `Role: ${roleId}`);
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleAssignRoleByUserId(client, data, id) {
  if (!client.permissions.has(PERMISSIONS.USER_ASSIGN_ROLE)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'Admin access required.' }, id);
  }
  const { userId, roleId } = data;
  if (!userId || !roleId) {
    return send(client.ws, 'server:error', { code: 'INVALID_REQUEST', message: 'userId and roleId are required.' }, id);
  }

  const identity = getIdentity(userId);
  if (!identity) {
    return send(client.ws, 'server:error', { code: 'USER_NOT_FOUND', message: 'User not found.' }, id);
  }

  if (!actorCanManageRole(client, roleId)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'You cannot assign a role equal to or above your own.' }, id);
  }
  if (userId !== client.userId && !actorOutranksTarget(client, userId)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'You cannot modify roles for a user with equal or higher rank.' }, id);
  }

  const existing = getUserRoles(userId);
  for (const r of existing) {
    removeRole(userId, r.id);
  }
  assignRole(userId, roleId);
  refreshOnlineUserPermissions(userId);

  logAuditEvent('assign_role', client.userId, client.nickname, userId, identity.name, `Role: ${roleId}`);
  send(client.ws, 'admin:assign-role-by-userid-ok', { userId, roleId }, id);
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleRemoveRoleByUserId(client, data, id) {
  if (!client.permissions.has(PERMISSIONS.USER_ASSIGN_ROLE)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'Admin access required.' }, id);
  }
  const { userId, roleId } = data;
  if (!userId || !roleId) {
    return send(client.ws, 'server:error', { code: 'INVALID_REQUEST', message: 'userId and roleId are required.' }, id);
  }

  if (userId !== client.userId && !actorOutranksTarget(client, userId)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'You cannot modify roles for a user with equal or higher rank.' }, id);
  }

  removeRole(userId, roleId);
  ensureDefaultRole(userId);
  refreshOnlineUserPermissions(userId);

  logAuditEvent('remove_role', client.userId, client.nickname, userId, null, `Role: ${roleId}`);
  send(client.ws, 'admin:remove-role-by-userid-ok', { userId, roleId }, id);
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleGetUserRolesByUserId(client, data, id) {
  if (!client.permissions.has(PERMISSIONS.USER_ASSIGN_ROLE)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'Admin access required.' }, id);
  }
  const { userId } = data;
  if (!userId || typeof userId !== 'string') {
    return send(client.ws, 'server:error', { code: 'INVALID_REQUEST', message: 'userId is required.' }, id);
  }
  const userRoles = getUserRoles(userId);
  const allRoles = getRoles();
  send(client.ws, 'admin:user-roles-by-userid', { userId, roles: userRoles, allRoles }, id);
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleRoleList(client, data, id) {
  if (!client.permissions.has(PERMISSIONS.ROLE_MANAGE)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'Admin access required.' }, id);
  }
  const roles = getRoles();
  const rolesWithPerms = roles.map((r) => ({
    id: r.id,
    name: r.name,
    badge: r.badge,
    color: r.color,
    position: r.position,
    permissions: getRolePermissions(r.id),
  }));
  send(client.ws, 'role:list-result', { roles: rolesWithPerms }, id);
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleRoleListPermissions(client, data, id) {
  if (!client.permissions.has(PERMISSIONS.ROLE_MANAGE)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'Admin access required.' }, id);
  }
  const permissions = [...ALL_PERMISSIONS].map((key) => ({
    key,
    label: PERMISSION_LABELS[key] || permKeyToLabel(key),
  }));
  const groups = PERMISSION_GROUPS.map((g) => ({
    id: g.id,
    label: g.label,
    permissions: g.permissions.map((key) => ({
      key,
      label: PERMISSION_LABELS[key] || permKeyToLabel(key),
    })),
  }));
  send(client.ws, 'role:permissions-list', { permissions, groups }, id);
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleRoleCreate(client, data, id) {
  if (!client.permissions.has(PERMISSIONS.ROLE_MANAGE)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'Admin access required.' }, id);
  }
  const { name, badge, color } = data;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return send(client.ws, 'server:error', { code: 'INVALID_NAME', message: 'Role name is required.' }, id);
  }
  const roleId = randomUUID();
  const position = getNextRolePosition();
  try {
    createRole({ id: roleId, name: name.trim(), badge: badge || null, color: color || null, position });
  } catch {
    return send(client.ws, 'server:error', { code: 'DUPLICATE_NAME', message: 'A role with that name already exists.' }, id);
  }
  send(client.ws, 'role:created', { id: roleId, name: name.trim(), badge: badge || null, color: color || null, position, permissions: [] }, id);

  logAuditEvent('role_create', client.userId, client.nickname, null, null, `Role: ${name.trim()}`);
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleRoleUpdate(client, data, id) {
  if (!client.permissions.has(PERMISSIONS.ROLE_MANAGE)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'Admin access required.' }, id);
  }
  const { roleId, name, badge, color } = data;
  if (!roleId) {
    return send(client.ws, 'server:error', { code: 'INVALID_ROLE', message: 'roleId is required.' }, id);
  }
  const isStatic = roleId === 'admin' || roleId === 'user';
  if (isStatic && name !== undefined) {
    return send(client.ws, 'server:error', { code: 'INVALID_ROLE', message: 'Cannot rename a built-in role.' }, id);
  }
  if (!actorCanManageRole(client, roleId)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'You cannot modify a role equal to or above your own.' }, id);
  }
  try {
    updateRole(roleId, isStatic ? { badge, color } : { name, badge, color });
  } catch (err) {
    return send(client.ws, 'server:error', { code: 'UPDATE_FAILED', message: err.message }, id);
  }
  send(client.ws, 'role:updated', { roleId, name, badge, color }, id);

  const affectedUserIds = getRoleMembers(roleId).map((m) => m.user_id);

  for (const c of state.clients.values()) {
    if (!c.userId) {
      continue;
    }
    const userRoles = getUserRoles(c.userId);
    if (userRoles.some((r) => r.id === roleId)) {
      c.badge = getUserBadge(c.userId);
      c.roleColor = getUserRoleColor(c.userId);
      broadcast('server:admin-changed', { clientId: c.id, badge: c.badge, roleColor: c.roleColor });
    }
  }

  if (color !== undefined) {
    broadcast('role:color-changed', { roleColor: color || null, userIds: affectedUserIds });
  }
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleRoleDelete(client, data, id) {
  if (!client.permissions.has(PERMISSIONS.ROLE_MANAGE)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'Admin access required.' }, id);
  }
  const { roleId } = data;
  if (!roleId || roleId === 'admin' || roleId === 'user') {
    return send(client.ws, 'server:error', { code: 'INVALID_ROLE', message: 'Cannot delete a built-in role.' }, id);
  }
  if (!actorCanManageRole(client, roleId)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'You cannot delete a role equal to or above your own.' }, id);
  }
  const affected = [];
  for (const c of state.clients.values()) {
    if (!c.userId) {
      continue;
    }
    if (getUserRoles(c.userId).some((r) => r.id === roleId)) {
      affected.push(c);
    }
  }
  deleteRole(roleId);
  for (const c of affected) {
    ensureDefaultRole(c.userId);
    c.permissions = getUserPermissions(c.userId);
    c.badge = getUserBadge(c.userId);
    c.rolePosition = getUserHighestRolePosition(c.userId);
    broadcast('server:admin-changed', { clientId: c.id, badge: c.badge, rolePosition: c.rolePosition });
    send(c.ws, 'server:permissions-changed', { permissions: [...c.permissions] });
  }
  send(client.ws, 'role:deleted', { roleId }, id);

  logAuditEvent('role_delete', client.userId, client.nickname, null, null, `Role ID: ${roleId}`);
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleRoleSetPermissions(client, data, id) {
  if (!client.permissions.has(PERMISSIONS.ROLE_MANAGE)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'Admin access required.' }, id);
  }
  const { roleId, permissions } = data;
  if (!roleId) {
    return send(client.ws, 'server:error', { code: 'INVALID_ROLE', message: 'roleId is required.' }, id);
  }
  if (roleId === 'admin') {
    return send(client.ws, 'server:error', { code: 'INVALID_ROLE', message: 'Cannot modify permissions for the admin role.' }, id);
  }
  if (!actorCanManageRole(client, roleId)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'You cannot modify permissions for a role equal to or above your own.' }, id);
  }
  if (!Array.isArray(permissions)) {
    return send(client.ws, 'server:error', { code: 'INVALID_PERMISSIONS', message: 'permissions must be an array.' }, id);
  }
  setRolePermissions(roleId, permissions);
  for (const c of state.clients.values()) {
    if (!c.userId) {
      continue;
    }
    const userRoles = getUserRoles(c.userId);
    if (userRoles.some((r) => r.id === roleId)) {
      c.permissions = getUserPermissions(c.userId);
      c.badge = getUserBadge(c.userId);
      broadcast('server:admin-changed', { clientId: c.id, badge: c.badge });
      send(c.ws, 'server:permissions-changed', { permissions: [...c.permissions] });
    }
  }
  send(client.ws, 'role:permissions-set', { roleId, permissions }, id);
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleRoleGetMembers(client, data, id) {
  if (!client.permissions.has(PERMISSIONS.ROLE_MANAGE)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'Admin access required.' }, id);
  }
  const { roleId } = data;
  if (!roleId) {
    return send(client.ws, 'server:error', { code: 'INVALID_ROLE', message: 'roleId is required.' }, id);
  }
  const members = getRoleMembers(roleId);
  send(client.ws, 'role:members', { roleId, members }, id);
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleRoleRemoveMember(client, data, id) {
  if (!client.permissions.has(PERMISSIONS.ROLE_MANAGE)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'Admin access required.' }, id);
  }
  const { userId, roleId } = data;
  if (!userId || !roleId) {
    return send(client.ws, 'server:error', { code: 'INVALID_DATA', message: 'userId and roleId are required.' }, id);
  }
  if (userId !== client.userId && !actorOutranksTarget(client, userId)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'You cannot modify roles for a user with equal or higher rank.' }, id);
  }
  removeRole(userId, roleId);
  ensureDefaultRole(userId);
  refreshOnlineUserPermissions(userId);
  send(client.ws, 'role:member-removed', { userId, roleId }, id);
}

/**
 * @param {object} client
 * @param {object} data
 * @param {string} [id]
 */
export function handleRoleReorder(client, data, id) {
  if (!client.permissions.has(PERMISSIONS.ROLE_MANAGE)) {
    return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'Admin access required.' }, id);
  }
  const { order } = data;
  if (!Array.isArray(order) || order.length === 0) {
    return send(client.ws, 'server:error', { code: 'INVALID_DATA', message: 'order must be a non-empty array of role IDs.' }, id);
  }
  if (order[0] !== 'admin') {
    return send(client.ws, 'server:error', { code: 'INVALID_DATA', message: 'Admin role must remain at position 0.' }, id);
  }
  const actorPos = getActorPosition(client);
  for (let i = 0; i < order.length; i++) {
    const originalPos = getRolePosition(order[i]);
    if (originalPos < actorPos && i !== originalPos) {
      return send(client.ws, 'server:error', { code: 'FORBIDDEN', message: 'You cannot reorder roles above your own rank.' }, id);
    }
  }
  const entries = order.map((roleId, i) => ({ id: roleId, position: i }));
  updateRolePositions(entries);
  send(client.ws, 'role:reorder-ok', { order }, id);
  logAuditEvent('role_reorder', client.userId, client.nickname, null, null, `New order: ${order.join(', ')}`);
}

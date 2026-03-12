/**
 * All available permission keys mapped to their string identifiers.
 * @type {Record<string, string>}
 */
export const PERMISSIONS = {
  CHANNEL_CREATE:            'channel.create',
  CHANNEL_GROUP_CREATE:      'channel.group_create',
  CHANNEL_DELETE:            'channel.delete',
  CHANNEL_UPDATE:            'channel.update',
  CHANNEL_BYPASS_PASSWORD:   'channel.bypass_password',
  CHANNEL_BYPASS_MODERATION: 'channel.bypass_moderation',
  CHANNEL_BYPASS_ROLE_RESTRICTION: 'channel.bypass_role_restriction',
  CHANNEL_BYPASS_WRITE_RESTRICTION: 'channel.bypass_write_restriction',
  CHANNEL_BYPASS_READ_RESTRICTION:  'channel.bypass_read_restriction',
  CHANNEL_BYPASS_VISIBILITY_RESTRICTION: 'channel.bypass_visibility_restriction',
  CHANNEL_BYPASS_USER_LIMIT: 'channel.bypass_user_limit',
  USER_KICK:                 'user.kick',
  USER_BAN:                  'user.ban',
  USER_MOVE:                 'user.move',
  BAN_LIST:                  'ban.list',
  BAN_REMOVE:                'ban.remove',
  VOICE_GRANT:               'voice.grant',
  VOICE_REVOKE:              'voice.revoke',
  TOKEN_CREATE:              'token.create',
  TOKEN_LIST:                'token.list',
  TOKEN_DELETE:              'token.delete',
  CHAT_DELETE_ANY:           'chat.delete_any',
  CHAT_EDIT_ANY:             'chat.edit_any',
  CHAT_SERVER_DELETE:        'chat.server_delete',
  CHAT_SERVER:               'chat.server',
  CHAT_SLASH_CLEAR:          'chat.slash.clear',
  CHAT_SLASH_PURGE:          'chat.slash.purge',
  CHAT_PIN:                  'chat.pin',
  ROLE_MANAGE:               'role.manage',
  USER_ASSIGN_ROLE:          'user.assign_role',
  SERVER_ADMIN_MENU:         'server.admin_menu',
  SERVER_MANAGE_SETTINGS:    'server.manage_settings',
  USER_POKE:                 'user.poke',
  USER_VIEW_IP:              'user.view_ip',
  CHANNEL_CREATE_TEMPORARY:  'channel.create_temporary',
  FILE_BROWSE:               'file.browse',
  FILE_DELETE:               'file.delete',
};

/**
 * Set of all permission string values.
 * @type {Set<string>}
 */
export const ALL_PERMISSIONS = new Set(Object.values(PERMISSIONS));

/**
 * Permission groups for organized display in the UI.
 * Each group has an id, label, and ordered list of permission strings.
 * @type {Array<{id: string, label: string, permissions: string[]}>}
 */
export const PERMISSION_GROUPS = [
  {
    id: 'channel',
    label: 'Channel Management',
    permissions: [
      'channel.create',
      'channel.group_create',
      'channel.create_temporary',
      'channel.update',
      'channel.delete',
    ],
  },
  {
    id: 'channel_bypass',
    label: 'Channel Bypass',
    permissions: [
      'channel.bypass_password',
      'channel.bypass_moderation',
      'channel.bypass_role_restriction',
      'channel.bypass_write_restriction',
      'channel.bypass_read_restriction',
      'channel.bypass_visibility_restriction',
      'channel.bypass_user_limit',
    ],
  },
  {
    id: 'chat',
    label: 'Chat',
    permissions: [
      'chat.server',
      'chat.delete_any',
      'chat.edit_any',
      'chat.server_delete',
      'chat.slash.clear',
      'chat.slash.purge',
      'chat.pin',
    ],
  },
  {
    id: 'voice',
    label: 'Voice',
    permissions: [
      'voice.grant',
      'voice.revoke',
    ],
  },
  {
    id: 'user',
    label: 'User Management',
    permissions: [
      'user.kick',
      'user.ban',
      'user.move',
      'user.poke',
      'user.view_ip',
      'user.assign_role',
    ],
  },
  {
    id: 'ban',
    label: 'Ban Management',
    permissions: [
      'ban.list',
      'ban.remove',
    ],
  },
  {
    id: 'token',
    label: 'Token Management',
    permissions: [
      'token.create',
      'token.list',
      'token.delete',
    ],
  },
  {
    id: 'file',
    label: 'File Management',
    permissions: [
      'file.browse',
      'file.delete',
    ],
  },
  {
    id: 'role',
    label: 'Roles & Administration',
    permissions: [
      'role.manage',
      'server.admin_menu',
      'server.manage_settings',
    ],
  },
];

/**
 * Human-readable labels for permissions.
 * Permissions not listed here get an auto-generated label from their key.
 * @type {Record<string, string>}
 */
export const PERMISSION_LABELS = {
  'channel.create':                  'Create Channels',
  'channel.group_create':            'Create Channel Groups',
  'channel.delete':                  'Delete Channels',
  'channel.update':                  'Update Channels',
  'channel.bypass_password':         'Bypass Channel Password',
  'channel.bypass_moderation':       'Bypass Channel Moderation',
  'channel.bypass_role_restriction': 'Bypass Channel Role Restriction',
  'channel.bypass_write_restriction': 'Bypass Channel Write Restriction',
  'channel.bypass_read_restriction':  'Bypass Channel Read Restriction',
  'channel.bypass_visibility_restriction': 'Bypass Channel Visibility Restriction',
  'channel.bypass_user_limit':       'Bypass Channel User Limit',
  'user.kick':                       'Kick Users',
  'user.ban':                        'Ban Users',
  'user.move':                       'Move Users',
  'ban.list':                        'View Ban List',
  'ban.remove':                      'Remove Bans',
  'voice.grant':                     'Grant Voice',
  'voice.revoke':                    'Revoke Voice',
  'token.create':                    'Create Tokens',
  'token.list':                      'List Tokens',
  'token.delete':                    'Delete Tokens',
  'chat.delete_any':                 'Delete Any Channel Message',
  'chat.edit_any':                   'Edit Any Channel Message',
  'chat.server':                     'Write in Server Chat',
  'chat.server_delete':              'Delete Any Server Message',
  'chat.slash.clear':                'Clear Channel Chat',
  'chat.slash.purge':                'Purge All Messages from a User',
  'chat.pin':                        'Pin/Unpin Messages',
  'role.manage':                     'Manage Roles',
  'user.assign_role':                'Assign Roles to Users',
  'server.admin_menu':               'Show Server Admin Menu',
  'server.manage_settings':          'Manage Server Settings',
  'user.poke':                       'Poke Users',
  'user.view_ip':                    'View User IP Addresses',
  'channel.create_temporary':        'Create Temporary Channels',
  'file.browse':                     'Browse Channel Files',
  'file.delete':                     'Delete Any File',
};

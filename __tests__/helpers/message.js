// __tests__/helpers/message.js
// Duck-typed stand-ins for discord.js Message and GuildMember.
//
// The detector deliberately reads only plain fields, so these literals are
// enough to exercise it without a Discord client.

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {object} options
 * @param {number} options.accountDays  Account age in days.
 * @param {number|null} options.tenureDays  Days in the server; null = unknown.
 * @param {string[]} options.roleIds
 * @param {boolean} options.canManageMessages
 */
function createMember({
  id = 'u1',
  accountDays = 100,
  tenureDays = 100,
  roleIds = [],
  canManageMessages = false,
  highestRolePosition = 1,
  moderatable = true,
  tag = 'Spammer#0001'
} = {}) {
  const now = Date.now();

  return {
    id,
    user: { id, tag, createdTimestamp: now - accountDays * DAY_MS },
    joinedTimestamp: tenureDays === null ? null : now - tenureDays * DAY_MS,
    moderatable,
    roles: {
      cache: { has: roleId => roleIds.includes(roleId) },
      highest: {
        position: highestRolePosition,
        comparePositionTo: other => highestRolePosition - other.position
      }
    },
    permissions: {
      // Accepts a PermissionFlagsBits bigint; only ManageMessages matters here.
      has: () => canManageMessages
    },
    ban: jest.fn(async () => {}),
    timeout: jest.fn(async () => {})
  };
}

function createMessage({
  content = 'hello',
  guildId = 'g1',
  channelId = 'c1',
  userId = 'u1',
  member = undefined,
  mentionedUsers = 0,
  mentionedRoles = 0,
  isBot = false,
  ownerId = 'owner1',
  botCanAct = true,
  botRolePosition = 10
} = {}) {
  const resolvedMember = member === undefined ? createMember({ id: userId }) : member;

  return {
    content,
    author: { id: userId, bot: isBot, tag: 'Spammer#0001' },
    member: resolvedMember,
    channel: { id: channelId, isTextBased: () => true, send: jest.fn(async () => {}) },
    channelId,
    mentions: {
      users: { size: mentionedUsers },
      roles: { size: mentionedRoles }
    },
    guild: {
      id: guildId,
      ownerId,
      members: {
        me: {
          permissions: { has: () => botCanAct },
          roles: {
            highest: {
              position: botRolePosition,
              comparePositionTo: other => botRolePosition - other.position
            }
          }
        }
      }
    },
    client: { channels: { fetch: jest.fn(async () => ({ isTextBased: () => true, send: jest.fn(async () => {}) })) } },
    delete: jest.fn(async () => {})
  };
}

module.exports = { DAY_MS, createMember, createMessage };

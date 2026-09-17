// utils/channelLock.js
// Making a channel readable by everyone and writable only by the bot.
//
// Used by three channels the bot owns outright: the help post, the ticket
// lobby, and the audit log. The first two are notice boards — everyone reads
// them, only the bot writes. The third is hidden from the server entirely and
// readable only by roles that can manage it. Shared rather than duplicated
// because getting Discord's permission resolution right here is fiddly — see
// the note on role overwrites below.
//
// ONE THING THIS CANNOT DO: a member with the Administrator permission bypasses
// every channel overwrite Discord has. No bot can prevent that, and callers are
// expected to say so rather than promise a lock that does not hold.

const { PermissionFlagsBits } = require('discord.js');

/**
 * What @everyone loses. These are the permissions that let somebody put
 * content into a channel or alter what is already there.
 *
 * `UseApplicationCommands` is included deliberately: a slash command run in the
 * channel posts its reply there, which would bury the very message the lock
 * exists to keep visible.
 */
const DENIED = [
  'SendMessages',
  'SendMessagesInThreads',
  'CreatePublicThreads',
  'CreatePrivateThreads',
  'AddReactions',
  'AttachFiles',
  'EmbedLinks',
  'ManageMessages',
  'UseApplicationCommands'
];

/** What everyone keeps on a public locked channel: seeing and reading it. */
const ALLOWED = ['ViewChannel', 'ReadMessageHistory'];

/**
 * Who a locked channel is visible to.
 *
 *   everyone  a notice board: anyone can read it, only the bot can write
 *   admins    a log: hidden from the server, readable by roles that can manage it
 */
const VISIBILITY = ['everyone', 'admins'];

/**
 * Roles that should keep sight of an admin-only channel.
 *
 * Administrator alone is not enough to rely on: a role with Manage Server but
 * not Administrator is exactly the sort of moderator role that needs to read
 * the log, and it does NOT bypass a ViewChannel denial the way Administrator
 * does. Both are granted explicitly.
 */
function adminRoles(guild) {
  const everyoneId = guild.roles.everyone.id;

  return [...guild.roles.cache.values()].filter(
    role =>
      role.id !== everyoneId &&
      (role.permissions?.has?.(PermissionFlagsBits.Administrator) ||
        role.permissions?.has?.(PermissionFlagsBits.ManageGuild))
  );
}

/** What the bot needs to own the channel. */
const BOT_ALLOWED = [
  'ViewChannel',
  'ReadMessageHistory',
  'SendMessages',
  'EmbedLinks',
  'AttachFiles',
  'AddReactions',
  'ManageMessages'
];

function toOverwrite(names, value) {
  return Object.fromEntries(names.map(name => [name, value]));
}

/** Editing overwrites needs Manage Roles in the channel, not Manage Channels. */
function canLock(channel) {
  const me = channel?.guild?.members?.me;
  if (!me) return { ok: false, reason: 'the bot is not cached in this guild' };

  const permissions = me.permissionsIn?.(channel);

  if (!permissions?.has?.(PermissionFlagsBits.ManageRoles)) {
    return { ok: false, reason: 'the bot lacks the Manage Permissions permission in that channel' };
  }

  return { ok: true };
}

/**
 * Roles with their own channel overwrite that grants posting.
 *
 * This is the part that is easy to get wrong. Denying `SendMessages` on
 * @everyone beats a role's SERVER-level permissions, but it does NOT beat a
 * role-specific overwrite on the same channel — those are applied afterwards
 * and win. A channel where @everyone is denied but "Members" is explicitly
 * allowed is still wide open, so those overwrites have to be cleared too.
 */
function postingRoleOverwrites(channel, { botId, everyoneId }) {
  const overwrites = [...(channel.permissionOverwrites?.cache?.values?.() ?? [])];

  return overwrites.filter(overwrite => {
    if (overwrite.id === everyoneId || overwrite.id === botId) return false;

    // `allow` is a bitfield; only overwrites that positively grant posting
    // need changing. A role that is already denied is fine as it is.
    return Boolean(overwrite.allow?.has?.(PermissionFlagsBits.SendMessages));
  });
}

/**
 * Locks a channel to bot-only posting.
 *
 * @param {object} channel
 * @param {string} options.botId
 * @param {string} [options.reason]  Audit-log reason.
 * @returns {Promise<{ok: boolean, reason?: string, clearedRoles: string[], warnings: string[]}>}
 */
async function lockChannel(
  channel,
  { botId, reason = 'Locked to bot-only posting', visibility = 'everyone' } = {}
) {
  const check = canLock(channel);
  if (!check.ok) return { ok: false, reason: check.reason, clearedRoles: [], warnings: [] };

  const everyoneId = channel.guild.roles.everyone.id;
  const hidden = visibility === 'admins';
  const warnings = [];
  const clearedRoles = [];
  const grantedRoles = [];

  try {
    await channel.permissionOverwrites.edit(
      everyoneId,
      hidden
        // Hidden: take away sight of the channel as well as the ability to
        // write in it.
        ? { ...toOverwrite(ALLOWED, false), ...toOverwrite(DENIED, false) }
        : { ...toOverwrite(ALLOWED, true), ...toOverwrite(DENIED, false) },
      { reason }
    );
  } catch (err) {
    return { ok: false, reason: err.message, clearedRoles: [], warnings: [] };
  }

  if (hidden) {
    for (const role of adminRoles(channel.guild)) {
      try {
        await channel.permissionOverwrites.edit(
          role.id,
          { ...toOverwrite(ALLOWED, true), ...toOverwrite(DENIED, false) },
          { reason }
        );
        grantedRoles.push(role.id);
      } catch (err) {
        warnings.push(`<@&${role.id}> could not be given access (${err.message})`);
      }
    }

    if (grantedRoles.length === 0) {
      warnings.push(
        'no role has Manage Server, so only members with Administrator can see the channel'
      );
    }
  }

  // The bot has to keep the permissions it just took away from everybody.
  try {
    await channel.permissionOverwrites.edit(botId, toOverwrite(BOT_ALLOWED, true), { reason });
  } catch (err) {
    warnings.push(`the bot's own overwrite could not be set (${err.message})`);
  }

  for (const overwrite of postingRoleOverwrites(channel, { botId, everyoneId })) {
    try {
      await channel.permissionOverwrites.edit(overwrite.id, { SendMessages: false }, { reason });
      clearedRoles.push(overwrite.id);
    } catch (err) {
      warnings.push(`<@&${overwrite.id}> could still post (${err.message})`);
    }
  }

  return { ok: true, clearedRoles, grantedRoles, hidden, warnings };
}

/**
 * Hands the channel back to the server: the denials are removed rather than
 * flipped to "allow", so the channel returns to inheriting from its category
 * and roles instead of becoming a free-for-all.
 */
async function unlockChannel(channel, { reason = 'Unlocked' } = {}) {
  const check = canLock(channel);
  if (!check.ok) return { ok: false, reason: check.reason };

  try {
    // Both lists are cleared, not just the denials: a hidden channel also has
    // ViewChannel denied, and leaving that behind would unlock a channel
    // nobody could see.
    await channel.permissionOverwrites.edit(
      channel.guild.roles.everyone.id,
      { ...toOverwrite(DENIED, null), ...toOverwrite(ALLOWED, null) },
      { reason }
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/** Whether a channel currently reads as locked, for status output. */
function isLocked(channel) {
  const everyoneId = channel?.guild?.roles?.everyone?.id;
  const overwrite = channel?.permissionOverwrites?.cache?.get?.(everyoneId);

  return Boolean(overwrite?.deny?.has?.(PermissionFlagsBits.SendMessages));
}

module.exports = {
  ALLOWED,
  BOT_ALLOWED,
  DENIED,
  VISIBILITY,
  adminRoles,
  canLock,
  isLocked,
  lockChannel,
  postingRoleOverwrites,
  unlockChannel
};

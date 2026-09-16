// utils/spam/enforcement.js
// Carries out a decision: delete the message, then ban or time the member out.
//
// Every action is preflighted. The module this is modelled on calls ban() and
// lets failures land in a catch block, which produces a bot that looks like it
// is moderating but silently is not. Here a refusal is a first-class outcome
// that still raises an alert.

const { PermissionFlagsBits } = require('discord.js');

// On a ban, clear the rest of the wave rather than just the message that tripped
// the check.
const BAN_DELETE_SECONDS = 3600;

// What each action needs, and what to call it when the bot has not got it.
const REQUIRED_PERMISSION = {
  ban: { flag: PermissionFlagsBits.BanMembers, label: 'Ban Members' },
  kick: { flag: PermissionFlagsBits.KickMembers, label: 'Kick Members' },
  timeout: { flag: PermissionFlagsBits.ModerateMembers, label: 'Moderate Members' }
};

/**
 * Confirms the bot can actually act on this member.
 *
 * Shared by spam enforcement and the onboarding sweep: the rules about the
 * server owner and role hierarchy are identical whatever the reason for acting,
 * and having one place that knows them is what stops a second caller getting
 * them subtly wrong.
 *
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function preflight({ guild, member, action }) {
  const me = guild?.members?.me;
  if (!me) return { ok: false, reason: 'the bot is not cached in this guild' };

  const needed = REQUIRED_PERMISSION[action] ?? REQUIRED_PERMISSION.timeout;

  if (!me.permissions?.has(needed.flag)) {
    return { ok: false, reason: `the bot lacks the ${needed.label} permission` };
  }

  if (member.id === guild.ownerId) {
    return { ok: false, reason: 'the target is the server owner' };
  }

  // Discord refuses actions against anyone at or above the bot's highest role.
  const botHighest = me.roles?.highest;
  const targetHighest = member.roles?.highest;

  if (botHighest && targetHighest && botHighest.comparePositionTo(targetHighest) <= 0) {
    return { ok: false, reason: 'the target has a role ranked at or above the bot' };
  }

  if (action === 'timeout' && member.moderatable === false) {
    return { ok: false, reason: 'Discord reports the member is not moderatable' };
  }

  return { ok: true };
}

/** Deleting can race with another moderator, so a failure here is not fatal. */
async function deleteMessage(message) {
  try {
    await message.delete();
    return true;
  } catch (err) {
    console.warn(`⚠️  Could not delete spam message: ${err.message}`);
    return false;
  }
}

/**
 * Applies the decision.
 *
 * @returns {Promise<{ acted: boolean, action: string, deleted: boolean, blockedReason: string|null }>}
 */
async function act({ message, member, decision }) {
  const guild = message.guild;
  const deleted = await deleteMessage(message);

  const check = preflight({ guild, member, action: decision.action });

  if (!check.ok) {
    console.warn(`⚠️  Spam action skipped for ${member.id}: ${check.reason}`);
    return { acted: false, action: decision.action, deleted, blockedReason: check.reason };
  }

  try {
    if (decision.action === 'ban') {
      await member.ban({ reason: decision.reason, deleteMessageSeconds: BAN_DELETE_SECONDS });
    } else {
      await member.timeout(decision.durationMs, decision.reason);
    }

    return { acted: true, action: decision.action, deleted, blockedReason: null };
  } catch (err) {
    console.error(`❌ Spam action failed for ${member.id}: ${err.message}`);
    return { acted: false, action: decision.action, deleted, blockedReason: err.message };
  }
}

module.exports = {
  BAN_DELETE_SECONDS,
  REQUIRED_PERMISSION,
  act,
  deleteMessage,
  preflight
};

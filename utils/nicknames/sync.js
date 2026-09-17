// utils/nicknames/sync.js
// Keeping Discord nicknames in step with people's main characters.
//
// The awkward truth about this feature, and the reason every function here
// reports refusals instead of swallowing them:
//
//   - Discord will NOT let any bot rename the server owner. Ever. There is no
//     permission that grants it.
//   - A member whose highest role sits at or above the bot's own cannot be
//     renamed either — the same hierarchy rule that governs kicks.
//
// Between them those cover most officers, which means the people most likely to
// notice and report "it didn't work" are the people it provably cannot work
// for. Saying so plainly is the whole difference between a feature that looks
// broken and one that is understood.

const { PermissionFlagsBits } = require('discord.js');

const { mainFor } = require('../reports/links');

// Discord's cap. Names are trimmed rather than rejected, since a 33-character
// character name is still the right nickname, just shortened.
const MAX_NICKNAME_LENGTH = 32;

/** The nickname a member should have: their main character's name. */
function desiredNickname(character) {
  const name = String(character?.name ?? '').trim();
  return name ? name.slice(0, MAX_NICKNAME_LENGTH) : null;
}

/**
 * Whether the bot can rename this member.
 *
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function canRename(guild, member) {
  const me = guild?.members?.me;
  if (!me) return { ok: false, reason: 'the bot is not cached in this guild' };

  if (!me.permissions?.has?.(PermissionFlagsBits.ManageNicknames)) {
    return { ok: false, reason: 'the bot lacks the Manage Nicknames permission' };
  }

  if (member.id === guild.ownerId) {
    return { ok: false, reason: 'Discord does not allow renaming the server owner' };
  }

  const botHighest = me.roles?.highest;
  const targetHighest = member.roles?.highest;

  if (botHighest && targetHighest && botHighest.comparePositionTo(targetHighest) <= 0) {
    return { ok: false, reason: 'their highest role is at or above the bot' };
  }

  return { ok: true };
}

/**
 * Works out what should happen to one member, without doing it.
 *
 * Shared by the preview and the real thing, so what `/iam manage sync` shows is
 * exactly what it would do.
 *
 * @returns {{action: 'rename'|'skip', from: string|null, to: string|null, reason: string|null}}
 */
function planFor(guild, member, character) {
  const to = desiredNickname(character);

  if (!to) return { action: 'skip', from: member.nickname ?? null, to: null, reason: 'no main set' };

  if (member.nickname === to) {
    return { action: 'skip', from: member.nickname, to, reason: 'already correct' };
  }

  const check = canRename(guild, member);

  if (!check.ok) {
    return { action: 'skip', from: member.nickname ?? null, to, reason: check.reason };
  }

  return { action: 'rename', from: member.nickname ?? null, to, reason: null };
}

/** Applies one plan. Never throws; a refusal becomes a skip with a reason. */
async function applyPlan(member, plan, { reason = 'Nickname synced to main character' } = {}) {
  if (plan.action !== 'rename') return plan;

  try {
    await member.setNickname(plan.to, reason);
    return plan;
  } catch (err) {
    return { ...plan, action: 'skip', reason: err.message };
  }
}

/** Renames one member to their main, if they have one. */
async function syncMember(guild, member) {
  const character = mainFor(member.id);
  if (!character) return null;

  return applyPlan(member, planFor(guild, member, character));
}

/**
 * Plans every linked member in the guild.
 *
 * Only members who have linked something are considered — the bot has no
 * opinion about anybody else's name.
 */
function planGuild(guild, members, { charactersOf = mainFor } = {}) {
  const plans = [];

  for (const member of members) {
    const character = charactersOf(member.id);
    if (!character) continue;

    plans.push({ member, ...planFor(guild, member, character) });
  }

  return plans;
}

/**
 * Renames everyone who needs it.
 *
 * @returns {Promise<{renamed: object[], skipped: object[]}>}
 */
async function syncGuild(guild, members, options = {}) {
  const renamed = [];
  const skipped = [];

  for (const plan of planGuild(guild, members, options)) {
    const outcome = await applyPlan(plan.member, plan);
    (outcome.action === 'rename' ? renamed : skipped).push({ ...outcome, member: plan.member });
  }

  return { renamed, skipped };
}

module.exports = {
  MAX_NICKNAME_LENGTH,
  applyPlan,
  canRename,
  desiredNickname,
  planFor,
  planGuild,
  syncGuild,
  syncMember
};

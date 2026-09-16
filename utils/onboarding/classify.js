// utils/onboarding/classify.js
// Deciding who has not picked a role, and what is owed to them.
//
// Pure: no discord.js, no clock, no I/O. Members arrive as plain objects via
// `describeMember`, which is the only function here that knows what a
// GuildMember looks like. That split is what lets every rule below be tested
// with object literals — the same reason utils/spam/detector.js stays free of
// Discord types.

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Flattens a discord.js GuildMember into what the rules actually need.
 *
 * `roles.cache` always contains @everyone, which nobody chooses, so it is
 * discounted — a member holding only @everyone has picked nothing.
 */
function describeMember(member, guildId = member?.guild?.id) {
  const roles = member?.roles?.cache;
  const roleIds = roles ? [...roles.keys()].filter(id => id !== guildId) : [];

  return {
    id: member?.id ?? null,
    tag: member?.user?.tag ?? member?.user?.username ?? member?.id ?? 'unknown',
    joinedTimestamp: Number.isFinite(member?.joinedTimestamp) ? member.joinedTimestamp : null,
    roleCount: roleIds.length,
    isBot: Boolean(member?.user?.bot)
  };
}

function daysSince(timestamp, now) {
  return (now - timestamp) / DAY_MS;
}

/**
 * Why a member is not a candidate, or null if they are one.
 *
 * Order matters only for the wording of a preview; every branch is a hard
 * exclusion. The `joinedTimestamp` check is the important one: a member whose
 * join date is unknown is left alone rather than treated as ancient, because
 * missing data must never be grounds for removing somebody.
 */
function exemptionFor(member, config) {
  if (member.isBot) return 'a bot';
  if (member.roleCount > 0) return 'has a role';
  if (member.joinedTimestamp === null) return 'join date unknown';

  if (config.enabledAt !== null && member.joinedTimestamp < config.enabledAt) {
    return 'joined before the sweep was switched on';
  }

  return null;
}

/**
 * Sorts members into what should happen to each.
 *
 * @param {object[]} members   From describeMember.
 * @param {object}   config    From onboarding config.
 * @param {number}   now       Milliseconds.
 * @param {Function} isWarned  Has this member already had the reminder DM?
 *
 * @returns {{kick: object[], warn: object[], waiting: object[], exempt: object[]}}
 */
function classifyMembers(members, config, { now = Date.now(), isWarned = () => false } = {}) {
  const kick = [];
  const warn = [];
  const waiting = [];
  const exempt = [];

  for (const member of members) {
    const exemption = exemptionFor(member, config);

    if (exemption) {
      exempt.push({ ...member, reason: exemption });
      continue;
    }

    const age = daysSince(member.joinedTimestamp, now);
    const entry = { ...member, daysInServer: age };

    if (age >= config.graceDays) {
      kick.push(entry);
      continue;
    }

    if (age >= config.warnAfterDays && !isWarned(member.id)) {
      warn.push(entry);
      continue;
    }

    waiting.push(entry);
  }

  // Longest-waiting first, so a capped sweep removes the most overdue and a
  // preview reads as a countdown.
  const byAge = (a, b) => b.daysInServer - a.daysInServer;

  return {
    kick: kick.sort(byAge),
    warn: warn.sort(byAge),
    waiting: waiting.sort(byAge),
    exempt
  };
}

/** Whole days left before a member is due to be kicked, never below zero. */
function daysRemaining(member, config, now = Date.now()) {
  if (member.joinedTimestamp === null) return null;
  return Math.max(Math.ceil(config.graceDays - daysSince(member.joinedTimestamp, now)), 0);
}

module.exports = {
  DAY_MS,
  classifyMembers,
  daysRemaining,
  daysSince,
  describeMember,
  exemptionFor
};

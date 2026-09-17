// utils/onboarding/sweep.js
// The periodic pass that reminds, then removes, members who never picked a role.
//
// Three rules shape everything here:
//
//   1. Never act on missing data. An uncached member, an unknown join date, a
//      failed fetch — every one of those means "do nothing", never "kick".
//   2. Always preflight. `enforcement.preflight` knows about the server owner,
//      role hierarchy and missing permissions; a blocked kick is reported, not
//      swallowed.
//   3. The DM goes out BEFORE the kick. Discord will not deliver a direct
//      message to someone you no longer share a server with, so reversing the
//      order silently drops every explanation.

const { loadConfig, saveConfig, MAX_KICKS_PER_SWEEP } = require('./config');
const { classifyMembers, describeMember } = require('./classify');
const { recordSweep, wasWarned } = require('./state');
const { buildSweepEmbed, kickMessage, sendAlert, warningMessage } = require('./alert');
const { preflight } = require('../spam/enforcement');
const { isGuildInScope } = require('../guildScope');
const { record } = require('../audit/log');
const { readConfig } = require('../../config');

// Ten minutes. The deadline is measured in days, so this only decides how
// promptly somebody is removed after it passes — and a tighter loop would mean
// fetching the full member list far more often than the feature needs.
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

const KICK_REASON = 'No roles selected within the onboarding grace period.';

/**
 * Every member of the guild, described.
 *
 * `guild.members.fetch()` needs the GuildMembers privileged intent, which this
 * bot already has for spam trust tiers. A failure returns null rather than an
 * empty list: an empty list would look like "nobody has roles" to the caller,
 * and that is the one misreading that could empty a server.
 */
async function fetchMembers(guild) {
  try {
    const members = await guild.members.fetch();
    return [...members.values()].map(member => describeMember(member, guild.id));
  } catch (err) {
    console.error(`❌ Could not fetch members for guild ${guild.id}: ${err.message}`);
    return null;
  }
}

/** Sends a DM, treating closed DMs as an ordinary outcome rather than an error. */
async function sendDirectMessage(guild, userId, content) {
  try {
    const member = await guild.members.fetch(userId);
    await member.send(content);
    return true;
  } catch {
    // Closed DMs, a blocked bot, or a member who left between classification
    // and delivery. None of these should stop the sweep.
    return false;
  }
}

/** Reminds one member, returning whether the DM landed. */
async function warnMember(guild, member, config) {
  const daysLeft = Math.max(Math.ceil(config.graceDays - member.daysInServer), 1);

  const dmDelivered = await sendDirectMessage(
    guild,
    member.id,
    warningMessage({
      guildName: guild.name,
      daysLeft,
      roleChannelId: config.roleChannelId
    })
  );

  return { ...member, dmDelivered };
}

/**
 * Removes one member.
 *
 * @returns {{kicked: object|null, blocked: object|null}}
 */
async function kickMember(guild, member, config) {
  let live;
  try {
    live = await guild.members.fetch(member.id);
  } catch {
    // Already gone. Not a failure, and nothing to report.
    return { kicked: null, blocked: null };
  }

  // Re-check against the live member rather than the snapshot taken at
  // classification: somebody who picked a role thirty seconds ago must not be
  // removed for not having one.
  const current = describeMember(live, guild.id);
  if (current.roleCount > 0) return { kicked: null, blocked: null };

  const check = preflight({ guild, member: live, action: 'kick' });

  if (!check.ok) {
    return { kicked: null, blocked: { ...member, reason: check.reason } };
  }

  // Before the kick — afterwards there is no shared server and the DM bounces.
  const dmDelivered = await sendDirectMessage(
    guild,
    member.id,
    kickMessage({ guildName: guild.name, graceDays: config.graceDays })
  );

  try {
    await live.kick(KICK_REASON);
    return { kicked: { ...member, dmDelivered }, blocked: null };
  } catch (err) {
    return { kicked: null, blocked: { ...member, reason: err.message } };
  }
}

/**
 * Classifies the guild without touching anybody. Shared by the preview command
 * and the sweep, so what the preview shows is what the sweep would do.
 */
async function inspectGuild(guild, { config = loadConfig(), now = Date.now() } = {}) {
  const members = await fetchMembers(guild);

  if (members === null) return null;

  return {
    ...classifyMembers(members, config, { now, isWarned: wasWarned }),
    memberCount: members.length
  };
}

/**
 * One pass over a guild.
 *
 * @param {object}  guild
 * @param {boolean} options.dryRun  Classify and report, but touch nobody.
 */
async function sweepGuild(guild, { config = loadConfig(), now = Date.now(), dryRun = false } = {}) {
  const classified = await inspectGuild(guild, { config, now });

  // A failed fetch means no information, which means no action.
  if (classified === null) return null;

  const { kick, warn } = classified;
  const capped = kick.length > MAX_KICKS_PER_SWEEP;
  const due = kick.slice(0, MAX_KICKS_PER_SWEEP);

  if (dryRun) {
    return {
      kicked: due,
      warned: warn,
      blocked: [],
      capped,
      classified,
      dryRun: true
    };
  }

  const warned = [];
  for (const member of warn) {
    warned.push(await warnMember(guild, member, config));
  }

  const kicked = [];
  const blocked = [];
  for (const member of due) {
    const outcome = await kickMember(guild, member, config);
    if (outcome.kicked) kicked.push(outcome.kicked);
    if (outcome.blocked) blocked.push(outcome.blocked);
  }

  // Remember who was reminded, and forget everyone no longer in the running —
  // members who picked a role, left, or were just removed.
  recordSweep({
    warnedIds: warned.map(member => member.id),
    keepIds: [...classified.waiting, ...classified.kick]
      .map(member => member.id)
      .filter(id => !kicked.some(member => member.id === id)),
    now
  });

  return { kicked, warned, blocked, capped, classified, dryRun: false };
}

/** Sweeps every guild this instance is responsible for. */
async function runSweep(client, { now = Date.now(), config = loadConfig(), dryRun = false } = {}) {
  const guildId = readConfig().discord.guildId;
  const results = [];

  for (const guild of client.guilds.cache.values()) {
    // Same pin as everywhere else: two instances sharing a token must not both
    // remove the same people.
    if (!isGuildInScope(guild.id, guildId)) continue;

    const result = await sweepGuild(guild, { config, now, dryRun });
    if (!result) continue;

    results.push({ guild, ...result });

    if (result.kicked.length + result.warned.length + result.blocked.length > 0) {
      await sendAlert({
        client,
        channelId: config.alertChannelId,
        embed: buildSweepEmbed({ ...result, config, dryRun })
      });

      record(client, {
        kind: 'kick',
        action: dryRun ? 'dry-ran the onboarding sweep' : 'ran the onboarding sweep',
        detail:
          `${result.kicked.length} removed, ${result.warned.length} reminded` +
          (result.blocked.length > 0 ? `, ${result.blocked.length} blocked` : ''),
        automatic: true,
        ok: result.blocked.length === 0
      });
    }
  }

  if (!dryRun) saveConfig({ lastSweepAt: now });

  return results;
}

/**
 * Starts the periodic sweep. Returns a stop function; the interval is unref'd so
 * it never holds the process open at shutdown.
 */
function startOnboardingSweeper(client, { intervalMs = SWEEP_INTERVAL_MS, now = () => Date.now() } = {}) {
  let running = false;

  const tick = async () => {
    // Fetching a large member list and kicking can outlast the interval;
    // overlapping passes could double-DM or race on the warned file.
    if (running) return;

    const config = loadConfig();
    if (!config.enabled) return;

    running = true;
    try {
      const results = await runSweep(client, { now: now(), config });
      const kicked = results.reduce((sum, result) => sum + result.kicked.length, 0);
      const warned = results.reduce((sum, result) => sum + result.warned.length, 0);

      if (kicked + warned > 0) {
        console.log(`🧹 Onboarding sweep: ${kicked} removed, ${warned} reminded.`);
      }
    } catch (err) {
      console.error('❌ The onboarding sweep failed:', err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();

  return () => clearInterval(timer);
}

module.exports = {
  KICK_REASON,
  SWEEP_INTERVAL_MS,
  fetchMembers,
  inspectGuild,
  kickMember,
  runSweep,
  sendDirectMessage,
  startOnboardingSweeper,
  sweepGuild,
  warnMember
};

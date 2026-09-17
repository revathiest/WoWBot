// utils/reports/scheduler.js
// Deciding when a week has elapsed, and posting the report when it has.
//
// Times are UTC throughout. A timezone library would be a dependency this
// project does not take, and guessing the host's local zone is worse than being
// explicit — a box that moves from a US host to a European one would silently
// shift everyone's report. Every surface that shows a schedule says "UTC".
//
// The schedule is a SLOT, not a timer. On each tick the scheduler asks "has the
// most recent slot passed without a post since?", so a bot that was offline at
// 18:00 still reports when it comes back, and a bot that restarts five times an
// hour does not report five times.

const { loadConfig, saveConfig, channelFor, guildKey } = require('./config');
const { collectSnapshot } = require('./collect');
const { diffSnapshots } = require('./diff');
const { loadSnapshot, saveSnapshot } = require('./history');
const { buildOwnerIndex } = require('./links');
const { buildReportEmbed, buildRosterComponents } = require('./render');
const { fetchPresentUserIds } = require('./membership');
const { isGuildInScope } = require('../guildScope');
const { record } = require('../audit/log');
const { readConfig } = require('../../config');

const DAY_MS = 24 * 60 * 60 * 1000;

// Five minutes is far finer than a weekly schedule needs, and keeps the report
// close to the configured hour even after a restart.
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** How long one cycle is, for the current frequency. */
function intervalMsFor(config) {
  return config.frequency === 'weekly' ? 7 * DAY_MS : DAY_MS;
}

/** The most recent occurrence of the configured slot, in UTC. */
function lastSlotAt(config, from = Date.now()) {
  const slot = new Date(from);

  slot.setUTCHours(config.hour, 0, 0, 0);

  if (config.frequency === 'weekly') {
    slot.setUTCDate(slot.getUTCDate() - ((slot.getUTCDay() - config.dayOfWeek + 7) % 7));

    // Stepping back to the weekday can still land later today than `from`.
    if (slot.getTime() > from) slot.setUTCDate(slot.getUTCDate() - 7);

    return slot.getTime();
  }

  // Daily: today's hour, or yesterday's if it has not come round yet.
  if (slot.getTime() > from) slot.setUTCDate(slot.getUTCDate() - 1);

  return slot.getTime();
}

/** When the next report is due. */
function nextSlotAt(config, from = Date.now()) {
  return lastSlotAt(config, from) + intervalMsFor(config);
}

/**
 * Whether a report is owed.
 *
 * A null `lastPostedAt` counts as due, which only happens if the file was
 * hand-edited — `/report configure enabled` stamps it so that switching
 * reporting on waits for the next slot instead of firing immediately.
 */
function isDue(config, now = Date.now()) {
  if (!config.enabled) return false;
  if (config.guilds.length === 0) return false;
  if (!config.guilds.every(guild => channelFor(guild, config))) return false;

  return config.lastPostedAt === null || config.lastPostedAt < lastSlotAt(config, now);
}

/**
 * Builds one guild's report.
 *
 * `persist` is the difference between a preview and the real thing. Saving a
 * snapshot consumes the baseline the next report subtracts from, so `/report
 * now` must leave it alone — otherwise previewing on Sunday would make Monday's
 * report cover one day instead of seven.
 */
async function buildGuildReport(
  guild,
  { persist = false, now = Date.now(), onProgress, presentUserIds = null } = {}
) {
  const key = guildKey(guild);
  const { snapshot, warnings } = await collectSnapshot(guild, { capturedAt: now, onProgress });

  const previous = loadSnapshot(key);
  const diff = diffSnapshots(previous, snapshot);
  const embed = buildReportEmbed({ diff, owners: buildOwnerIndex(), warnings, presentUserIds });

  if (persist) saveSnapshot(key, snapshot);

  return { key, guild, diff, embed, warnings, persisted: persist };
}

/**
 * Builds every tracked guild's report. One guild failing does not cost the
 * others theirs — a bad guild name or a Blizzard hiccup is reported in place.
 */
async function buildAllReports({
  persist = false,
  now = Date.now(),
  config = loadConfig(),
  onProgress,
  presentUserIds = null
} = {}) {
  const reports = [];
  const failures = [];

  for (const guild of config.guilds) {
    try {
      reports.push(await buildGuildReport(guild, { persist, now, onProgress, presentUserIds }));
    } catch (err) {
      failures.push({ guild, error: err });
      console.error(`❌ Weekly report failed for ${guild.name}-${guild.realm}:`, err.message);
    }
  }

  return { reports, failures };
}

/**
 * Wipes the bot's own previous reports from a channel.
 *
 * Deliberately limited to messages the bot posted. "Clear the channel" means
 * "show only the current report", and a report channel is a dedicated one, so
 * in practice that IS everything in it — but scoping it this way means
 * pointing the report at a busy channel by mistake costs nobody their
 * conversation.
 *
 * `bulkDelete` only works on messages under fourteen days old, which covers
 * every report on a daily or weekly schedule; anything older is deleted singly.
 */
async function clearOwnMessages(channel, client) {
  try {
    const recent = await channel.messages.fetch({ limit: 100 });
    const mine = [...recent.values()].filter(message => message.author?.id === client.user?.id);

    if (mine.length === 0) return 0;

    const cutoff = Date.now() - 14 * DAY_MS;
    const fresh = mine.filter(message => message.createdTimestamp > cutoff);
    const stale = mine.filter(message => message.createdTimestamp <= cutoff);

    if (fresh.length > 0) await channel.bulkDelete(fresh, true);
    for (const message of stale) await message.delete().catch(() => null);

    return mine.length;
  } catch (err) {
    // Never let tidying up stop the report itself from going out.
    console.warn(`⚠️  Could not clear ${channel.id} before posting: ${err.message}`);
    return 0;
  }
}

/**
 * Sends the embeds, grouping guilds that share a channel into one message.
 *
 * The scope check matters: posting is not an interaction, so nothing else stops
 * a second instance sharing this token from posting the same report. A pinned
 * instance refuses to post anywhere but its own guild, which is the same
 * protection `GUILD_ID` gives the command handlers.
 */
async function publishReports(client, reports, { config = loadConfig(), guildId = readConfig().discord.guildId } = {}) {
  const byChannel = new Map();

  for (const report of reports) {
    const channelId = channelFor(report.guild, config);
    if (!channelId) continue;

    byChannel.set(channelId, [...(byChannel.get(channelId) ?? []), report]);
  }

  const delivered = [];

  for (const [channelId, entries] of byChannel) {
    try {
      const channel = await client.channels.fetch(channelId);

      if (!channel?.isTextBased?.()) {
        console.warn(`⚠️  Report channel ${channelId} is not a text channel; skipping.`);
        continue;
      }

      if (!isGuildInScope(channel.guildId, guildId)) {
        console.log(
          `↪️  Not posting the report to ${channelId} — this instance is pinned to ${guildId}.`
        );
        continue;
      }

      if (config.clearChannel) await clearOwnMessages(channel, client);

      // Discord accepts up to ten embeds per message, which is above the
      // tracked-guild ceiling, so one message per channel always fits.
      await channel.send({
        embeds: entries.map(entry => entry.embed),
        components: buildRosterComponents(
          entries.map(entry => ({ key: entry.key, name: entry.guild.name }))
        )
      });

      delivered.push(channelId);
    } catch (err) {
      console.error(`❌ Could not post the report to ${channelId}:`, err.message);
    }
  }

  return delivered;
}

/**
 * Members of the Discord server the reports are posted to.
 *
 * Resolved from the report channel rather than assumed, since that is the only
 * thing telling us which server this report belongs to.
 */
async function presentIdsFor(client, config) {
  const channelId = config.channelId ?? config.guilds.map(guild => guild.channelId).find(Boolean);
  if (!channelId) return null;

  try {
    const channel = await client.channels.fetch(channelId);
    return channel?.guild ? await fetchPresentUserIds(channel.guild) : null;
  } catch {
    return null;
  }
}

/**
 * The whole scheduled job: build, post, and record that it happened.
 *
 * `lastPostedAt` is stamped even when nothing could be delivered, so a
 * misconfigured channel produces one failed attempt a week rather than one
 * every five minutes.
 */
async function runScheduledReports(client, { now = Date.now(), config = loadConfig() } = {}) {
  console.log(`📊 Building the ${config.frequency} report for ${config.guilds.length} guild(s)…`);

  // Who is actually in the server, for the on-Discord counts. Read once for
  // the whole run rather than per guild.
  const presentUserIds = await presentIdsFor(client, config);

  const { reports, failures } = await buildAllReports({
    persist: true,
    now,
    config,
    presentUserIds
  });
  const delivered = await publishReports(client, reports, { config });

  saveConfig({ lastPostedAt: now });

  console.log(
    `📊 Report: ${reports.length} built, ${failures.length} failed, posted to ${delivered.length} channel(s).`
  );

  record(client, {
    kind: 'report',
    action: `posted the ${config.frequency} guild report`,
    detail:
      `${reports.length} guild(s) to ${delivered.length} channel(s)` +
      (failures.length > 0 ? `, ${failures.length} failed` : ''),
    automatic: true,
    ok: failures.length === 0
  });

  return { reports, failures, delivered };
}

/**
 * Starts the weekly check. Returns a stop function; the interval is unref'd so
 * it never holds the process open on shutdown.
 */
function startReportScheduler(client, { intervalMs = CHECK_INTERVAL_MS, now = () => Date.now() } = {}) {
  let running = false;

  const tick = async () => {
    // A large report can outlast the interval; overlapping runs would double-post.
    if (running) return;

    const config = loadConfig();
    if (!isDue(config, now())) return;

    running = true;
    try {
      await runScheduledReports(client, { now: now(), config });
    } catch (err) {
      console.error('❌ The weekly report scheduler failed:', err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();

  return () => clearInterval(timer);
}

module.exports = {
  CHECK_INTERVAL_MS,
  DAY_MS,
  intervalMsFor,
  buildAllReports,
  buildGuildReport,
  clearOwnMessages,
  presentIdsFor,
  isDue,
  lastSlotAt,
  nextSlotAt,
  publishReports,
  runScheduledReports,
  startReportScheduler
};

// commands/wow/report.js
// /report — the weekly guild report: what it covers, when it posts, and a way
// to see it on demand.
//
// Permission is enforced in code as well as declared on the command, for the
// reason given in commands/admin/spam.js: the default-member-permissions flag
// only hides a command in the UI and can be overridden per guild. It matters
// more here than usual, since a single `/report now` is a few hundred Blizzard
// API calls.

const {
  SlashCommandBuilder,
  EmbedBuilder,
  AttachmentBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ChannelType
} = require('discord.js');

const {
  DAYS,
  FREQUENCIES,
  MAX_TRACKED_GUILDS,
  channelFor,
  guildKey,
  loadConfig,
  saveConfig,
  trackGuild,
  untrackGuild
} = require('../../utils/reports/config');
const { buildAllReports, nextSlotAt, publishReports } = require('../../utils/reports/scheduler');
const { deleteSnapshot, loadSnapshot } = require('../../utils/reports/history');
const { deleteKillHistory } = require('../../utils/reports/killHistory');
const { deleteReportHistory, loadReportHistory } = require('../../utils/reports/reportHistory');
const { buildReportWorkbookBuffer } = require('../../utils/reports/excel');
const { buildOwnerIndex } = require('../../utils/reports/links');
const { addRegionOption, resolveScope } = require('../../utils/commandOptions');
const { BlizzardApiError } = require('../../utils/blizzard/client');
const { isAdmin } = require('../../utils/permissions');
const { discordTimestamp, FALLBACK_COLOR, REGION_CHOICES } = require('../../utils/wow');

const DAY_CHOICES = DAYS.map((day, index) => ({ name: day, value: index }));

const FREQUENCY_CHOICES = [
  { name: 'Daily — the channel is cleared and reposted each day', value: 'daily' },
  { name: 'Weekly — one report a week, on a chosen day', value: 'weekly' }
];

const data = new SlashCommandBuilder()
  .setName('report')
  .setDescription('Weekly guild reports: leaderboards, roster changes, and PvP.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(sub =>
    sub.setName('status').setDescription('Show what is tracked and when the next report posts.')
  )
  .addSubcommand(sub =>
    sub
      .setName('now')
      .setDescription('Preview this week\'s report here, without posting or resetting the week.')
  )
  .addSubcommand(sub =>
    sub
      .setName('post')
      .setDescription('Post the report to its channel now, and start a new week from this moment.')
  )
  .addSubcommand(sub =>
    sub
      .setName('excel')
      .setDescription('Download this week\'s report, plus each guild\'s history, as an Excel file.')
  )
  .addSubcommand(sub => {
    sub
      .setName('track')
      .setDescription('Start reporting on a guild.')
      .addStringOption(option =>
        option
          .setName('guild')
          .setDescription('Guild name, exactly as it appears in game.')
          .setRequired(true)
      )
      .addChannelOption(option =>
        option
          .setName('channel')
          .setDescription('Post this guild\'s report here instead of the default channel.')
          .addChannelTypes(ChannelType.GuildText)
      );
    addRegionOption(sub);
    return sub;
  })
  .addSubcommand(sub =>
    sub
      .setName('untrack')
      .setDescription('Stop reporting on a guild, and discard its stored history.')
      .addStringOption(option =>
        option.setName('guild').setDescription('Guild name.').setRequired(true)
      )
      .addStringOption(option =>
        option
          .setName('region')
          .setDescription('Region, if two tracked guilds share a name.')
          .addChoices(...REGION_CHOICES)
      )
  )
  .addSubcommandGroup(group =>
    group
      .setName('configure')
      .setDescription('Change how and when reports are posted.')
      .addSubcommand(sub =>
        sub
          .setName('enabled')
          .setDescription('Turn weekly reports on or off.')
          .addBooleanOption(option =>
            option.setName('value').setDescription('On or off.').setRequired(true)
          )
      )
      .addSubcommand(sub =>
        sub
          .setName('channel')
          .setDescription('Where reports are posted by default.')
          .addChannelOption(option =>
            option
              .setName('channel')
              .setDescription('Report channel.')
              .addChannelTypes(ChannelType.GuildText)
              .setRequired(true)
          )
      )
      .addSubcommand(sub =>
        sub
          .setName('schedule')
          .setDescription('How often, and at what hour (UTC), the report posts.')
          .addIntegerOption(option =>
            option
              .setName('hour')
              .setDescription('Hour of the day, 0-23, UTC.')
              .setMinValue(0)
              .setMaxValue(23)
              .setRequired(true)
          )
          .addStringOption(option =>
            option
              .setName('frequency')
              .setDescription('Daily (the default) or weekly.')
              .addChoices(...FREQUENCY_CHOICES)
          )
          .addIntegerOption(option =>
            option
              .setName('day')
              .setDescription('Day of the week. Only used when the frequency is weekly.')
              .addChoices(...DAY_CHOICES)
          )
      )
      .addSubcommand(sub =>
        sub
          .setName('clear-channel')
          .setDescription('Wipe the bot\'s previous reports before posting a new one.')
          .addBooleanOption(option =>
            option.setName('value').setDescription('On or off.').setRequired(true)
          )
      )
  );

/** "Daily at 18:00 UTC" / "Monday at 18:00 UTC" */
function describeSchedule(config) {
  const at = `${String(config.hour).padStart(2, '0')}:00 UTC`;
  return config.frequency === 'weekly' ? `**${DAYS[config.dayOfWeek]}** at **${at}**` : `**Daily** at **${at}**`;
}

/** "Apex (US) → #reports" */
function describeGuild(guild, config) {
  const channelId = channelFor(guild, config);

  return (
    `**${guild.name}** (${guild.region.toUpperCase()})` +
    ` → ${channelId ? `<#${channelId}>` : '_no channel_'}`
  );
}

function buildStatusEmbed(config) {
  const embed = new EmbedBuilder()
    .setColor(FALLBACK_COLOR)
    .setTitle('Weekly Reports')
    .setDescription(
      config.enabled
        ? `🟢 Enabled — posting ${describeSchedule(config)}.`
        : '⚪ Disabled — turn it on with `/report configure enabled value:true`.'
    );

  embed.addFields({
    name: `Tracked guilds (${config.guilds.length}/${MAX_TRACKED_GUILDS})`,
    value:
      config.guilds.length > 0
        ? config.guilds.map(guild => describeGuild(guild, config)).join('\n')
        : 'None yet — add one with `/report track guild:<name>`.'
  });

  embed.addFields({
    name: 'Default channel',
    value: config.channelId ? `<#${config.channelId}>` : '_not set_',
    inline: true
  });

  const last = discordTimestamp(config.lastPostedAt, 'R');
  embed.addFields({ name: 'Last posted', value: last ?? '_never_', inline: true });
  embed.addFields({
    name: 'Clear before posting',
    value: config.clearChannel ? 'yes — only the current report is left' : 'no',
    inline: true
  });

  if (config.enabled && config.guilds.length > 0) {
    const next = discordTimestamp(nextSlotAt(config), 'F');
    embed.addFields({ name: 'Next report', value: next ?? '_unknown_', inline: true });
  }

  // A guild with no route to a channel is silently skipped at post time, which
  // is exactly the kind of thing a status command exists to surface.
  const unroutable = config.guilds.filter(guild => !channelFor(guild, config));
  if (unroutable.length > 0) {
    embed.addFields({
      name: '⚠️ No channel',
      value:
        `${unroutable.map(guild => guild.name).join(', ')} — set one with ` +
        '`/report configure channel` or re-track with a `channel` option.'
    });
  }

  // Deltas only exist once a guild has been captured, so say which have been.
  const uncaptured = config.guilds.filter(guild => !loadSnapshot(guildKey(guild)));
  if (uncaptured.length > 0) {
    embed.addFields({
      name: 'Awaiting a baseline',
      value:
        `${uncaptured.map(guild => guild.name).join(', ')} — the first report records a ` +
        'starting position; week-over-week changes begin with the second.'
    });
  }

  return embed;
}

/** Turns a roster 404 into something actionable, naming the slug that was tried. */
function describeFailure({ guild, error }) {
  if ((error instanceof BlizzardApiError || error?.name === 'BlizzardApiError') && error.status === 404) {
    return (
      `**${guild.name}** — no guild found at \`${error.guildSlug}\`. ` +
      'Guild names have no index to search, so the name must match in-game exactly.'
    );
  }

  return `**${guild.name}** — ${error?.message ?? 'lookup failed'}`;
}

function failureEmbed(failures) {
  return new EmbedBuilder()
    .setColor(0xff2222)
    .setTitle(`${failures.length} guild(s) could not be reported on`)
    .setDescription(failures.map(describeFailure).join('\n'));
}

async function showStatus(interaction) {
  await interaction.reply({
    embeds: [buildStatusEmbed(loadConfig())],
    flags: MessageFlags.Ephemeral
  });
}

/**
 * Builds the report without saving a snapshot.
 *
 * Previewing must not consume the baseline: if `/report now` persisted, running
 * it on Sunday would leave Monday's scheduled report covering a single day.
 */
async function preview(interaction) {
  const config = loadConfig();

  if (config.guilds.length === 0) {
    await interaction.editReply('❌ No guilds are tracked yet. Add one with `/report track guild:<name>`.');
    return;
  }

  const { reports, failures } = await buildAllReports({ persist: false, config });
  const embeds = [...reports.map(report => report.embed)];

  if (failures.length > 0) embeds.push(failureEmbed(failures));

  await interaction.editReply({
    content: '👀 Preview only — nothing was posted, and the week was not reset.',
    embeds
  });
}

/**
 * Builds this week's report the same way `/report now` does, without touching
 * the baseline, and attaches it as an .xlsx instead of posting embeds — a
 * roster and a history log are both things somebody wants to sort, filter, or
 * keep around, which a Discord embed cannot do.
 */
async function sendExcel(interaction) {
  const config = loadConfig();

  if (config.guilds.length === 0) {
    await interaction.editReply('❌ No guilds are tracked yet. Add one with `/report track guild:<name>`.');
    return;
  }

  const { reports, failures } = await buildAllReports({ persist: false, config });

  if (reports.length === 0) {
    await interaction.editReply({
      content: '❌ No report could be built.',
      embeds: failures.length > 0 ? [failureEmbed(failures)] : []
    });
    return;
  }

  const histories = new Map(reports.map(report => [report.key, loadReportHistory(report.key)]));

  const resolveTag = userId => interaction.client.users.cache.get(userId)?.tag ?? null;

  const buffer = await buildReportWorkbookBuffer(reports, {
    owners: buildOwnerIndex(),
    resolveTag,
    histories
  });

  const attachment = new AttachmentBuilder(Buffer.from(buffer), {
    name: `guild-report-${new Date().toISOString().slice(0, 10)}.xlsx`
  });

  const lines = [`📊 ${reports.length} guild(s), as an Excel file.`];
  if (failures.length > 0) lines.push(`⚠️ ${failures.length} guild(s) failed — see below.`);

  await interaction.editReply({
    content: lines.join(' '),
    files: [attachment],
    embeds: failures.length > 0 ? [failureEmbed(failures)] : []
  });
}

async function postNow(interaction) {
  const config = loadConfig();

  if (config.guilds.length === 0) {
    await interaction.editReply('❌ No guilds are tracked yet. Add one with `/report track guild:<name>`.');
    return;
  }

  if (!config.guilds.some(guild => channelFor(guild, config))) {
    await interaction.editReply(
      '❌ No channel is set. Use `/report configure channel channel:#somewhere` first.'
    );
    return;
  }

  const now = Date.now();
  const { reports, failures } = await buildAllReports({ persist: true, now, config });

  // If clearChannel wipes the bot's recent messages in the report channel, that
  // includes this interaction's own deferred-reply placeholder when it was
  // invoked there — excluding it keeps the later editReply from hitting a
  // message that was just deleted out from under it.
  const ownReply = await interaction.fetchReply().catch(() => null);
  const delivered = await publishReports(interaction.client, reports, {
    config,
    excludeMessageId: ownReply?.id ?? null
  });

  // Posting manually starts a fresh week, so the scheduled report does not
  // follow a few hours later with an almost-empty diff.
  saveConfig({ lastPostedAt: now });

  const lines = [
    `✅ Posted ${reports.length} report(s) to ${delivered.length} channel(s).`,
    'The week now starts from this moment.'
  ];

  if (failures.length > 0) lines.push(`⚠️ ${failures.length} guild(s) failed — see below.`);

  await interaction.editReply({
    content: lines.join(' '),
    embeds: failures.length > 0 ? [failureEmbed(failures)] : []
  });
}

function track(interaction) {
  const scope = resolveScope(interaction);

  const name = interaction.options.getString('guild');
  const channel = interaction.options.getChannel('channel');

  const { added, reason } = trackGuild({
    name,
    region: scope.region,
    channelId: channel?.id ?? null
  });

  if (added) {
    return (
      `✅ Now reporting on **${name}** (${scope.label})` +
      `${channel ? ` in <#${channel.id}>` : ''}. ` +
      'The first report records a starting position; changes appear from the second onward.'
    );
  }

  if (reason === 'duplicate') return `⚠️ **${name}** (${scope.label}) is already tracked.`;
  if (reason === 'full') return `❌ Already tracking ${MAX_TRACKED_GUILDS} guilds — untrack one first.`;

  return '❌ That guild could not be added. A name is required.';
}

function untrack(interaction) {
  const name = interaction.options.getString('guild');
  const region = interaction.options.getString('region');

  const { removed, removedGuilds } = untrackGuild({ name, region });

  if (!removed) {
    return `⚠️ **${name}** is not tracked. \`/report status\` lists what is.`;
  }

  // Drop the stored history too, so re-tracking later starts clean rather than
  // diffing against a roster that may be months old.
  removedGuilds.forEach(guild => {
    deleteSnapshot(guildKey(guild));
    deleteKillHistory(guildKey(guild));
    deleteReportHistory(guildKey(guild));
  });

  return `✅ No longer reporting on **${name}**, and its stored history was discarded.`;
}

function configure(subcommand, interaction) {
  if (subcommand === 'enabled') {
    const value = interaction.options.getBoolean('value');
    const config = loadConfig();

    if (!value) {
      saveConfig({ enabled: false });
      return '⚪ Weekly reports are off.';
    }

    if (config.guilds.length === 0) {
      return '❌ Track at least one guild first: `/report track guild:<name>`.';
    }

    if (!config.guilds.some(guild => channelFor(guild, config))) {
      return '❌ Set a channel first: `/report configure channel channel:#somewhere`.';
    }

    // Arm for the NEXT slot rather than the one that already passed, so
    // switching reports on does not immediately fire one.
    const next = saveConfig({ enabled: true, lastPostedAt: Date.now() });

    return (
      `🟢 Reports are on — ${describeSchedule(next)}. ` +
      `First one ${discordTimestamp(nextSlotAt(next), 'R')}.`
    );
  }

  if (subcommand === 'channel') {
    const channel = interaction.options.getChannel('channel');
    saveConfig({ channelId: channel.id });
    return `✅ Reports will post to <#${channel.id}> unless a guild overrides it.`;
  }

  if (subcommand === 'clear-channel') {
    const value = interaction.options.getBoolean('value');
    saveConfig({ clearChannel: value });

    return value
      ? '✅ The bot\'s previous reports will be deleted before each new one, so the channel ' +
        'only ever shows the current report. Messages from anyone else are left alone.'
      : '✅ Previous reports will be left in place.';
  }

  const hour = interaction.options.getInteger('hour');
  const frequency = interaction.options.getString('frequency');
  const dayOfWeek = interaction.options.getInteger('day');

  const next = saveConfig({
    hour,
    ...(frequency ? { frequency } : {}),
    ...(dayOfWeek === null ? {} : { dayOfWeek })
  });

  return (
    `✅ Reports will post ${describeSchedule(next)}. ` +
    `Next one ${discordTimestamp(nextSlotAt(next), 'R')}.`
  );
}

async function execute(interaction) {
  // The UI-level permission flag can be overridden per guild, so re-check here.
  if (!isAdmin(interaction)) {
    await interaction.reply({
      content: '❌ You need the Manage Server permission to use this.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand();

  if (group === 'configure') {
    await interaction.reply({ content: configure(subcommand, interaction), flags: MessageFlags.Ephemeral });
    return;
  }

  if (subcommand === 'status') {
    await showStatus(interaction);
    return;
  }

  if (subcommand === 'track') {
    await interaction.reply({ content: track(interaction), flags: MessageFlags.Ephemeral });
    return;
  }

  if (subcommand === 'untrack') {
    await interaction.reply({ content: untrack(interaction), flags: MessageFlags.Ephemeral });
    return;
  }

  // Building a report is hundreds of API calls and comfortably exceeds
  // Discord's three-second window.
  await interaction.deferReply();

  if (subcommand === 'post') {
    await postNow(interaction);
    return;
  }

  if (subcommand === 'excel') {
    await sendExcel(interaction);
    return;
  }

  await preview(interaction);
}

module.exports = {
  data,
  help: 'Configures and previews the weekly guild report.',
  // Manage Server gated, so it belongs with the other admin commands in /help
  // even though it lives under commands/wow/.
  category: 'Admin',
  buildStatusEmbed,
  describeFailure,
  describeSchedule,
  describeGuild,
  execute,
  nextSlotAt
};

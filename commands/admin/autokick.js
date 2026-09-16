// commands/admin/autokick.js
// /autokick — removes members who never select a role.
//
// This is the only feature that acts on people for something they did NOT do,
// on a timer, so the command is built around making the consequences visible
// before they happen: `preview` shows exactly who is at risk and changes
// nothing, enabling refuses without an audit channel, and a manual run has to
// be confirmed.
//
// Permission is enforced in code as well as declared, for the reason given in
// commands/admin/spam.js: the default-member-permissions flag only hides a
// command in the UI and can be overridden per guild.

const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ChannelType
} = require('discord.js');

const {
  MAX_GRACE_DAYS,
  MAX_KICKS_PER_SWEEP,
  MIN_GRACE_DAYS,
  disable,
  enable,
  loadConfig,
  saveConfig
} = require('../../utils/onboarding/config');
const { buildPreviewEmbed, buildSweepEmbed } = require('../../utils/onboarding/alert');
const { inspectGuild, sweepGuild } = require('../../utils/onboarding/sweep');
const { discordTimestamp, FALLBACK_COLOR } = require('../../utils/wow');

const data = new SlashCommandBuilder()
  .setName('autokick')
  .setDescription('Remove members who never select a role.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(sub =>
    sub.setName('status').setDescription('Show the current onboarding-sweep settings.')
  )
  .addSubcommand(sub =>
    sub
      .setName('preview')
      .setDescription('Show who would be removed or reminded. Changes nothing.')
  )
  .addSubcommand(sub =>
    sub
      .setName('run')
      .setDescription('Run a sweep now, for real.')
      .addBooleanOption(option =>
        option
          .setName('confirm')
          .setDescription('Yes, remove people now. Run /autokick preview first.')
          .setRequired(true)
      )
  )
  .addSubcommandGroup(group =>
    group
      .setName('configure')
      .setDescription('Change how the onboarding sweep behaves.')
      .addSubcommand(sub =>
        sub
          .setName('enabled')
          .setDescription('Turn the sweep on or off.')
          .addBooleanOption(option =>
            option.setName('value').setDescription('On or off.').setRequired(true)
          )
      )
      .addSubcommand(sub =>
        sub
          .setName('grace')
          .setDescription('How long a new member has to pick a role before removal.')
          .addIntegerOption(option =>
            option
              .setName('days')
              .setDescription(`Days (${MIN_GRACE_DAYS}-${MAX_GRACE_DAYS}).`)
              .setMinValue(MIN_GRACE_DAYS)
              .setMaxValue(MAX_GRACE_DAYS)
              .setRequired(true)
          )
      )
      .addSubcommand(sub =>
        sub
          .setName('reminder')
          .setDescription('How many days after joining to send the reminder DM.')
          .addIntegerOption(option =>
            option
              .setName('days')
              .setDescription('Days after joining. Must be less than the grace period.')
              .setMinValue(0)
              .setMaxValue(MAX_GRACE_DAYS)
              .setRequired(true)
          )
      )
      .addSubcommand(sub =>
        sub
          .setName('alert-channel')
          .setDescription('Where a record of every removal is posted.')
          .addChannelOption(option =>
            option
              .setName('channel')
              .setDescription('Moderator channel.')
              .addChannelTypes(ChannelType.GuildText)
              .setRequired(true)
          )
      )
      .addSubcommand(sub =>
        sub
          .setName('role-channel')
          .setDescription('The role picker, so reminder DMs can link to it.')
          .addChannelOption(option =>
            option
              .setName('channel')
              .setDescription('Channel where members choose roles.')
              .setRequired(true)
          )
      )
  );

function buildStatusEmbed(config) {
  const embed = new EmbedBuilder()
    .setColor(FALLBACK_COLOR)
    .setTitle('Onboarding Sweep')
    .setDescription(
      config.enabled
        ? `🟢 Enabled — members have **${config.graceDays} days** to pick a role, ` +
          `with a reminder DM after **${config.warnAfterDays}**.`
        : '⚪ Disabled — nobody is being removed. `/autokick configure enabled value:true` turns it on.'
    );

  embed.addFields(
    { name: 'Grace period', value: `${config.graceDays} days`, inline: true },
    { name: 'Reminder DM', value: `after ${config.warnAfterDays} days`, inline: true },
    { name: 'Max per sweep', value: String(MAX_KICKS_PER_SWEEP), inline: true },
    {
      name: 'Audit channel',
      value: config.alertChannelId ? `<#${config.alertChannelId}>` : '_not set_',
      inline: true
    },
    {
      name: 'Role picker',
      value: config.roleChannelId ? `<#${config.roleChannelId}>` : '_not set_',
      inline: true
    },
    {
      name: 'Last sweep',
      value: discordTimestamp(config.lastSweepAt, 'R') ?? '_never_',
      inline: true
    }
  );

  // The single most important thing to be able to check: who is safe.
  const cutoff = discordTimestamp(config.enabledAt, 'F');
  embed.addFields({
    name: 'Cutoff',
    value: cutoff
      ? `Only members who joined after ${cutoff} can be removed. Anyone who was already ` +
        'in the server when the sweep was switched on is permanently exempt.'
      : 'Not set yet — the cutoff is stamped the moment the sweep is switched on, and nobody ' +
        'who joined before that can ever be removed by it.'
  });

  return embed;
}

/** Enabling is refused unless a removal can be recorded somewhere. */
function configure(subcommand, interaction) {
  if (subcommand === 'enabled') {
    const value = interaction.options.getBoolean('value');

    if (!value) {
      disable();
      return '⚪ The onboarding sweep is off. Nobody will be removed.';
    }

    const config = loadConfig();

    if (!config.alertChannelId) {
      return (
        '❌ Set an audit channel first: `/autokick configure alert-channel channel:#mod-log`.\n' +
        'Removals are permanent from the member\'s point of view, so there has to be a record of them.'
      );
    }

    const next = enable();

    return (
      `🟢 The onboarding sweep is on. Members who join from now on have **${next.graceDays} days** ` +
      `to pick a role, with a reminder DM after **${next.warnAfterDays}**.\n` +
      '**Nobody already in the server can be removed by it** — the cutoff is this moment. ' +
      'Run `/autokick preview` any time to see who is at risk.'
    );
  }

  if (subcommand === 'grace') {
    const next = saveConfig({ graceDays: interaction.options.getInteger('days') });

    // warnAfterDays is clamped below graceDays on write, so shortening the grace
    // period can move the reminder without the admin asking.
    return (
      `✅ Members now have **${next.graceDays} days** to pick a role, ` +
      `with the reminder after **${next.warnAfterDays}**.`
    );
  }

  if (subcommand === 'reminder') {
    const requested = interaction.options.getInteger('days');
    const next = saveConfig({ warnAfterDays: requested });

    if (next.warnAfterDays !== requested) {
      return (
        `⚠️ A reminder on day ${requested} would land on or after the ${next.graceDays}-day ` +
        `deadline, so it was set to day **${next.warnAfterDays}** instead.`
      );
    }

    return `✅ The reminder DM goes out **${next.warnAfterDays} days** after someone joins.`;
  }

  if (subcommand === 'alert-channel') {
    const channel = interaction.options.getChannel('channel');
    saveConfig({ alertChannelId: channel.id });
    return `✅ Every removal will be recorded in <#${channel.id}>.`;
  }

  const channel = interaction.options.getChannel('channel');
  saveConfig({ roleChannelId: channel.id });
  return `✅ Reminder DMs will point members at <#${channel.id}>.`;
}

async function preview(interaction) {
  const config = loadConfig();
  const classified = await inspectGuild(interaction.guild, { config });

  if (classified === null) {
    await interaction.editReply(
      '❌ Could not read the member list. The bot needs the Server Members intent enabled in the ' +
        'Discord Developer Portal.'
    );
    return;
  }

  await interaction.editReply({ embeds: [buildPreviewEmbed({ ...classified, config })] });
}

async function run(interaction) {
  if (!interaction.options.getBoolean('confirm')) {
    await interaction.editReply(
      '🛑 Nothing was done. Run `/autokick preview` to see who is at risk, then re-run with ' +
        '`confirm:true` if that list looks right.'
    );
    return;
  }

  const config = loadConfig();

  if (!config.enabled) {
    await interaction.editReply(
      '❌ The sweep is off. Turn it on with `/autokick configure enabled value:true` first — that ' +
        'also stamps the cutoff that protects existing members.'
    );
    return;
  }

  const result = await sweepGuild(interaction.guild, { config });

  if (result === null) {
    await interaction.editReply('❌ Could not read the member list, so nothing was done.');
    return;
  }

  await interaction.editReply({
    content: `✅ Sweep complete — ${result.kicked.length} removed, ${result.warned.length} reminded.`,
    embeds: [buildSweepEmbed({ ...result, config })]
  });
}

async function execute(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({
      content: '❌ You need the Manage Server permission to use this.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand();

  if (group === 'configure') {
    await interaction.reply({
      content: configure(subcommand, interaction),
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (subcommand === 'status') {
    await interaction.reply({
      embeds: [buildStatusEmbed(loadConfig())],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  // Fetching a full member list, and any DMs that follow, exceed Discord's
  // three-second interaction window.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (subcommand === 'run') {
    await run(interaction);
    return;
  }

  await preview(interaction);
}

module.exports = {
  data,
  help: 'Removes members who never select a role, after a reminder.',
  category: 'Admin',
  buildStatusEmbed,
  configure,
  execute
};

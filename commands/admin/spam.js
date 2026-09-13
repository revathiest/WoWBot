// commands/admin/spam.js
// /spam — inspect, tune, and dry-run spam detection.
//
// Permission is enforced in code as well as declared on the command. The
// default-member-permissions flag only hides the command in the UI and can be
// overridden per guild, so it is a convenience, not a security boundary.

const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ChannelType
} = require('discord.js');

const { loadConfig, saveConfig, ACTIONS } = require('../../utils/spam/config');
const detector = require('../../utils/spam/detector');
const { formatDuration } = require('../../utils/spam/alert');
const { FALLBACK_COLOR } = require('../../utils/wow');

const ACTION_CHOICES = ACTIONS.map(action => ({
  name: action === 'ban' ? 'Ban' : 'Timeout',
  value: action
}));

const data = new SlashCommandBuilder()
  .setName('spam')
  .setDescription('Inspect and configure spam detection.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(sub =>
    sub.setName('status').setDescription('Show the current spam-detection settings.')
  )
  .addSubcommand(sub =>
    sub
      .setName('test')
      .setDescription('Check what a message would trigger, without acting on anyone.')
      .addStringOption(option =>
        option.setName('text').setDescription('Text to run through the detector.').setRequired(true)
      )
  )
  .addSubcommandGroup(group =>
    group
      .setName('configure')
      .setDescription('Change spam-detection settings.')
      .addSubcommand(sub =>
        sub
          .setName('enabled')
          .setDescription('Turn spam detection on or off.')
          .addBooleanOption(option =>
            option.setName('value').setDescription('On or off.').setRequired(true)
          )
      )
      .addSubcommand(sub =>
        sub
          .setName('alert-channel')
          .setDescription('Where enforcement alerts are posted.')
          .addChannelOption(option =>
            option
              .setName('channel')
              .setDescription('Alert channel.')
              .addChannelTypes(ChannelType.GuildText)
              .setRequired(true)
          )
      )
      .addSubcommand(sub =>
        sub
          .setName('rate-limit')
          .setDescription('How many messages in how few seconds counts as too fast.')
          .addIntegerOption(option =>
            option
              .setName('count')
              .setDescription('Message count (2-50).')
              .setMinValue(2)
              .setMaxValue(50)
              .setRequired(true)
          )
          .addIntegerOption(option =>
            option
              .setName('seconds')
              .setDescription('Window in seconds (1-60).')
              .setMinValue(1)
              .setMaxValue(60)
              .setRequired(true)
          )
      )
      .addSubcommand(sub =>
        sub
          .setName('action')
          .setDescription('What to do when someone is judged a spambot.')
          .addStringOption(option =>
            option
              .setName('type')
              .setDescription('Ban or timeout.')
              .addChoices(...ACTION_CHOICES)
              .setRequired(true)
          )
          .addIntegerOption(option =>
            option
              .setName('minutes')
              .setDescription('Timeout length in minutes (1-40320).')
              .setMinValue(1)
              .setMaxValue(40320)
          )
      )
      .addSubcommand(sub =>
        sub
          .setName('secondary-action')
          .setDescription('What to do for a possibly-compromised established member.')
          .addStringOption(option =>
            option
              .setName('type')
              .setDescription('Ban or timeout.')
              .addChoices(...ACTION_CHOICES)
              .setRequired(true)
          )
          .addIntegerOption(option =>
            option
              .setName('minutes')
              .setDescription('Timeout length in minutes (1-40320).')
              .setMinValue(1)
              .setMaxValue(40320)
          )
      )
      .addSubcommand(sub =>
        sub
          .setName('thresholds')
          .setDescription('Red flags required, and the account-age cutoffs.')
          .addIntegerOption(option =>
            option
              .setName('signals')
              .setDescription('Red flags required for a regular member (1-10).')
              .setMinValue(1)
              .setMaxValue(10)
          )
          .addIntegerOption(option =>
            option
              .setName('new-account-days')
              .setDescription('Below this account age, treat as new (1-365).')
              .setMinValue(1)
              .setMaxValue(365)
          )
          .addIntegerOption(option =>
            option
              .setName('established-days')
              .setDescription('At or above this tenure, treat as established (1-365).')
              .setMinValue(1)
              .setMaxValue(365)
          )
      )
      .addSubcommand(sub =>
        sub
          .setName('exempt-role')
          .setDescription('Add or remove a role that is never actioned.')
          .addStringOption(option =>
            option
              .setName('mode')
              .setDescription('Add or remove.')
              .addChoices({ name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' })
              .setRequired(true)
          )
          .addRoleOption(option =>
            option.setName('role').setDescription('The role.').setRequired(true)
          )
      )
      .addSubcommand(sub =>
        sub
          .setName('exempt-channel')
          .setDescription('Add or remove a channel that is never monitored.')
          .addStringOption(option =>
            option
              .setName('mode')
              .setDescription('Add or remove.')
              .addChoices({ name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' })
              .setRequired(true)
          )
          .addChannelOption(option =>
            option.setName('channel').setDescription('The channel.').setRequired(true)
          )
      )
  );

function describeAction(action, durationMs) {
  return action === 'ban' ? 'Ban' : `Timeout (${formatDuration(durationMs)})`;
}

function buildStatusEmbed(config) {
  const threshold = config.signalThreshold;

  const tiers = [
    `**New** (account < ${config.newAccountDays}d, or joined today) — 1 flag → ${describeAction(config.action, config.timeoutMs)}`,
    `**Regular** — ${threshold} flags → ${describeAction(config.action, config.timeoutMs)}`,
    `**Established** (${config.establishedDays}d+) — ${threshold} flags → ${describeAction(config.secondaryAction, config.secondaryTimeoutMs)}`,
    `**Established** — ${threshold + 1} flags → ${describeAction(config.action, config.timeoutMs)}`
  ].join('\n');

  const list = ids => (ids.length ? ids.map(id => `\`${id}\``).join(', ') : 'none');

  return new EmbedBuilder()
    .setColor(config.enabled ? 0x43b581 : FALLBACK_COLOR)
    .setTitle(`Spam Detection — ${config.enabled ? '🟢 Enabled' : '⚪ Disabled'}`)
    .setDescription(tiers)
    .addFields(
      {
        name: 'Alert Channel',
        value: config.alertChannelId ? `<#${config.alertChannelId}>` : '⚠️ not set',
        inline: true
      },
      {
        name: 'Rate Limit',
        value: `${config.rateLimit.count} msgs / ${Math.round(config.rateLimit.windowMs / 1000)}s`,
        inline: true
      },
      {
        name: 'Repetition',
        value: `${config.duplicateThreshold}x, or ${config.crossChannelThreshold} channels`,
        inline: true
      },
      { name: 'Mass Mention', value: `${config.mentionThreshold}+`, inline: true },
      { name: 'Exempt Roles', value: list(config.exemptRoleIds), inline: true },
      { name: 'Exempt Channels', value: list(config.exemptChannelIds), inline: true }
    )
    .setFooter({ text: 'Moderators (Manage Messages) are always exempt.' });
}

/** Dry run: content signals only, no state written and nobody actioned. */
function buildTestEmbed(text, config) {
  const signals = detector.collectContentSignals({
    message: { content: text, mentions: { users: { size: 0 }, roles: { size: 0 } } },
    config
  });

  const embed = new EmbedBuilder()
    .setColor(signals.length ? 0xff8c00 : 0x43b581)
    .setTitle(signals.length ? `⚠️ ${signals.length} red flag(s)` : '✅ No red flags')
    .addFields({ name: 'Text', value: text.slice(0, 1024) });

  if (signals.length) {
    embed.addFields({ name: 'Flags', value: signals.map(s => `• ${s}`).join('\n') });
    embed.addFields({
      name: 'Outcome',
      value: [
        `New account: **${signals.length >= 1 ? 'actioned' : 'ignored'}**`,
        `Regular: **${signals.length >= config.signalThreshold ? 'actioned' : 'ignored'}**`,
        `Established: **${signals.length >= config.signalThreshold + 1 ? 'actioned' : signals.length >= config.signalThreshold ? 'timed out' : 'ignored'}**`
      ].join('\n')
    });
  }

  return embed.setFooter({ text: 'Dry run — nothing was recorded and nobody was actioned.' });
}

function applyConfigure(subcommand, interaction) {
  const config = loadConfig();

  switch (subcommand) {
    case 'enabled': {
      const value = interaction.options.getBoolean('value');
      saveConfig({ enabled: value });
      return `Spam detection is now **${value ? 'enabled' : 'disabled'}**.`;
    }

    case 'alert-channel': {
      const channel = interaction.options.getChannel('channel');
      saveConfig({ alertChannelId: channel.id });
      return `Alerts will be posted to <#${channel.id}>.`;
    }

    case 'rate-limit': {
      const count = interaction.options.getInteger('count');
      const seconds = interaction.options.getInteger('seconds');
      const saved = saveConfig({ rateLimit: { count, windowMs: seconds * 1000 } });
      return `Rate limit set to **${saved.rateLimit.count} messages / ${Math.round(saved.rateLimit.windowMs / 1000)}s**.`;
    }

    case 'action':
    case 'secondary-action': {
      const type = interaction.options.getString('type');
      const minutes = interaction.options.getInteger('minutes');
      const isPrimary = subcommand === 'action';

      const changes = isPrimary ? { action: type } : { secondaryAction: type };
      if (minutes) {
        changes[isPrimary ? 'timeoutMs' : 'secondaryTimeoutMs'] = minutes * 60000;
      }

      const saved = saveConfig(changes);
      const label = isPrimary ? 'Primary action' : 'Secondary action';
      const value = isPrimary
        ? describeAction(saved.action, saved.timeoutMs)
        : describeAction(saved.secondaryAction, saved.secondaryTimeoutMs);

      return `${label} set to **${value}**.`;
    }

    case 'thresholds': {
      const signals = interaction.options.getInteger('signals');
      const newDays = interaction.options.getInteger('new-account-days');
      const establishedDays = interaction.options.getInteger('established-days');

      const changes = {};
      if (signals !== null) changes.signalThreshold = signals;
      if (newDays !== null) changes.newAccountDays = newDays;
      if (establishedDays !== null) changes.establishedDays = establishedDays;

      if (Object.keys(changes).length === 0) {
        return '❌ Give at least one value to change.';
      }

      const saved = saveConfig(changes);
      return `Thresholds updated — **${saved.signalThreshold}** flags, new < **${saved.newAccountDays}d**, established ≥ **${saved.establishedDays}d**.`;
    }

    case 'exempt-role':
    case 'exempt-channel': {
      const isRole = subcommand === 'exempt-role';
      const mode = interaction.options.getString('mode');
      const target = isRole
        ? interaction.options.getRole('role')
        : interaction.options.getChannel('channel');

      const field = isRole ? 'exemptRoleIds' : 'exemptChannelIds';
      const current = config[field];
      const next =
        mode === 'add'
          ? [...current, target.id]
          : current.filter(id => id !== target.id);

      saveConfig({ [field]: next });

      const mention = isRole ? `<@&${target.id}>` : `<#${target.id}>`;
      return `${mention} ${mode === 'add' ? 'added to' : 'removed from'} the exempt ${isRole ? 'roles' : 'channels'}.`;
    }

    default:
      return `❌ Unknown setting: ${subcommand}`;
  }
}

async function execute(interaction) {
  // The UI-level permission flag can be overridden per guild, so re-check here.
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
    const message = applyConfigure(subcommand, interaction);
    await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    return;
  }

  if (subcommand === 'test') {
    const text = interaction.options.getString('text');
    await interaction.reply({
      embeds: [buildTestEmbed(text, loadConfig())],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.reply({
    embeds: [buildStatusEmbed(loadConfig())],
    flags: MessageFlags.Ephemeral
  });
}

module.exports = {
  data,
  help: 'Inspect, tune, and dry-run spam detection.',
  category: 'Admin',
  applyConfigure,
  buildStatusEmbed,
  buildTestEmbed,
  execute
};

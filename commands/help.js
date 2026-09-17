// commands/help.js
// /help — the command list, and the designated read-only help channel.
//
// No default-member-permissions flag, deliberately: `/help show` is for
// everybody. The administrative subcommands check Manage Server in code
// instead, which is the real boundary anyway — see the note in
// commands/admin/spam.js about that flag being a UI convenience.

const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ChannelType
} = require('discord.js');

const store = require('../utils/help/store');
const { setupHelpChannel } = require('../utils/help/post');
const { ADMIN_CATEGORIES, buildCommandEmbed, buildHelpMessages } = require('../utils/help/content');
const { isLocked, unlockChannel } = require('../utils/channelLock');
const { FALLBACK_COLOR } = require('../utils/wow');

const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('What this bot can do.')
  .addSubcommand(sub =>
    sub
      .setName('show')
      .setDescription('List the commands, or explain one of them.')
      .addStringOption(option =>
        option.setName('command').setDescription('A command name, for more detail.')
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('setup')
      .setDescription('Post the help message in a channel and lock it to read-only.')
      .addChannelOption(option =>
        option
          .setName('channel')
          .setDescription('Channel for the help post.')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('unlock')
      .setDescription('Hand the help channel back to the server\'s normal permissions.')
      .addChannelOption(option =>
        option
          .setName('channel')
          .setDescription('Channel to unlock.')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true)
      )
  )
  .addSubcommand(sub => sub.setName('status').setDescription('Where the help post lives.'));

function isAdmin(interaction) {
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
}

/** Summarises what the lock did, including what it could not do. */
function describeLock(lock, channel) {
  if (!lock.ok) {
    return (
      `⚠️ <#${channel.id}> could **not** be locked — ${lock.reason}. The post is there, but ` +
      'anyone can still write in the channel.'
    );
  }

  const lines = [
    `🔒 <#${channel.id}> is now read-only: everyone can see it, only the bot can post.`
  ];

  if (lock.clearedRoles.length > 0) {
    // Worth naming: these roles had channel-specific permission to post, which
    // would otherwise have survived the lock on @everyone.
    lines.push(
      `Also revoked posting from ${lock.clearedRoles.map(id => `<@&${id}>`).join(', ')}, ` +
        'which had channel-specific permission to post.'
    );
  }

  if (lock.warnings.length > 0) {
    lines.push(`⚠️ ${lock.warnings.join('; ')}.`);
  }

  // Never claim a stronger guarantee than Discord actually provides.
  lines.push(
    '_Members with the Administrator permission bypass channel permissions and can still post. ' +
      'No bot can prevent that._'
  );

  return lines.join('\n');
}

function buildStatusEmbed(guildId, channel) {
  const settings = store.get(guildId);

  const embed = new EmbedBuilder()
    .setColor(FALLBACK_COLOR)
    .setTitle('Help post')
    .setDescription(
      settings
        ? `Posted in <#${settings.channelId}>. It is checked against the loaded commands every ` +
          'time the bot starts, and rewritten only if something changed.'
        : 'Not set up yet — `/help setup channel:#help` posts it and locks the channel.'
    );

  if (settings) {
    embed.addFields(
      {
        name: 'Posts',
        value: settings.messageIds.length > 0 ? `${settings.messageIds.length} messages` : 'not posted yet',
        inline: true
      },
      {
        name: 'Channel',
        value: channel ? (isLocked(channel) ? '🔒 read-only' : '⚠️ writable') : 'unknown',
        inline: true
      }
    );
  }

  return embed;
}

async function show(interaction) {
  const commands = interaction.client.commands ?? new Map();
  const requested = (interaction.options.getString('command') ?? '').replace(/^\//, '').trim();

  // Admin commands are shown to the people who can run them. The posted help in
  // the help channel never includes them, since everybody reads that.
  const includeAdmin = isAdmin(interaction);

  if (requested) {
    const command = commands.get(requested.toLowerCase());

    if (!command) {
      await interaction.reply({
        content: `❌ There is no \`/${requested}\` command. \`/help show\` lists them all.`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (ADMIN_CATEGORIES.includes(command.category) && !includeAdmin) {
      // Said plainly rather than pretending the command does not exist.
      await interaction.reply({
        content: `❌ \`/${requested}\` is only available to members who can manage the server.`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    await interaction.reply({
      embeds: [buildCommandEmbed(requested.toLowerCase(), command)],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  // Ephemeral replies take the same ten-embed limit as any other message, and
  // the generated post is comfortably inside it.
  const messages = buildHelpMessages(commands, {
    guildName: interaction.guild?.name ?? null,
    includeAdmin
  });

  await interaction.reply({
    embeds: messages.flatMap(message => message.embeds),
    flags: MessageFlags.Ephemeral
  });
}

async function setup(interaction) {
  const channel = interaction.options.getChannel('channel');

  const { lock, post } = await setupHelpChannel(interaction.client, {
    guildId: interaction.guildId,
    channel,
    botId: interaction.client.user.id
  });

  const lines = [describeLock(lock, channel)];

  lines.push(
    post.ok
      ? `✅ Published ${post.messageIds.length} posts in <#${channel.id}> — an overview with jump ` +
        'links, then one post per category. They rebuild themselves whenever the bot restarts, so ' +
        'they can never fall out of date with the commands.'
      : `❌ The help post could not be published — ${post.reason}.`
  );

  await interaction.editReply(lines.join('\n\n'));
}

async function unlock(interaction) {
  const channel = interaction.options.getChannel('channel');
  const result = await unlockChannel(channel, { reason: 'Help channel unlocked' });

  await interaction.editReply(
    result.ok
      ? `🔓 <#${channel.id}> is back to the server's normal permissions. Note this removes the ` +
        'denials rather than granting anything, so the channel inherits from its category and roles again.'
      : `❌ Could not unlock <#${channel.id}> — ${result.reason}.`
  );
}

async function execute(interaction) {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'show') {
    await show(interaction);
    return;
  }

  if (subcommand === 'status') {
    const settings = store.get(interaction.guildId);
    const channel = settings
      ? await interaction.guild?.channels?.fetch(settings.channelId).catch(() => null)
      : null;

    await interaction.reply({
      embeds: [buildStatusEmbed(interaction.guildId, channel)],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (!isAdmin(interaction)) {
    await interaction.reply({
      content: '❌ You need the Manage Server permission to change the help channel.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  // Editing permissions and posting are several round trips to Discord.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (subcommand === 'setup') {
    await setup(interaction);
    return;
  }

  await unlock(interaction);
}

module.exports = {
  data,
  help: 'Lists every command, and manages the read-only help channel.',
  category: 'Help',
  // /help show is for everybody; managing the channel is not.
  adminSubcommands: ['setup', 'unlock'],
  buildStatusEmbed,
  describeLock,
  execute
};

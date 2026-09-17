// commands/wow/iam.js
// /iam — tells the bot which characters are yours, so the weekly report can
// mention you by name instead of listing a character it cannot connect to
// anybody.
//
// Entirely optional. Reports are built from guild rosters and read fine with
// nobody linked; a link only upgrades "Butud" into "Butud (@you)". That is why
// this command needs no permissions and why `forget` deletes everything in one
// step — see the note at the top of utils/reports/links.js.

const {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits
} = require('discord.js');

const {
  MAX_CHARACTERS_PER_USER,
  charactersFor,
  forget,
  linkCharacter,
  unlinkCharacter
} = require('../../utils/reports/links');
const { getCharacterProfile } = require('../../utils/blizzard/profile');
const { resolveRealm } = require('../../utils/blizzard/realms');
const { BlizzardApiError } = require('../../utils/blizzard/client');
const {
  addGameOption,
  addRealmOption,
  addRegionOption,
  resolveRealmName,
  resolveScope
} = require('../../utils/commandOptions');
const { classColor, FALLBACK_COLOR } = require('../../utils/wow');
const { GAMES: GAME_VERSIONS } = require('../../config');

const data = new SlashCommandBuilder()
  .setName('iam')
  .setDescription('Link your WoW characters so weekly reports can mention you.')
  .addSubcommand(sub => {
    sub
      .setName('add')
      .setDescription('Claim one of your characters.')
      .addStringOption(option =>
        option.setName('character').setDescription('Character name.').setRequired(true)
      );
    addRealmOption(sub);
    addGameOption(sub);
    addRegionOption(sub);
    return sub;
  })
  .addSubcommand(sub => {
    sub
      .setName('remove')
      .setDescription('Unclaim a character.')
      .addStringOption(option =>
        option.setName('character').setDescription('Character name.').setRequired(true)
      )
      .addStringOption(option =>
        option.setName('realm').setDescription('Realm, if you have claimed the name twice.')
      );
    return sub;
  })
  .addSubcommand(sub =>
    sub
      .setName('list')
      .setDescription('Show claimed characters.')
      .addUserOption(option =>
        option.setName('user').setDescription('Whose characters to show. Defaults to you.')
      )
  )
  .addSubcommand(sub =>
    sub.setName('forget').setDescription('Delete everything the bot stores about you.')
  )
  .addSubcommandGroup(group => {
    group
      .setName('manage')
      .setDescription('Assign characters on behalf of a member. Requires Manage Server.')
      .addSubcommand(sub => {
        sub
          .setName('assign')
          .setDescription('Link a character to a member.')
          .addUserOption(option =>
            option.setName('user').setDescription('Who owns the character.').setRequired(true)
          )
          .addStringOption(option =>
            option.setName('character').setDescription('Character name.').setRequired(true)
          );
        addRealmOption(sub);
        addGameOption(sub);
        addRegionOption(sub);
        return sub;
      })
      .addSubcommand(sub =>
        sub
          .setName('unassign')
          .setDescription('Unlink a character from a member.')
          .addUserOption(option =>
            option.setName('user').setDescription('Whose character to unlink.').setRequired(true)
          )
          .addStringOption(option =>
            option.setName('character').setDescription('Character name.').setRequired(true)
          )
          .addStringOption(option =>
            option.setName('realm').setDescription('Realm, if the name is linked twice.')
          )
      );

    return group;
  });

function characterLine(character) {
  const version = GAME_VERSIONS[character.game]?.label ?? character.game;
  return `**${character.name}** · ${character.realm} (${character.region.toUpperCase()} · ${version})`;
}

function buildListEmbed(userId, characters) {
  const embed = new EmbedBuilder()
    .setColor(FALLBACK_COLOR)
    .setTitle('Linked characters')
    .setDescription(
      characters.length > 0
        ? characters.map(characterLine).join('\n')
        : `<@${userId}> has not linked any characters. \`/iam add character:<name>\` does it.`
    );

  if (characters.length > 0) {
    embed.setFooter({ text: `${characters.length} of ${MAX_CHARACTERS_PER_USER} slots used` });
  }

  return embed;
}

/**
 * Claims a character after confirming it exists.
 *
 * The check is one API call and prevents a typo from sitting in the link file
 * forever, silently never matching a roster.
 */
async function add(interaction, { targetId = interaction.user.id, force = false } = {}) {
  const scope = resolveScope(interaction);
  // Reused for /iam manage assign, where the character belongs to somebody
  // other than whoever ran the command.
  const self = targetId === interaction.user.id;
  const characterName = interaction.options.getString('character');
  const realm = resolveRealmName(interaction);

  if (!realm) {
    await interaction.editReply(
      '❌ No realm given, and no default realm is configured. Pass the `realm` option.'
    );
    return;
  }

  const target = await resolveRealm(realm, { region: scope.region, game: scope.game });

  let profile;
  try {
    profile = await getCharacterProfile(target.slug, characterName, {
      region: scope.region,
      game: scope.game
    });
  } catch (err) {
    if ((err instanceof BlizzardApiError || err?.name === 'BlizzardApiError') && err.status === 404) {
      await interaction.editReply(
        `❌ No character named **${characterName}** on \`${target.slug}\` (${scope.label}). ` +
          'Check the spelling, realm, and game version.'
      );
      return;
    }
    throw err;
  }

  const { linked, reason, claimedBy, movedFrom } = linkCharacter(
    targetId,
    {
      // Store Blizzard's casing rather than whatever was typed.
      name: profile.name ?? characterName,
      realm: target.name || realm,
      region: scope.region,
      game: scope.game
    },
    { force }
  );

  if (linked) {
    const lines = [`✅ **${profile.name}** · ${target.name || realm} is linked to <@${targetId}>.`];

    if (movedFrom) {
      // Never let a reassignment happen silently — somebody just lost a claim.
      lines.push(`⚠️ It was previously linked to <@${movedFrom}>, and has been moved.`);
    }

    lines.push(
      self
        ? 'Weekly reports will mention you when this character does something worth reporting.'
        : 'Weekly reports will mention them when this character does something worth reporting.'
    );

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(classColor(profile.character_class?.name))
          .setDescription(lines.join('\n'))
      ]
    });
    return;
  }

  if (reason === 'duplicate') {
    await interaction.editReply(
      self
        ? `⚠️ **${characterName}** is already linked to you.`
        : `⚠️ **${characterName}** is already linked to <@${targetId}>.`
    );
    return;
  }

  if (reason === 'claimed') {
    await interaction.editReply(
      `❌ **${characterName}** is already linked to <@${claimedBy}>. ` +
        'If that is wrong, they can release it with `/iam remove`.'
    );
    return;
  }

  if (reason === 'full') {
    await interaction.editReply(
      self
        ? `❌ You have linked the maximum of ${MAX_CHARACTERS_PER_USER} characters. ` +
          'Remove one first with `/iam remove`.'
        : `❌ <@${targetId}> already has the maximum of ${MAX_CHARACTERS_PER_USER} linked ` +
          'characters. Unlink one first with `/iam manage unassign`.'
    );
    return;
  }

  await interaction.editReply('❌ That character could not be linked.');
}

function remove(interaction, { targetId = interaction.user.id } = {}) {
  const characterName = interaction.options.getString('character');
  const realm = interaction.options.getString('realm');
  const self = targetId === interaction.user.id;

  const { removed } = unlinkCharacter(targetId, { name: characterName, realm });

  if (removed) {
    return self
      ? `✅ **${characterName}** is no longer linked to you.`
      : `✅ **${characterName}** is no longer linked to <@${targetId}>.`;
  }

  return self
    ? `⚠️ **${characterName}** is not linked to you. \`/iam list\` shows what is.`
    : `⚠️ **${characterName}** is not linked to <@${targetId}>. ` +
      '`/iam list user:@them` shows what is.';
}

/** Assigning on somebody's behalf is a moderator action, not a self-service one. */
function isAdmin(interaction) {
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
}

async function execute(interaction) {
  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand();

  if (group === 'manage') {
    if (!isAdmin(interaction)) {
      await interaction.reply({
        content:
          '❌ You need the Manage Server permission to assign characters to other members. ' +
          'Use `/iam add` to claim your own.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const target = interaction.options.getUser('user');

    if (subcommand === 'assign') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      // Forced: an admin assigning a character is usually settling exactly the
      // dispute that would otherwise be refused.
      await add(interaction, { targetId: target.id, force: true });
      return;
    }

    await interaction.reply({
      content: remove(interaction, { targetId: target.id }),
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (subcommand === 'add') {
    // A realm resolve plus a character lookup can exceed Discord's three-second
    // window.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await add(interaction);
    return;
  }

  if (subcommand === 'remove') {
    await interaction.reply({ content: remove(interaction), flags: MessageFlags.Ephemeral });
    return;
  }

  if (subcommand === 'forget') {
    const { removed } = forget(interaction.user.id);
    await interaction.reply({
      content:
        removed > 0
          ? `✅ Deleted ${removed} linked character(s). The bot now stores nothing about you.`
          : 'ℹ️ There was nothing stored about you.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const user = interaction.options.getUser('user') ?? interaction.user;

  await interaction.reply({
    embeds: [buildListEmbed(user.id, charactersFor(user.id))],
    flags: MessageFlags.Ephemeral
  });
}

module.exports = {
  data,
  help: 'Links your WoW characters to your Discord account for weekly reports.',
  category: 'WoW',
  // Everyone can claim their own characters; assigning somebody else's is a
  // moderator action, so it stays out of the public help post.
  adminSubcommands: ['manage'],
  buildListEmbed,
  characterLine,
  execute
};

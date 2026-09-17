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
  mainFor,
  setMain,
  unlinkCharacter
} = require('../../utils/reports/links');
const { loadConfig: loadNicknameConfig, saveConfig: saveNicknameConfig } = require('../../utils/nicknames/config');
const { planGuild, syncGuild, syncMember } = require('../../utils/nicknames/sync');
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
    sub
      .setName('main')
      .setDescription('Choose which of your characters you are known by.')
      .addStringOption(option =>
        option.setName('character').setDescription('Character name.').setRequired(true)
      )
      .addStringOption(option =>
        option.setName('realm').setDescription('Realm, if you have claimed the name twice.')
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
      )
      .addSubcommand(sub =>
        sub
          .setName('main')
          .setDescription('Set which character a member is known by.')
          .addUserOption(option =>
            option.setName('user').setDescription('Whose main to set.').setRequired(true)
          )
          .addStringOption(option =>
            option.setName('character').setDescription('Character name.').setRequired(true)
          )
          .addStringOption(option =>
            option.setName('realm').setDescription('Realm, if the name is linked twice.')
          )
      )
      .addSubcommand(sub =>
        sub
          .setName('nicknames')
          .setDescription('Whether nicknames are kept in step with main characters.')
          .addBooleanOption(option =>
            option.setName('value').setDescription('On or off.').setRequired(true)
          )
      )
      .addSubcommand(sub =>
        sub
          .setName('sync')
          .setDescription('Rename everyone to their main character.')
          .addBooleanOption(option =>
            option
              .setName('apply')
              .setDescription('Leave this off to preview who would be renamed.')
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

    // A first character becomes the main automatically, so this is usually
    // where somebody's nickname gets set.
    const note = describeNickname(await applyNickname(interaction, targetId));
    if (note) lines.push(note);

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

/**
 * Renames a member to their main, if nickname syncing is on.
 *
 * Best effort by design: a refusal is reported to whoever ran the command,
 * never raised as an error. Failing to rename somebody must not undo the
 * assignment that prompted it.
 */
async function applyNickname(interaction, userId) {
  if (!loadNicknameConfig().enabled) return null;

  try {
    const member = await interaction.guild?.members?.fetch(userId);
    return member ? await syncMember(interaction.guild, member) : null;
  } catch {
    // Not in the server, or not fetchable. Nothing to rename.
    return null;
  }
}

/** A one-line note about what happened to somebody's nickname. */
function describeNickname(plan) {
  if (!plan) return null;
  if (plan.action === 'rename') return `Nickname set to **${plan.to}**.`;
  if (plan.reason === 'already correct') return null;

  return `⚠️ Nickname not changed — ${plan.reason}.`;
}

/** Moves somebody's main, and renames them to match. */
async function changeMain(interaction, { targetId }) {
  const characterName = interaction.options.getString('character');
  const realm = interaction.options.getString('realm');
  const self = targetId === interaction.user.id;
  const who = self ? 'your' : `<@${targetId}>'s`;

  const { changed, reason, main } = setMain(targetId, { name: characterName, realm });

  if (!changed && reason === 'not-linked') {
    return `⚠️ **${characterName}** is not linked to ${self ? 'you' : `<@${targetId}>`}.`;
  }

  if (!changed && reason === 'already-main') {
    return `⚠️ **${main.name}** is already ${who} main.`;
  }

  const note = describeNickname(await applyNickname(interaction, targetId));

  return [`✅ **${main.name}** is now ${who} main.`, note].filter(Boolean).join(' ');
}

/** Assigning on somebody's behalf is a moderator action, not a self-service one. */
function isAdmin(interaction) {
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
}

/**
 * Renames everybody who has a main, or shows who would be renamed.
 *
 * Preview is the default and `apply:true` is the opt-in, because this changes
 * how every linked member appears to the whole server at once.
 */
async function syncEveryone(interaction) {
  let members;
  try {
    members = [...(await interaction.guild.members.fetch()).values()];
  } catch (err) {
    await interaction.editReply(`❌ Could not read the member list — ${err.message}`);
    return;
  }

  const apply = interaction.options.getBoolean('apply') ?? false;
  const plans = planGuild(interaction.guild, members);
  const due = plans.filter(plan => plan.action === 'rename');

  // 'already correct' is not worth reporting; a refusal is.
  const blocked = plans.filter(
    plan => plan.action === 'skip' && plan.reason !== 'already correct'
  );

  const lines = [];

  if (!apply) {
    lines.push(
      `👀 Preview — **${due.length}** member(s) would be renamed. Nothing has changed.`,
      'Re-run with `apply:true` to do it.'
    );
  } else {
    const { renamed } = await syncGuild(interaction.guild, members);
    lines.push(`✅ Renamed **${renamed.length}** member(s).`);
  }

  if (due.length > 0) {
    lines.push(
      '',
      due
        .slice(0, 15)
        .map(plan => `• ${plan.from ?? '_no nickname_'} → **${plan.to}**`)
        .join('\n') + (due.length > 15 ? `\n_…and ${due.length - 15} more_` : '')
    );
  }

  if (blocked.length > 0) {
    // The expected case, not an error: officers usually outrank the bot.
    lines.push(
      '',
      `⚠️ **${blocked.length}** could not be renamed:`,
      blocked
        .slice(0, 10)
        .map(plan => `• ${plan.member.displayName} — ${plan.reason}`)
        .join('\n') + (blocked.length > 10 ? `\n_…and ${blocked.length - 10} more_` : '')
    );
  }

  await interaction.editReply(lines.join('\n').slice(0, 2000));
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

    if (subcommand === 'nicknames') {
      const value = interaction.options.getBoolean('value');
      saveNicknameConfig({ enabled: value });

      await interaction.reply({
        content: value
          ? '✅ Nicknames will follow main characters from now on. Run `/iam manage sync` to ' +
            'apply it to everyone already linked.\n' +
            '_The bot cannot rename the server owner, or anyone whose highest role sits at or ' +
            'above its own — `sync` lists who it had to skip._'
          : '✅ Nicknames will be left alone. Existing ones are not reverted.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (subcommand === 'sync') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await syncEveryone(interaction);
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

    if (subcommand === 'main') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await interaction.editReply(await changeMain(interaction, { targetId: target.id }));
      return;
    }

    await interaction.reply({
      content: remove(interaction, { targetId: target.id }),
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (subcommand === 'main') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply(await changeMain(interaction, { targetId: interaction.user.id }));
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
  changeMain,
  describeNickname,
  buildListEmbed,
  characterLine,
  execute
};

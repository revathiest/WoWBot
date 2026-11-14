// commands/admin/adminrole.js
// /adminrole — grants or revokes admin-command access to a role, on top of
// Manage Server.
//
// This command always checks Manage Server directly rather than going through
// utils/permissions' isAdmin: a role this command grants must never be usable
// to grant further roles, so the gate here cannot itself be satisfied by one
// of the roles it manages.

const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');

const { addRole, getRoleIds, removeRole } = require('../../utils/adminRoles/config');
const { hasManageGuild } = require('../../utils/permissions');
const { FALLBACK_COLOR } = require('../../utils/wow');

const data = new SlashCommandBuilder()
  .setName('adminrole')
  .setDescription('Grant or revoke admin-command access to a role.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(sub =>
    sub
      .setName('add')
      .setDescription('Let everyone with this role run admin commands.')
      .addRoleOption(option =>
        option.setName('role').setDescription('Role to grant admin-command access to.').setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('remove')
      .setDescription('Revoke a role\'s admin-command access.')
      .addRoleOption(option =>
        option.setName('role').setDescription('Role to revoke.').setRequired(true)
      )
  )
  .addSubcommand(sub => sub.setName('list').setDescription('Show which roles can run admin commands.'));

function buildListEmbed(roleIds) {
  const embed = new EmbedBuilder().setTitle('Admin roles').setColor(FALLBACK_COLOR);

  embed.setDescription(
    roleIds.length > 0
      ? roleIds.map(id => `• <@&${id}>`).join('\n')
      : '_No extra roles configured — only Manage Server works._'
  );

  return embed;
}

async function execute(interaction) {
  if (!hasManageGuild(interaction)) {
    await interaction.reply({
      content: '❌ You need the Manage Server permission to use this.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'list') {
    await interaction.reply({
      embeds: [buildListEmbed(getRoleIds(interaction.guildId))],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const role = interaction.options.getRole('role');

  if (subcommand === 'add') {
    const roleIds = addRole(interaction.guildId, role.id);
    await interaction.reply({
      content: roleIds.includes(role.id)
        ? `✅ <@&${role.id}> can now run admin commands.`
        : `❌ Could not grant <@&${role.id}> admin-command access.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  // remove
  const before = getRoleIds(interaction.guildId);
  removeRole(interaction.guildId, role.id);

  await interaction.reply({
    content: before.includes(role.id)
      ? `✅ <@&${role.id}> can no longer run admin commands.`
      : `⚠️ <@&${role.id}> did not have admin-command access.`,
    flags: MessageFlags.Ephemeral
  });
}

module.exports = { data, execute, category: 'Admin' };

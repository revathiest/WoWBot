// utils/permissions.js
// The shared "is this member allowed to run an admin command" check.
//
// Manage Server (or Administrator) always passes. On top of that, a guild can
// name extra roles via /adminrole — anyone holding one of those also passes.
// /adminrole itself does not go through this: it checks Manage Server
// directly, so a role granted here can never be used to grant further roles.

const { PermissionFlagsBits } = require('discord.js');

const { getRoleIds } = require('./adminRoles/config');

/** The real permission boundary — Manage Server, ignoring any configured roles. */
function hasManageGuild(interaction) {
  return Boolean(
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
  );
}

/** Manage Server, or membership in one of the guild's configured admin roles. */
function isAdmin(interaction) {
  if (hasManageGuild(interaction)) return true;

  const roleIds = getRoleIds(interaction.guildId);
  if (roleIds.length === 0) return false;

  const memberRoles = interaction.member?.roles?.cache;
  if (!memberRoles) return false;

  return roleIds.some(roleId => memberRoles.has(roleId));
}

module.exports = { hasManageGuild, isAdmin };

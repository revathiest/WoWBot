// utils/voice/core.js
// "Join to create" private voice channels.
//
// Joining the configured trigger channel creates a brand-new voice channel,
// moves the member into it, and hands them elevated permissions scoped to
// that one channel — rename it, set a user limit, move or mute whoever else
// joins, lock it down entirely. Leaving it again — whether that is the owner
// stepping out while others stay, or the last person leaving an abandoned
// room — closes it. Deleting a voice channel disconnects everyone still in
// it, which is what "boots everyone" actually is: there is no separate kick
// step, the delete does it.

const { ChannelType, PermissionFlagsBits, PermissionsBitField } = require('discord.js');

const { record } = require('../audit/log');
const store = require('./store');

// Discord's channel name limit.
const CHANNEL_NAME_MAX = 100;

// What the owner can do inside their own room: everything short of touching
// anything outside it. ManageRoles here is channel-scoped — it is what lets
// them edit THIS channel's permission overwrites (lock it, block someone),
// not the server's roles.
const OWNER_PERMISSIONS = new PermissionsBitField([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
  PermissionFlagsBits.Stream,
  PermissionFlagsBits.UseVAD,
  PermissionFlagsBits.PrioritySpeaker,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.MoveMembers,
  PermissionFlagsBits.MuteMembers,
  PermissionFlagsBits.DeafenMembers
]);

// Just enough for the bot to create, move the owner in, and later delete it.
const BOT_PERMISSIONS = new PermissionsBitField([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.MoveMembers
]);

function buildChannelName(member) {
  const base = member.displayName || member.user?.username || 'Member';
  const name = `${base}'s Channel`;
  return name.length > CHANNEL_NAME_MAX ? name.slice(0, CHANNEL_NAME_MAX) : name;
}

/**
 * Permission overwrites for a new room: whatever `inheritFrom` already has
 * (so a private room matches the visibility of wherever it was spawned —
 * a public hangout stays public, a members-only lounge stays members-only),
 * plus the owner's extra control and the bot's own access layered on top.
 */
function buildOverwrites({ inheritFrom, botId, ownerId }) {
  const inherited = [...(inheritFrom?.permissionOverwrites?.cache?.values() ?? [])]
    .filter(overwrite => overwrite.id !== ownerId && overwrite.id !== botId)
    .map(overwrite => ({
      id: overwrite.id,
      type: overwrite.type,
      allow: overwrite.allow.bitfield,
      deny: overwrite.deny.bitfield
    }));

  return [
    ...inherited,
    { id: ownerId, allow: OWNER_PERMISSIONS.bitfield },
    { id: botId, allow: BOT_PERMISSIONS.bitfield }
  ];
}

/** Creates the private room, moves the member in, and records ownership. */
async function handleJoin(member, triggerChannel, settings) {
  const guild = member.guild;

  const category = settings.categoryId
    ? await guild.channels.fetch(settings.categoryId).catch(() => null)
    : triggerChannel.parent;

  // Nothing to copy from a root-level trigger with no configured category.
  const inheritFrom = category ?? (triggerChannel.parentId ? null : triggerChannel);

  let channel;
  try {
    channel = await guild.channels.create({
      name: buildChannelName(member),
      type: ChannelType.GuildVoice,
      parent: category?.id ?? null,
      permissionOverwrites: buildOverwrites({
        inheritFrom,
        botId: guild.client.user.id,
        ownerId: member.id
      }),
      reason: `Private voice channel for ${member.user?.tag ?? member.id}`
    });
  } catch (err) {
    console.warn(`⚠️  voice: could not create a channel for ${member.id}: ${err.message}`);
    return null;
  }

  try {
    await member.voice.setChannel(channel);
  } catch (err) {
    // They likely left before the channel finished creating; nothing to own.
    console.warn(`⚠️  voice: could not move ${member.id} into their channel: ${err.message}`);
    await channel.delete().catch(() => null);
    return null;
  }

  store.addActiveChannel(channel.id, { guildId: guild.id, ownerId: member.id });

  record(guild.client, {
    kind: 'voice',
    action: `opened a private voice channel (${channel.name})`,
    actorId: member.id,
    channelId: channel.id,
    category: 'Admin'
  });

  return channel;
}

/**
 * Closes a managed room once it should no longer exist: the owner left it
 * (even if others are still inside — it is their room), or it is simply
 * empty. Deleting it disconnects anyone left, which covers "boots everyone".
 */
async function handleLeave(oldState) {
  const channelId = oldState.channelId;
  if (!channelId) return;

  const managed = store.getActiveChannel(channelId);
  if (!managed) return;

  const leavingUserId = oldState.member?.id ?? oldState.id;
  const channel = oldState.channel;
  const ownerLeft = managed.ownerId === leavingUserId;
  const empty = !channel || (channel.members?.size ?? 0) === 0;

  if (!ownerLeft && !empty) return;

  store.removeActiveChannel(channelId);
  if (!channel) return;

  try {
    await channel.delete(ownerLeft ? 'Owner left their private voice channel' : 'Private voice channel emptied');
  } catch (err) {
    console.warn(`⚠️  voice: could not delete ${channelId}: ${err.message}`);
    return;
  }

  record(oldState.client, {
    kind: 'voice',
    action: ownerLeft
      ? 'closed a private voice channel (owner left)'
      : 'closed an empty private voice channel',
    channelId,
    category: 'Admin',
    automatic: true
  });
}

/** Whether this state change is an actual move into the trigger channel. */
function joinedTrigger(oldState, newState, settings) {
  return (
    Boolean(settings) &&
    newState.channelId === settings.triggerChannelId &&
    oldState.channelId !== newState.channelId
  );
}

async function handleVoiceStateUpdate(oldState, newState) {
  const guildId = newState.guild?.id ?? oldState.guild?.id;
  if (!guildId) return;

  // Cleanup first: leaving a managed room should close it even when the same
  // move also lands the member in the trigger channel.
  if (oldState.channelId && oldState.channelId !== newState.channelId) {
    await handleLeave(oldState);
  }

  const settings = store.getSettings(guildId);
  if (!joinedTrigger(oldState, newState, settings)) return;

  const member = newState.member;
  if (!member) return;

  const triggerChannel = newState.channel;
  if (!triggerChannel) return;

  await handleJoin(member, triggerChannel, settings);
}

module.exports = {
  BOT_PERMISSIONS,
  CHANNEL_NAME_MAX,
  OWNER_PERMISSIONS,
  buildChannelName,
  buildOverwrites,
  handleJoin,
  handleLeave,
  handleVoiceStateUpdate,
  joinedTrigger
};

// utils/help/post.js
// Publishing and maintaining the help post in its designated channel.
//
// The post is generated from the loaded commands, so it goes stale the moment a
// command is added, renamed, or removed. There is deliberately no refresh
// command: `publishHelp` runs on every startup and works out for itself which
// of three things to do.
//
//   UNCHANGED  The messages are all still there and the content fingerprint
//              matches, so nothing is written at all. This is the normal case
//              on a restart, and it is why booting the bot does not leave an
//              edit on a post nobody touched.
//
//   UPDATE     The messages are there but the content has changed, so each is
//              edited in place. Nothing moves, and message links keep working.
//
//   REPLACE    A message was deleted, or the number of sections changed because
//              a command was added or removed. The old messages are removed and
//              the whole post is published again.
//
// Replacing rather than patching a partial post matters because order is not
// editable: a message sent now lands at the bottom of the channel, so patching
// a hole in the middle would leave the sections out of order.

const store = require('./store');
const { buildHeaderEmbed, buildHelpMessages, buildToc, fingerprint } = require('./content');
const { lockChannel } = require('../channelLock');

/** Fetches every stored message, or null if any of them has gone. */
async function fetchExisting(channel, messageIds) {
  if (messageIds.length === 0) return null;

  const messages = [];

  for (const id of messageIds) {
    try {
      messages.push(await channel.messages.fetch(id));
    } catch {
      return null;
    }
  }

  return messages;
}

async function deleteAll(channel, messageIds) {
  for (const id of messageIds) {
    try {
      const message = await channel.messages.fetch(id);
      await message.delete();
    } catch {
      // Already gone, which is the outcome we wanted anyway.
    }
  }
}

/**
 * Rewrites the header so its jump links point at the sections that were
 * actually published. The header has to be posted before the sections exist, so
 * their ids are only knowable on a second pass.
 */
async function applyTableOfContents({ headerMessage, sections, commands, guild, channelId }) {
  if (!headerMessage || sections.length === 0) return;

  const toc = buildToc(sections, { guildId: guild.id, channelId });

  await headerMessage
    .edit({
      embeds: [buildHeaderEmbed(commands, { guildName: guild.name, toc, includeAdmin: false })]
    })
    .catch(err => console.warn(`⚠️  help: could not add the jump links — ${err.message}`));
}

/**
 * Creates or updates the whole help post.
 *
 * @returns {Promise<{ok: boolean, reason?: string, mode?: string, messageIds?: string[]}>}
 */
async function publishHelp(client, guildId, commands) {
  const settings = store.get(guildId);
  if (!settings) return { ok: false, reason: 'no help channel is configured' };

  let guild;
  try {
    guild = await client.guilds.fetch(guildId);
  } catch (err) {
    return { ok: false, reason: `guild is unreachable (${err.message})` };
  }

  let channel;
  try {
    channel = await guild.channels.fetch(settings.channelId);
  } catch (err) {
    return { ok: false, reason: `help channel could not be fetched (${err.message})` };
  }

  if (!channel?.isTextBased?.()) {
    return { ok: false, reason: 'the help channel is missing or is not a text channel' };
  }

  // The posted help lives in a channel the whole server can read, so the
  // admin-only commands are left out — see forAudience in content.js.
  const planned = buildHelpMessages(commands, { guildName: guild.name, includeAdmin: false });
  const stamp = fingerprint(planned);
  const existing = await fetchExisting(channel, settings.messageIds);

  // UNCHANGED: every message is still there and says what it should.
  if (existing && existing.length === planned.length && settings.fingerprint === stamp) {
    return { ok: true, mode: 'unchanged', messageIds: settings.messageIds };
  }

  // UPDATE: same shape as last time, so edit in place.
  if (existing && existing.length === planned.length) {
    const sections = [];

    for (const [index, message] of existing.entries()) {
      try {
        await message.edit({ embeds: planned[index].embeds });
      } catch (err) {
        return { ok: false, reason: `could not update the help post (${err.message})` };
      }

      if (index > 0) sections.push({ ...planned[index], messageId: message.id });
    }

    await applyTableOfContents({
      headerMessage: existing[0],
      sections,
      commands,
      guild,
      channelId: channel.id
    });

    const messageIds = existing.map(message => message.id);
    store.set(guildId, { messageIds, fingerprint: stamp });

    return { ok: true, mode: 'updated', messageIds };
  }

  // REPLACE: clear whatever is left and publish the post fresh, in order.
  await deleteAll(channel, settings.messageIds);

  const posted = [];
  try {
    for (const message of planned) {
      posted.push(await channel.send({ embeds: message.embeds }));
    }
  } catch (err) {
    // Record whatever did land so a retry can clean it up rather than
    // stacking a second partial post underneath.
    store.set(guildId, { messageIds: posted.map(message => message.id) });
    return { ok: false, reason: `could not post in the help channel (${err.message})` };
  }

  const sections = planned
    .slice(1)
    .map((message, index) => ({ ...message, messageId: posted[index + 1].id }));

  await applyTableOfContents({
    headerMessage: posted[0],
    sections,
    commands,
    guild,
    channelId: channel.id
  });

  const messageIds = posted.map(message => message.id);
  store.set(guildId, { messageIds, fingerprint: stamp });

  return { ok: true, mode: 'published', messageIds };
}

/**
 * Points the help post at a channel, locks it, and publishes.
 *
 * The lock goes on before the post so that nobody can slip a message in between
 * the two.
 */
async function setupHelpChannel(client, { guildId, channel, botId }) {
  const previous = store.get(guildId);

  // Moving the post leaves an orphan behind, and a stale command list is worse
  // than none — people trust whatever they find.
  if (previous && previous.channelId !== channel.id) {
    try {
      const oldChannel = await channel.guild.channels.fetch(previous.channelId);
      if (oldChannel) await deleteAll(oldChannel, previous.messageIds);
    } catch {
      // The old channel is gone; nothing to tidy.
    }
  }

  const lock = await lockChannel(channel, { botId, reason: 'Help channel: read-only' });

  // Clearing the fingerprint as well forces a fresh publish rather than a
  // no-op against whatever the old channel contained.
  store.set(guildId, { channelId: channel.id, messageIds: [], fingerprint: null });

  const post = await publishHelp(client, guildId, client.commands ?? new Map());

  return { lock, post };
}

/** Refreshes every configured help post. Used at startup. */
async function refreshAll(client, commands, { inScope = () => true } = {}) {
  const results = [];

  for (const guildId of store.guildIds()) {
    if (!inScope(guildId)) continue;

    const result = await publishHelp(client, guildId, commands);
    results.push({ guildId, ...result });

    if (!result.ok) {
      console.warn(`⚠️  help: could not refresh the post for guild ${guildId} — ${result.reason}`);
    }
  }

  return results;
}

module.exports = { deleteAll, fetchExisting, publishHelp, refreshAll, setupHelpChannel };

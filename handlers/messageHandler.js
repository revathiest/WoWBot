// handlers/messageHandler.js
// Spam pipeline. Mirrors handlers/interactionHandler.js: routing and decisions
// only, with the actual work delegated to utils/spam/*.

const { PermissionFlagsBits } = require('discord.js');
const detector = require('../utils/spam/detector');
const state = require('../utils/spam/state');
const enforcement = require('../utils/spam/enforcement');
const { buildAlertEmbed, sendAlert } = require('../utils/spam/alert');
const { loadConfig } = require('../utils/spam/config');
const { isGuildInScope } = require('../utils/guildScope');
const { readConfig } = require('../config');

/**
 * Reasons to ignore a message outright, cheapest first.
 * @returns {string|null} why it was skipped, or null to carry on
 */
function exemptionFor(message, config) {
  if (!message.guild) return 'not a guild message';

  // Same scoping as interactions: a dedicated instance moderates only its guild,
  // so two deployments never both act on the same message.
  if (!isGuildInScope(message.guild.id, readConfig().discord.guildId)) {
    return 'outside the guild this instance serves';
  }

  if (message.author?.bot) return 'author is a bot';
  if (!config.enabled) return 'spam detection disabled';

  const channelId = message.channel?.id ?? message.channelId;
  if (config.exemptChannelIds.includes(channelId)) return 'exempt channel';

  const member = message.member;
  if (!member) return 'member not cached';

  if (config.exemptRoleIds.some(roleId => member.roles?.cache?.has(roleId))) {
    return 'exempt role';
  }

  // Moderators are trusted. The module this is modelled on has no such bypass,
  // so a mod posting quickly during an event could be actioned.
  if (member.permissions?.has?.(PermissionFlagsBits.ManageMessages)) {
    return 'member can manage messages';
  }

  return null;
}

/** Shared tail: act, alert, and forget the user's counters. */
async function enforce({ message, member, decision, tier, signals, client }) {
  const reason = detector.buildReason({
    reasonPrefix: decision.reasonPrefix,
    tier,
    signals
  });

  const outcome = await enforcement.act({
    message,
    member,
    decision: { ...decision, reason }
  });

  const embed = buildAlertEmbed({
    message,
    member,
    decision,
    outcome,
    tier,
    signals,
    accountAge: detector.accountAgeDays(member),
    tenure: detector.tenureDays(member)
  });

  await sendAlert({
    client: client ?? message.client,
    channelId: loadConfig().alertChannelId,
    embed
  });

  // Counters are meaningless once the member is banned or muted, and leaving
  // them behind is how the original grows memory forever.
  state.clearUserState(message.guild.id, member.id);

  console.log(
    `🛡️  ${outcome.acted ? outcome.action : 'no action'} for ${member.id}: ${reason}`
  );

  return outcome;
}

/** New messages: every signal, including the rate and repetition windows. */
async function handleMessageCreate(message) {
  const config = loadConfig();

  const exemption = exemptionFor(message, config);
  if (exemption) return null;

  const now = Date.now();

  state.record({
    guildId: message.guild.id,
    userId: message.author.id,
    channelId: message.channel?.id ?? message.channelId,
    content: message.content ?? '',
    now
  });

  state.sweepIfDue(now);

  const signals = detector.collectSignals({ message, config, now });
  if (signals.length === 0) return null;

  const member = message.member;
  const tier = detector.getTrustTier(member, config, now);
  const decision = detector.decide({ tier, signals, config });

  if (!decision) return null;

  return enforce({ message, member, decision, tier, signals, client: message.client });
}

/**
 * Edits: content signals only. Editing a benign message into a scam link is a
 * known evasion, but the rate and duplicate windows must not move — an edit is
 * not a new message.
 */
async function handleMessageUpdate(_oldMessage, newMessage) {
  const message = newMessage;
  if (!message) return null;

  const config = loadConfig();

  const exemption = exemptionFor(message, config);
  if (exemption) return null;

  const signals = detector.collectContentSignals({ message, config });
  if (signals.length === 0) return null;

  const member = message.member;
  const tier = detector.getTrustTier(member, config);
  const decision = detector.decide({ tier, signals, config });

  if (!decision) return null;

  return enforce({ message, member, decision, tier, signals, client: message.client });
}

/** Wraps a handler so a thrown error can never take the process down. */
function guard(handler, label) {
  return async (...args) => {
    try {
      await handler(...args);
    } catch (err) {
      console.error(`❌ Error in ${label}:`, err);
    }
  };
}

/** Wires both listeners. `Events` is injected, matching registerInteractionHandler. */
function registerMessageHandler(client, Events) {
  client.on(Events.MessageCreate, guard(handleMessageCreate, 'messageCreate'));
  client.on(Events.MessageUpdate, guard(handleMessageUpdate, 'messageUpdate'));
}

module.exports = {
  exemptionFor,
  handleMessageCreate,
  handleMessageUpdate,
  registerMessageHandler
};

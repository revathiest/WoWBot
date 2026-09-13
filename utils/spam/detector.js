// utils/spam/detector.js
// The six spam signals and the trust model.
//
// This module never imports discord.js. It reads plain fields off
// message-shaped and member-shaped objects, which is what lets the tests build
// fixtures as object literals instead of mocking a Discord client.

const state = require('./state');
const { hasInviteLink, matchPatterns } = require('./patterns');

const TRUST = {
  SUSPICIOUS: 'suspicious',
  STANDARD: 'standard',
  ESTABLISHED: 'established'
};

const DAY_MS = 24 * 60 * 60 * 1000;

// Content shorter than this is too common to judge — "lol" repeated is not spam.
const MIN_DUPLICATE_LENGTH = 10;

/** 5 messages in 5 seconds, by default. Counts the current message. */
function checkRateLimit({ guildId, userId, count, windowMs, now = Date.now() }) {
  return state.timesWithin(guildId, userId, windowMs, now).length >= count;
}

/** The same text repeated within the window. */
function checkDuplicates({ guildId, userId, content, threshold, windowMs, now = Date.now() }) {
  const normalized = state.normalize(content);
  if (normalized.length < MIN_DUPLICATE_LENGTH) return false;

  const matches = state
    .messagesWithin(guildId, userId, windowMs, now)
    .filter(message => message.content === normalized);

  return matches.length >= threshold;
}

/** The same text in several channels — the signature of a spam sweep. */
function checkCrossChannel({ guildId, userId, content, threshold, windowMs, now = Date.now() }) {
  const normalized = state.normalize(content);
  if (normalized.length < MIN_DUPLICATE_LENGTH) return false;

  const channels = new Set(
    state
      .messagesWithin(guildId, userId, windowMs, now)
      .filter(message => message.content === normalized)
      .map(message => message.channelId)
  );

  return channels.size >= threshold;
}

/** Pinging a crowd. Reads only `.size`, so fixtures stay trivial. */
function checkMentions(message, threshold) {
  const users = message?.mentions?.users?.size ?? 0;
  const roles = message?.mentions?.roles?.size ?? 0;
  return users + roles >= threshold;
}

/**
 * Runs every signal and returns the human-readable reasons that fired.
 * The caller counts them; there is no weighting.
 */
function collectSignals({ message, config, now = Date.now() }) {
  const content = message.content ?? '';
  const guildId = message.guild?.id;
  const userId = message.author?.id;
  const channelId = message.channel?.id ?? message.channelId;
  const signals = [];

  if (
    checkRateLimit({
      guildId,
      userId,
      count: config.rateLimit.count,
      windowMs: config.rateLimit.windowMs,
      now
    })
  ) {
    signals.push(
      `rate limit (${config.rateLimit.count} msgs / ${Math.round(config.rateLimit.windowMs / 1000)}s)`
    );
  }

  if (
    checkDuplicates({
      guildId,
      userId,
      content,
      threshold: config.duplicateThreshold,
      windowMs: config.duplicateWindowMs,
      now
    })
  ) {
    signals.push(`repeated the same message ${config.duplicateThreshold}+ times`);
  }

  if (
    checkCrossChannel({
      guildId,
      userId,
      content,
      threshold: config.crossChannelThreshold,
      windowMs: config.duplicateWindowMs,
      now
    })
  ) {
    signals.push(`same message across ${config.crossChannelThreshold}+ channels`);
  }

  // Each matching category is its own signal, so a message can be damning on
  // content alone.
  for (const category of matchPatterns(content)) {
    signals.push(`spam pattern: ${category}`);
  }

  if (checkMentions(message, config.mentionThreshold)) {
    signals.push(`mass mention (${config.mentionThreshold}+)`);
  }

  if (hasInviteLink(content)) {
    signals.push('Discord invite link');
  }

  void channelId;
  return signals;
}

/** Content-only signals, for message edits where the windows should not move. */
function collectContentSignals({ message, config }) {
  const content = message.content ?? '';
  const signals = matchPatterns(content).map(category => `spam pattern: ${category}`);

  if (checkMentions(message, config.mentionThreshold)) {
    signals.push(`mass mention (${config.mentionThreshold}+)`);
  }

  if (hasInviteLink(content)) {
    signals.push('Discord invite link');
  }

  return signals;
}

/**
 * How much benefit of the doubt this member gets.
 *
 * A missing joinedTimestamp means zero tenure, which lands on suspicious. That
 * is the safe direction: an unknown member is treated as new.
 */
function getTrustTier(member, config, now = Date.now()) {
  const createdAt = member?.user?.createdTimestamp ?? 0;
  const joinedAt = member?.joinedTimestamp ?? 0;

  const accountAgeDays = (now - createdAt) / DAY_MS;
  const tenureDays = joinedAt ? (now - joinedAt) / DAY_MS : 0;

  if (accountAgeDays < config.newAccountDays || tenureDays < 1) return TRUST.SUSPICIOUS;
  if (tenureDays >= config.establishedDays) return TRUST.ESTABLISHED;
  return TRUST.STANDARD;
}

/** Signals required before acting, per tier. */
function getRequiredSignals(tier, threshold) {
  if (tier === TRUST.SUSPICIOUS) return 1;
  if (tier === TRUST.ESTABLISHED) return threshold + 1;
  return threshold;
}

/**
 * Decides what to do. Returns null when nothing should happen.
 *
 * The `compromise` verdict is the interesting one: an established member who
 * trips the ordinary threshold but not their raised one is far more likely to
 * have been hacked than to be a spambot, so they get the gentler action.
 */
function decide({ tier, signals, config }) {
  const required = getRequiredSignals(tier, config.signalThreshold);

  if (signals.length >= required) {
    return {
      verdict: 'spam',
      action: config.action,
      durationMs: config.timeoutMs,
      reasonPrefix: 'Spam detection'
    };
  }

  if (tier === TRUST.ESTABLISHED && signals.length >= config.signalThreshold) {
    return {
      verdict: 'compromise',
      action: config.secondaryAction,
      durationMs: config.secondaryTimeoutMs,
      reasonPrefix: 'Possible account compromise'
    };
  }

  return null;
}

/** The audit string recorded on the ban or timeout. */
function buildReason({ reasonPrefix, tier, signals }) {
  return `${reasonPrefix} [${tier}]: ${signals.join('; ')}`;
}

function accountAgeDays(member, now = Date.now()) {
  const createdAt = member?.user?.createdTimestamp ?? 0;
  return createdAt ? Math.floor((now - createdAt) / DAY_MS) : 0;
}

function tenureDays(member, now = Date.now()) {
  const joinedAt = member?.joinedTimestamp ?? 0;
  return joinedAt ? Math.floor((now - joinedAt) / DAY_MS) : 0;
}

module.exports = {
  DAY_MS,
  MIN_DUPLICATE_LENGTH,
  TRUST,
  accountAgeDays,
  buildReason,
  checkCrossChannel,
  checkDuplicates,
  checkMentions,
  checkRateLimit,
  collectContentSignals,
  collectSignals,
  decide,
  getRequiredSignals,
  getTrustTier,
  tenureDays
};

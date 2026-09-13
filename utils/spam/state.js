// utils/spam/state.js
// Per-user sliding windows used to spot rate and repetition. Everything here is
// in memory and lost on restart, which is deliberate: this is short-horizon
// behaviour, not a punishment record.
//
// Follows the TTL approach in utils/blizzard/realms.js — absolute timestamps
// compared against Date.now(), never setTimeout — so tests can fast-forward with
// jest.spyOn(Date, 'now').

// How often the housekeeping sweep is allowed to run.
const SWEEP_INTERVAL_MS = 60 * 1000;

// An entry older than this is useless to every check, so it can be dropped.
const MAX_RETENTION_MS = 5 * 60 * 1000;

const messageTimes = new Map(); // key -> number[]
const recentMessages = new Map(); // key -> { content, channelId, timestamp }[]

let lastSweep = 0;

function stateKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

/** Normalizes content so trivial edits do not defeat the duplicate checks. */
function normalize(content) {
  return String(content ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Records a message and returns the pruned windows for it. */
function record({ guildId, userId, channelId, content, now = Date.now() }) {
  const key = stateKey(guildId, userId);

  const times = (messageTimes.get(key) ?? []).filter(t => now - t < MAX_RETENTION_MS);
  times.push(now);
  messageTimes.set(key, times);

  const messages = (recentMessages.get(key) ?? []).filter(m => now - m.timestamp < MAX_RETENTION_MS);
  messages.push({ content: normalize(content), channelId, timestamp: now });
  recentMessages.set(key, messages);

  return { times, messages };
}

/** Message timestamps within `windowMs`. */
function timesWithin(guildId, userId, windowMs, now = Date.now()) {
  const times = messageTimes.get(stateKey(guildId, userId)) ?? [];
  return times.filter(t => now - t < windowMs);
}

/** Recent messages within `windowMs`. */
function messagesWithin(guildId, userId, windowMs, now = Date.now()) {
  const messages = recentMessages.get(stateKey(guildId, userId)) ?? [];
  return messages.filter(m => now - m.timestamp < windowMs);
}

/** Forgets one user. Called after acting on them, and by tests. */
function clearUserState(guildId, userId) {
  const key = stateKey(guildId, userId);
  messageTimes.delete(key);
  recentMessages.delete(key);
}

/** Forgets everyone. Tests only. */
function clearAllState() {
  messageTimes.clear();
  recentMessages.clear();
  lastSweep = 0;
}

/**
 * Drops keys whose entries have all aged out. Without this the maps keep one
 * entry per user who has ever spoken, forever — the flaw in the module this is
 * modelled on.
 */
function sweep(now = Date.now()) {
  let removed = 0;

  for (const [key, times] of messageTimes) {
    if (times.every(t => now - t >= MAX_RETENTION_MS)) {
      messageTimes.delete(key);
      removed += 1;
    }
  }

  for (const [key, messages] of recentMessages) {
    if (messages.every(m => now - m.timestamp >= MAX_RETENTION_MS)) {
      recentMessages.delete(key);
    }
  }

  lastSweep = now;
  return removed;
}

/** Time-gated sweep, so the caller can invoke it on every message cheaply. */
function sweepIfDue(now = Date.now()) {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return 0;
  return sweep(now);
}

/** Tests and diagnostics. */
function stateSize() {
  return { users: messageTimes.size, messageLists: recentMessages.size };
}

module.exports = {
  MAX_RETENTION_MS,
  SWEEP_INTERVAL_MS,
  clearAllState,
  clearUserState,
  messagesWithin,
  normalize,
  record,
  stateKey,
  stateSize,
  sweep,
  sweepIfDue,
  timesWithin
};

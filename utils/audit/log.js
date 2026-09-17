// utils/audit/log.js
// Writing the audit feed.
//
// Plain text lines rather than embeds: a log is read by scanning down it, and
// twenty embeds in a row is a wall of boxes. One line per action, newest at the
// bottom, the way a log should read.
//
// Entries are BUFFERED and flushed together. Discord allows roughly five
// messages per five seconds per channel, and a command that triggers several
// actions would otherwise burn straight through that and start dropping the
// very record it is meant to keep. Buffering also turns a burst of activity
// into one readable block instead of a stack of one-line messages.

const { shouldLog, loadConfig } = require('./config');

// Long enough to batch a burst, short enough that the log feels live.
const FLUSH_INTERVAL_MS = 3000;

// Discord's message limit is 2000; leave room for the final newline.
const MAX_MESSAGE_LENGTH = 1900;

const queue = [];
let timer = null;
let clientRef = null;

const ICONS = {
  command: '⌨️',
  button: '🖱️',
  config: '🔧',
  moderation: '🛡️',
  ticket: '🎫',
  report: '📊',
  kick: '🥾',
  error: '❌',
  info: 'ℹ️'
};

/** `<t:1700000000:T>` — a short, locale-aware clock for each line. */
function timestamp(at) {
  return `<t:${Math.floor(at / 1000)}:T>`;
}

/**
 * One log line.
 *
 * Mentions are rendered but suppressed at send time, so the log reads as names
 * without pinging anybody every time somebody runs a command.
 */
function formatEntry(entry) {
  const icon = ICONS[entry.kind] ?? ICONS.info;
  const who = entry.actorId ? `<@${entry.actorId}>` : 'the bot';
  const where = entry.channelId ? ` in <#${entry.channelId}>` : '';
  const outcome = entry.ok === false ? ' — ❌ failed' : '';
  const detail = entry.detail ? ` — ${entry.detail}` : '';

  return `${timestamp(entry.at)} ${icon} ${who} ${entry.action}${where}${detail}${outcome}`;
}

/** Packs queued lines into as few messages as Discord's limit allows. */
function packLines(lines, limit = MAX_MESSAGE_LENGTH) {
  const messages = [];
  let current = [];
  let length = 0;

  for (const line of lines) {
    // A single line longer than the limit would loop forever; truncate it.
    const safe = line.length > limit ? `${line.slice(0, limit - 1)}…` : line;

    if (current.length > 0 && length + safe.length + 1 > limit) {
      messages.push(current.join('\n'));
      current = [];
      length = 0;
    }

    current.push(safe);
    length += safe.length + 1;
  }

  if (current.length > 0) messages.push(current.join('\n'));

  return messages;
}

async function flush() {
  timer = null;

  if (queue.length === 0 || !clientRef) return;

  const config = loadConfig();
  const lines = queue.splice(0, queue.length).map(formatEntry);

  if (!config.channelId) return;

  try {
    const channel = await clientRef.channels.fetch(config.channelId);

    if (!channel?.isTextBased?.()) {
      console.warn(`⚠️  audit: channel ${config.channelId} is not a text channel.`);
      return;
    }

    for (const content of packLines(lines)) {
      await channel.send({
        content,
        // The log names people constantly; pinging them would make it unusable.
        allowedMentions: { parse: [] }
      });
    }
  } catch (err) {
    // Logging must never break the thing it is logging.
    console.warn(`⚠️  audit: could not write to the log channel — ${err.message}`);
  }
}

/**
 * Records an action.
 *
 * Never throws and never awaits the send: callers are in the middle of doing
 * something more important than logging it.
 *
 * @param {object} client
 * @param {object} entry
 * @param {string} entry.kind      One of ICONS.
 * @param {string} entry.action    What happened, as a sentence fragment.
 * @param {string} [entry.actorId] Who did it; omitted for the bot's own actions.
 * @param {string} [entry.detail]  Extra context.
 * @param {string} [entry.category] The command's category, for verbosity filtering.
 * @param {boolean} [entry.automatic] True when the bot acted unprompted.
 * @param {boolean} [entry.ok]     False to mark the action as failed.
 */
function record(client, entry) {
  const full = { at: Date.now(), ...entry };

  if (!shouldLog(full)) return false;

  clientRef = client;
  queue.push(full);

  if (!timer) {
    timer = setTimeout(() => {
      flush().catch(err => console.warn(`⚠️  audit: flush failed — ${err.message}`));
    }, FLUSH_INTERVAL_MS);

    timer.unref?.();
  }

  return true;
}

/** Describes a slash command the way it was typed, for the log line. */
function describeCommand(interaction) {
  const group = interaction.options?.getSubcommandGroup?.(false);
  const subcommand = (() => {
    try {
      return interaction.options?.getSubcommand?.(false);
    } catch {
      // Commands with no subcommands throw rather than returning null.
      return null;
    }
  })();

  return ['/' + interaction.commandName, group, subcommand].filter(Boolean).join(' ');
}

/** Tests, and shutdown. */
function reset() {
  queue.length = 0;
  if (timer) clearTimeout(timer);
  timer = null;
  clientRef = null;
}

module.exports = {
  FLUSH_INTERVAL_MS,
  ICONS,
  MAX_MESSAGE_LENGTH,
  describeCommand,
  flush,
  formatEntry,
  packLines,
  record,
  reset
};

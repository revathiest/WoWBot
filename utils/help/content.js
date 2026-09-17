// utils/help/content.js
// The help post, built from the commands that are actually loaded.
//
// Nothing here is hand-maintained. Every command already exports `help` and
// `category` (see AGENTS.md), so the post is generated from the live command
// map — a new command appears in it on the next restart, and a removed one
// disappears. A hand-written list would be wrong within a month.
//
// The output is a LIST OF MESSAGES, one per category, rather than a single
// message. Partly because it has to be — Discord allows 6000 characters and 25
// fields per embed — but mostly because it reads better: a reader looking for
// an admin command should not have to scroll past eleven lookup commands. The
// first message carries jump links to the rest, which is what keeps several
// posts navigable instead of just long.

const crypto = require('crypto');

const { EmbedBuilder } = require('discord.js');

const { FALLBACK_COLOR } = require('../wow');

// Discord's hard limits.
const MAX_FIELD_LENGTH = 1024;
const MAX_FIELDS = 25;
const MAX_EMBED_LENGTH = 6000;

// Categories in the order people care about; anything else follows.
const CATEGORY_ORDER = ['WoW', 'Help', 'Admin'];

/**
 * Categories nobody without Manage Server can use.
 *
 * These are left out of the posted help, which sits in a channel the whole
 * server reads: a list of commands that answer "you need the Manage Server
 * permission" is noise to almost everyone looking at it. They still appear in
 * `/help show` for the people who can actually run them.
 */
const ADMIN_CATEGORIES = ['Admin'];

const CATEGORY_STYLE = {
  WoW: {
    emoji: '⚔️',
    color: 0xc41e3a,
    blurb: 'Look up characters, guilds, realms, and items. Anyone can use these.'
  },
  Help: { emoji: 'ℹ️', color: 0x5865f2, blurb: 'Finding your way around.' },
  Admin: {
    emoji: '🛠️',
    color: 0xff8c00,
    blurb: 'Server setup. These need the **Manage Server** permission.'
  },
  Other: { emoji: '📦', color: FALLBACK_COLOR, blurb: null }
};

function styleFor(category) {
  return CATEGORY_STYLE[category] ?? CATEGORY_STYLE.Other;
}

/** Subcommands and groups declared on a command, as `{name, description}`. */
function subcommandsOf(command) {
  const options = command?.data?.toJSON?.().options ?? [];

  return options.flatMap(option => {
    // 1 is SUB_COMMAND, 2 is SUB_COMMAND_GROUP.
    if (option.type === 1) return [{ name: option.name, description: option.description }];

    if (option.type === 2) {
      return (option.options ?? []).map(child => ({
        name: `${option.name} ${child.name}`,
        description: child.description
      }));
    }

    return [];
  });
}

function truncate(value, limit) {
  const text = String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * Whether a subcommand is one only admins can run.
 *
 * A command can be public overall while some of its subcommands are not:
 * `/iam` is for everybody but `/iam manage assign` is not, and `/help show` is
 * for everybody but `/help setup` is not. Commands declare those by exporting
 * `adminSubcommands`, matched on the leading segment so naming a whole group
 * covers everything inside it.
 */
function isAdminSubcommand(command, subcommandName) {
  const admin = command.adminSubcommands ?? [];
  return admin.some(entry => subcommandName === entry || subcommandName.startsWith(`${entry} `));
}

/**
 * One command as an embed field: what it does, then how it breaks down.
 *
 * Subcommands are what make a command like /report or /ticket usable at all —
 * "Configures the guild report" tells nobody where to start. They are indented
 * with an em space so the eye can separate them from the description without a
 * bullet character fighting the command names.
 */
function commandField(name, command, { includeAdmin = true } = {}) {
  const description = command.help ?? command.data?.description ?? 'No description.';

  const subcommands = subcommandsOf(command).filter(
    sub => includeAdmin || !isAdminSubcommand(command, sub.name)
  );

  const lines = [description];

  if (subcommands.length > 0) {
    lines.push(...subcommands.map(sub => ` \`${sub.name}\` — ${sub.description}`));
  }

  return { name: `/${name}`, value: truncate(lines.join('\n'), MAX_FIELD_LENGTH) };
}

/** Drops the commands an audience cannot use. */
function forAudience(commands, { includeAdmin = true } = {}) {
  if (includeAdmin) return commands;

  return new Map(
    [...commands].filter(([, command]) => !ADMIN_CATEGORIES.includes(command.category))
  );
}

/** Groups loaded commands by category, each sorted by name. */
function groupByCategory(commands) {
  const groups = new Map();

  for (const [name, command] of commands) {
    const category = command.category ?? 'Other';
    groups.set(category, [...(groups.get(category) ?? []), [name, command]]);
  }

  for (const entries of groups.values()) {
    entries.sort(([a], [b]) => a.localeCompare(b));
  }

  return [...groups.entries()].sort(([a], [b]) => {
    const rank = category => {
      const index = CATEGORY_ORDER.indexOf(category);
      return index === -1 ? CATEGORY_ORDER.length : index;
    };

    return rank(a) - rank(b) || a.localeCompare(b);
  });
}

/** What Discord counts towards the 6000-character embed budget. */
function embedLength(embed) {
  const json = typeof embed.toJSON === 'function' ? embed.toJSON() : embed;

  const fields = (json.fields ?? []).reduce(
    (sum, field) => sum + String(field.name ?? '').length + String(field.value ?? '').length,
    0
  );

  return (
    String(json.title ?? '').length +
    String(json.description ?? '').length +
    String(json.footer?.text ?? '').length +
    fields
  );
}

/** `https://discord.com/channels/<guild>/<channel>/<message>` */
function messageLink({ guildId, channelId, messageId }) {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

/**
 * The opening message: what the bot is, the options every command shares, and
 * jump links to the section posts below it.
 *
 * `toc` is empty on the first pass, because the sections have not been posted
 * yet and have no ids to link to. The caller republishes this embed once they
 * do — see `post.js`.
 */
function buildHeaderEmbed(commands, { guildName = null, toc = [], includeAdmin = true } = {}) {
  const visible = forAudience(commands, { includeAdmin });

  const embed = new EmbedBuilder()
    .setColor(FALLBACK_COLOR)
    .setTitle(guildName ? `${guildName} — Bot Commands` : 'Bot Commands')
    .setDescription(
      'Everything this bot can do. Type `/` in any channel and start typing a command name — ' +
        'Discord prompts you for whatever each one needs.'
    );

  if (toc.length > 0) {
    embed.addFields({
      name: '📖 Jump to',
      value: toc
        .map(
          entry =>
            `**[${entry.emoji} ${entry.label}](${entry.url})** — ` +
            `${entry.count} command${entry.count === 1 ? '' : 's'}`
        )
        .join('\n')
    });
  }

  embed.addFields(
    {
      name: '🌍 Shared options',
      value:
        'Most commands take an optional **region** (US, EU, KR, TW) and **game** version ' +
        '(Retail, TBC Anniversary, Classic, Classic Era). Leave them out and this server\'s ' +
        'defaults are used, so you rarely need to touch them.'
    },
    {
      name: '❓ One command at a time',
      value: 'Run `/help show command:<name>` anywhere for a breakdown of a single command.'
    }
  );

  return embed.setFooter({ text: `${visible.size} commands available` });
}

/**
 * One message per category, split further only if a category overflows a single
 * embed. Each entry carries the metadata the table of contents needs.
 *
 * @returns {{label: string, emoji: string, count: number, embeds: object[]}[]}
 */
function buildSectionMessages(commands, { includeAdmin = true } = {}) {
  const sections = [];

  for (const [category, entries] of groupByCategory(forAudience(commands, { includeAdmin }))) {
    const style = styleFor(category);
    const embeds = [];

    let embed = null;
    let part = 0;

    const startEmbed = () => {
      part += 1;
      embed = new EmbedBuilder()
        .setColor(style.color)
        .setTitle(`${style.emoji} ${category}${part > 1 ? ' (continued)' : ''}`);

      if (part === 1 && style.blurb) embed.setDescription(style.blurb);

      embeds.push(embed);
    };

    startEmbed();

    for (const [name, command] of entries) {
      const field = commandField(name, command, { includeAdmin });
      const fieldCount = (embed.toJSON().fields ?? []).length;

      const overflows =
        fieldCount >= MAX_FIELDS ||
        embedLength(embed) + field.name.length + field.value.length > MAX_EMBED_LENGTH;

      if (overflows) startEmbed();

      embed.addFields(field);
    }

    sections.push({ label: category, emoji: style.emoji, count: entries.length, embeds });
  }

  return sections;
}

/**
 * The whole post, as a list of messages to publish in order.
 *
 * The first is the header; the rest are one section each.
 */
function buildHelpMessages(commands, { guildName = null, toc = [], includeAdmin = true } = {}) {
  return [
    {
      label: 'Overview',
      emoji: '📖',
      embeds: [buildHeaderEmbed(commands, { guildName, toc, includeAdmin })]
    },
    ...buildSectionMessages(commands, { includeAdmin })
  ];
}

/** Turns published section messages into jump-link entries for the header. */
function buildToc(sections, { guildId, channelId }) {
  return sections.map(section => ({
    label: section.label,
    emoji: section.emoji,
    count: section.count,
    url: messageLink({ guildId, channelId, messageId: section.messageId })
  }));
}

/**
 * A fingerprint of the generated post.
 *
 * Stored alongside the message ids so a restart can tell whether the commands
 * have actually changed. Without it every boot would rewrite every message,
 * which is a handful of pointless API calls and an edit timestamp on a post
 * nobody touched.
 *
 * Computed from the content WITHOUT the table of contents, whose links contain
 * message ids that do not exist on the first pass — including them would make
 * the fingerprint differ from itself.
 */
function fingerprint(messages) {
  const content = JSON.stringify(
    messages.map(message => message.embeds.map(embed => embed.toJSON()))
  );

  return crypto.createHash('sha1').update(content).digest('hex');
}

/** One command in detail, for `/help show command:<name>`. */
function buildCommandEmbed(name, command) {
  const style = styleFor(command.category);

  const embed = new EmbedBuilder()
    .setColor(style.color)
    .setTitle(`/${name}`)
    .setDescription(command.help ?? command.data?.description ?? 'No description.');

  const subcommands = subcommandsOf(command);

  if (subcommands.length > 0) {
    embed.addFields({
      name: 'Subcommands',
      value: truncate(
        subcommands.map(sub => `\`/${name} ${sub.name}\`\n ${sub.description}`).join('\n'),
        MAX_FIELD_LENGTH
      )
    });
  }

  if (command.category) embed.setFooter({ text: command.category });

  return embed;
}

module.exports = {
  ADMIN_CATEGORIES,
  CATEGORY_ORDER,
  CATEGORY_STYLE,
  MAX_EMBED_LENGTH,
  MAX_FIELDS,
  MAX_FIELD_LENGTH,
  buildCommandEmbed,
  buildHeaderEmbed,
  buildHelpMessages,
  buildSectionMessages,
  buildToc,
  commandField,
  embedLength,
  fingerprint,
  forAudience,
  groupByCategory,
  isAdminSubcommand,
  messageLink,
  styleFor,
  subcommandsOf,
  truncate
};

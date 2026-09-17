// utils/embeds.js
// Fitting arbitrary amounts of content into Discord's embed limits.
//
// Discord enforces four separate caps, and exceeding any one of them rejects
// the whole message rather than trimming it:
//
//   1024  characters per field value
//     25  fields per embed
//   6000  characters per embed, counting titles, descriptions and footers
//     10  embeds per message, and 6000 characters across all of them
//
// Anything that lists a guild roster runs into all four, so the packing lives
// here rather than being reinvented per feature.

const MAX_FIELD_LENGTH = 1024;
const MAX_FIELDS_PER_EMBED = 25;
const MAX_EMBED_LENGTH = 6000;
const MAX_EMBEDS_PER_MESSAGE = 10;
const MAX_MESSAGE_LENGTH = 6000;

/** What Discord counts towards the per-embed and per-message budgets. */
function embedLength(embed) {
  const json = typeof embed?.toJSON === 'function' ? embed.toJSON() : embed ?? {};

  const fields = (json.fields ?? []).reduce(
    (sum, field) => sum + String(field.name ?? '').length + String(field.value ?? '').length,
    0
  );

  return (
    String(json.title ?? '').length +
    String(json.description ?? '').length +
    String(json.footer?.text ?? '').length +
    String(json.author?.name ?? '').length +
    fields
  );
}

/**
 * Splits lines into field-sized values.
 *
 * `maxLines` exists on top of the character cap so a caller can ask for short
 * columns — three narrow fields sit side by side in Discord, and that only
 * looks like a column if the chunks are a similar, modest length.
 */
function chunkLines(lines, { maxLines = Infinity, limit = MAX_FIELD_LENGTH } = {}) {
  const chunks = [];
  let current = [];
  let length = 0;

  for (const line of lines) {
    const safe = line.length > limit ? `${line.slice(0, limit - 1)}…` : line;

    if (current.length > 0 && (current.length >= maxLines || length + safe.length + 1 > limit)) {
      chunks.push(current);
      current = [];
      length = 0;
    }

    current.push(safe);
    length += safe.length + 1;
  }

  if (current.length > 0) chunks.push(current);

  return chunks;
}

/**
 * Turns lines into embed fields.
 *
 * Only the first chunk carries the heading; the rest get a zero-width name so
 * the sections read as one continuous list instead of repeating a header. That
 * is what makes `inline` chunks look like columns of a single table rather than
 * several small tables.
 */
function toFields(label, lines, { inline = false, maxLines = Infinity } = {}) {
  return chunkLines(lines, { maxLines }).map((chunk, index) => ({
    name: index === 0 ? label : '​',
    value: chunk.join('\n'),
    inline
  }));
}

/**
 * Distributes fields across as many embeds as they need.
 *
 * `decorate(fields, index)` builds each embed, so callers can mark the second
 * and later ones as continuations.
 *
 * `reserve` is the room to leave for whatever `decorate` adds — a title, and
 * usually a description on the first one. Those count towards the 6000-character
 * budget but are added after the fields are packed, so without reserving for
 * them an embed that measured 5,900 here comes out over the limit and Discord
 * rejects the whole message.
 */
function packFields(fields, decorate, { reserve = 0 } = {}) {
  const budget = MAX_EMBED_LENGTH - reserve;
  const embeds = [];
  let current = null;
  let length = 0;

  for (const field of fields) {
    const size = String(field.name ?? '').length + String(field.value ?? '').length;
    const full =
      current === null ||
      current.fields.length >= MAX_FIELDS_PER_EMBED ||
      length + size > budget;

    if (full) {
      current = { fields: [] };
      embeds.push(current);
      length = 0;
    }

    current.fields.push(field);
    length += size;
  }

  return embeds.map((embed, index) => decorate(embed.fields, index));
}

/** Groups embeds into messages, respecting both per-message limits. */
function packIntoMessages(embeds) {
  const messages = [];
  let current = [];
  let length = 0;

  for (const embed of embeds) {
    const size = embedLength(embed);

    if (
      current.length > 0 &&
      (current.length >= MAX_EMBEDS_PER_MESSAGE || length + size > MAX_MESSAGE_LENGTH)
    ) {
      messages.push(current);
      current = [];
      length = 0;
    }

    current.push(embed);
    length += size;
  }

  if (current.length > 0) messages.push(current);

  return messages;
}

module.exports = {
  MAX_EMBEDS_PER_MESSAGE,
  MAX_EMBED_LENGTH,
  MAX_FIELDS_PER_EMBED,
  MAX_FIELD_LENGTH,
  MAX_MESSAGE_LENGTH,
  chunkLines,
  embedLength,
  packFields,
  packIntoMessages,
  toFields
};

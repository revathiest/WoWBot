// utils/commandOptions.js
// Shared slash-command option wiring, so every command takes `region` the same
// way, and every character-taking command resolves its address the same way.
//
// There is no `game` option and no realm concept anywhere in here: this bot
// serves one flavour, Classic Forever, which has neither.

const { readConfig, normalizeRegion } = require('../config');
const { mainFor } = require('./reports/links');
const { REGION_CHOICES, characterSlug, fullCharacterName, splitCharacterName } = require('./wow');

/** Adds the optional region picker. */
function addRegionOption(builder, description = 'Region to query. Defaults to the bot\'s configured region.') {
  return builder.addStringOption(option =>
    option
      .setName('region')
      .setDescription(description)
      .addChoices(...REGION_CHOICES)
      .setRequired(false)
  );
}

/**
 * Adds the surname option. Forever characters have no realm — the surname is
 * what makes a name unique — so it is mandatory to resolve one, even though the
 * option itself is optional: a surname can also be typed into the character
 * option as "Judgement-Judy" or "Judgement Judy".
 */
function addSurnameOption(builder) {
  return builder.addStringOption(option =>
    option
      .setName('surname')
      .setDescription('Surname, e.g. Judy for Judgement-Judy.')
      .setRequired(false)
  );
}

/** Reads the region option, falling back to the configured default. */
function resolveRegion(interaction, config = readConfig()) {
  const chosen = interaction.options?.getString?.('region');
  return normalizeRegion(chosen) ?? config.blizzard.region;
}

/**
 * Just the region, plus a label for embed titles: "US".
 *
 * `fallbackRegion` is used ahead of the configured default — the region a
 * character resolved from `resolveCharacterTarget`'s main fallback actually
 * lives in — but an explicit `region` option always wins over both.
 */
function resolveScope(interaction, config = readConfig(), { fallbackRegion } = {}) {
  const chosen = interaction.options?.getString?.('region');
  const region = normalizeRegion(chosen) ?? normalizeRegion(fallbackRegion) ?? config.blizzard.region;

  return { region, label: region.toUpperCase() };
}

/**
 * Resolves a character's `{name}-{surname}` slug from whatever was typed.
 *
 * Accepts a hyphenated or space-separated name ("Judgement-Judy",
 * "Judgement Judy") or a bare first name plus the separate `surname` option.
 * Never throws for user error — a missing surname comes back as `{ error }`
 * naming exactly what to pass, since there is no realm to fall back to and
 * no way to guess the other half of someone's name.
 *
 * With `fallbackToMain` set, an omitted character falls back to the caller's
 * linked main (`/iam`) instead of erroring — the result then also carries
 * that character's own stored `region`, so a lookup with no `region` option
 * queries where the main actually lives rather than the bot's default.
 *
 * @returns {{characterName: string, displayName: string, region?: string} | {error: string}}
 */
function resolveCharacterTarget({ interaction, characterOption = 'character', fallbackToMain = false }) {
  const typed = (interaction.options?.getString?.(characterOption) ?? '').trim();

  if (!typed) {
    if (fallbackToMain) {
      const main = mainFor(interaction.user?.id);

      if (main) {
        return {
          characterName: characterSlug(main.name, main.surname),
          displayName: fullCharacterName(main),
          region: main.region
        };
      }
    }

    return {
      error: fallbackToMain
        ? 'No character given, and you have no linked main. Pass a character name, or link one ' +
          'with `/iam link`.'
        : 'No character name given.'
    };
  }

  const split = splitCharacterName(typed);
  const given = (interaction.options?.getString?.('surname') ?? '').trim();
  const surname = given || split.surname;
  // A surname passed separately means the character option is the first name,
  // even when it has no separator in it.
  const name = given ? split.name ?? typed : split.name;
  const slug = characterSlug(name, surname);

  if (!slug) {
    return {
      error:
        `**${typed}** needs a surname. Classic Forever characters are identified by ` +
        'first name and surname — pass the `surname` option, or type the name as ' +
        '`Judgement-Judy`.'
    };
  }

  return { characterName: slug, displayName: fullCharacterName({ name, surname }) };
}

module.exports = {
  addRegionOption,
  addSurnameOption,
  resolveCharacterTarget,
  resolveRegion,
  resolveScope
};

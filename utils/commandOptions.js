// utils/commandOptions.js
// Shared slash-command option wiring, so every command takes `region` and `game`
// the same way.

const { readConfig, normalizeRegion, normalizeGame, GAMES, isRealmless } = require('../config');
const { REGION_CHOICES, characterSlug, splitCharacterName } = require('./wow');

const GAME_CHOICES = [
  { name: 'TBC Anniversary (Nightslayer, Dreamscythe, Maladath)', value: 'anniversary' },
  { name: 'Retail', value: 'retail' },
  { name: 'Classic progression (currently Mists of Pandaria)', value: 'classic' },
  { name: 'Classic Era (incl. Hardcore)', value: 'classic-era' },
  { name: 'Classic Forever (no realms — needs a surname)', value: 'forever' }
];

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

/** Adds the optional game-version picker. */
function addGameOption(builder, description = 'Game version. Defaults to the bot\'s configured version.') {
  return builder.addStringOption(option =>
    option
      .setName('game')
      .setDescription(description)
      .addChoices(...GAME_CHOICES)
      .setRequired(false)
  );
}

/**
 * Adds the realm option.
 *
 * Never `setRequired(true)`, even with no home realm configured. One
 * slash-command definition is registered for every flavour, and Classic Forever
 * has no realms at all — marking it required would make Discord demand a realm
 * from the one flavour that cannot use it. The requirement is enforced at run
 * time instead, by `resolveCharacterTarget`, which can see which game was picked.
 *
 * The cost is that a missing realm is reported once the command runs rather than
 * by Discord as you type. That is the price of one definition serving both
 * addressing shapes.
 */
function addRealmOption(builder, config = readConfig(), { description = null } = {}) {
  const home = config.blizzard.realm;
  const base = home ? `Realm name. Defaults to ${home}.` : 'Realm name, e.g. Area 52';

  return builder.addStringOption(option =>
    option
      .setName('realm')
      // `/realm` overrides this: there the option names a ruleset on Classic
      // Forever rather than being ignored.
      .setDescription(description ?? `${base} Ignored for Classic Forever.`)
      .setRequired(false)
  );
}

/**
 * Adds the surname option, which Classic Forever characters need and no other
 * flavour has. Optional, because a surname can also be typed into the character
 * option as "Judgement-Judy" or "Judgement Judy".
 */
function addSurnameOption(builder) {
  return builder.addStringOption(option =>
    option
      .setName('surname')
      .setDescription('Surname — Classic Forever only, e.g. Judy for Judgement-Judy.')
      .setRequired(false)
  );
}

/** Reads the realm option, falling back to the configured home realm. */
function resolveRealmName(interaction, config = readConfig()) {
  const chosen = interaction.options?.getString?.('realm');
  return (chosen ?? '').trim() || config.blizzard.realm;
}

/** Reads the region option, falling back to the configured default. */
function resolveRegion(interaction, config = readConfig()) {
  const chosen = interaction.options?.getString?.('region');
  return normalizeRegion(chosen) ?? config.blizzard.region;
}

/** Reads the game option, falling back to the configured default. */
function resolveGame(interaction, config = readConfig()) {
  const chosen = interaction.options?.getString?.('game');
  return normalizeGame(chosen) ?? config.blizzard.game;
}

/** Both at once, plus a short label for embed titles: "US · Classic". */
function resolveScope(interaction, config = readConfig()) {
  const region = resolveRegion(interaction, config);
  const game = resolveGame(interaction, config);

  return {
    region,
    game,
    label: game === 'retail'
      ? region.toUpperCase()
      : `${region.toUpperCase()} · ${GAMES[game].label}`
  };
}

/**
 * Resolves just the realm part, for lookups that are not about a character —
 * guilds, and the weekly report's roster fetch.
 *
 * Realmless flavours resolve to a null slug, which is what the guild and
 * character path builders want in order to omit the realm segment. They can
 * never fail, because there is nothing to ask the user for.
 *
 * @returns {Promise<{realmSlug: string|null, realmLabel: string|null, resolved: boolean} | {error: string}>}
 */
async function resolveRealmTarget({ interaction, scope, config = readConfig() }) {
  const { resolveRealm } = require('./blizzard/realms');

  if (isRealmless(scope.game)) {
    return { realmSlug: null, realmLabel: null, resolved: true };
  }

  const realmQuery = resolveRealmName(interaction, config);

  if (!realmQuery) {
    return {
      error: 'No realm given, and no default realm is configured. Pass the `realm` option.'
    };
  }

  const target = await resolveRealm(realmQuery, { region: scope.region, game: scope.game });

  return { realmSlug: target.slug, realmLabel: target.name, resolved: target.resolved };
}

/**
 * Works out how to address a character in whichever flavour was picked, so that
 * no command has to know two addressing shapes exist.
 *
 * Realm flavours resolve the realm name to a slug and keep the character name
 * separate. Classic Forever has no realm: the address is a single
 * `{name}-{surname}` slug, so the surname is mandatory and the realm option is
 * ignored outright rather than quietly misapplied.
 *
 * Resolves to one of two shapes, and never throws for user error:
 *
 *   { realmSlug, characterName, displayName, realmLabel, resolved, realmQuery }
 *   { error }   — a user-facing sentence naming exactly what is missing
 *
 * `characterName` is always what the profile wrappers want as their second
 * argument, and `realmSlug` is null precisely when the path should omit a realm.
 */
async function resolveCharacterTarget({
  interaction,
  scope,
  characterOption = 'character',
  config = readConfig()
}) {
  // Required here rather than at module scope: every command loads this file to
  // build its definition at startup, and realm resolution reaches the network.
  const { resolveRealm } = require('./blizzard/realms');

  const typed = (interaction.options?.getString?.(characterOption) ?? '').trim();

  if (!typed) return { error: 'No character name given.' };

  if (isRealmless(scope.game)) {
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
          `**${typed}** needs a surname. ${GAMES[scope.game].label} characters have no ` +
          'realm — they are identified by first name and surname, so pass the `surname` ' +
          'option or type the name as `Judgement-Judy`.'
      };
    }

    return {
      realmSlug: null,
      characterName: slug,
      displayName: [name, surname].filter(Boolean).join(' '),
      realmLabel: null,
      resolved: true,
      realmQuery: null
    };
  }

  const realmQuery = resolveRealmName(interaction, config);

  if (!realmQuery) {
    return {
      error: 'No realm given, and no default realm is configured. Pass the `realm` option.'
    };
  }

  const target = await resolveRealm(realmQuery, { region: scope.region, game: scope.game });

  return {
    realmSlug: target.slug,
    characterName: typed,
    displayName: typed,
    realmLabel: target.name,
    resolved: target.resolved,
    realmQuery
  };
}

module.exports = {
  GAME_CHOICES,
  addGameOption,
  addRealmOption,
  addRegionOption,
  addSurnameOption,
  resolveCharacterTarget,
  resolveRealmName,
  resolveRealmTarget,
  resolveGame,
  resolveRegion,
  resolveScope
};

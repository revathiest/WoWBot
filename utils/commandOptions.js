// utils/commandOptions.js
// Shared slash-command option wiring, so every command takes `region` and `game`
// the same way.

const { readConfig, normalizeRegion, normalizeGame, GAMES } = require('../config');
const { REGION_CHOICES } = require('./wow');

const GAME_CHOICES = [
  { name: 'TBC Anniversary (Nightslayer, Dreamscythe, Maladath)', value: 'anniversary' },
  { name: 'Retail', value: 'retail' },
  { name: 'Classic progression (currently Mists of Pandaria)', value: 'classic' },
  { name: 'Classic Era (incl. Hardcore)', value: 'classic-era' }
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
 * Adds the realm option. It is required only when no home realm is configured,
 * so a guild that sets BLIZZARD_REALM never has to type it.
 */
function addRealmOption(builder, config = readConfig()) {
  const home = config.blizzard.realm;

  return builder.addStringOption(option =>
    option
      .setName('realm')
      .setDescription(home ? `Realm name. Defaults to ${home}.` : 'Realm name, e.g. Area 52')
      .setRequired(!home)
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

module.exports = {
  GAME_CHOICES,
  addGameOption,
  addRealmOption,
  addRegionOption,
  resolveRealmName,
  resolveGame,
  resolveRegion,
  resolveScope
};

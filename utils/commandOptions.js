// utils/commandOptions.js
// Shared slash-command option wiring, so every WoW command takes `region` the same way.

const { readConfig, normalizeRegion } = require('../config');
const { REGION_CHOICES } = require('./wow');

/** Adds the optional region picker used by every command in commands/wow. */
function addRegionOption(builder, description = 'Region to query. Defaults to the bot\'s configured region.') {
  return builder.addStringOption(option =>
    option
      .setName('region')
      .setDescription(description)
      .addChoices(...REGION_CHOICES)
      .setRequired(false)
  );
}

/** Reads the region option, falling back to the configured default. */
function resolveRegion(interaction, config = readConfig()) {
  const chosen = interaction.options?.getString?.('region');
  return normalizeRegion(chosen) ?? config.blizzard.region;
}

module.exports = {
  addRegionOption,
  resolveRegion
};

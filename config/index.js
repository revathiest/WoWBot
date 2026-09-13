// config/index.js
// Central place for environment-derived settings, so nothing else reads process.env directly.

const REGIONS = ['us', 'eu', 'kr', 'tw'];

const DEFAULT_REGION = 'us';
const DEFAULT_LOCALE = 'en_US';

function normalizeRegion(value) {
  const region = String(value ?? '').trim().toLowerCase();
  return REGIONS.includes(region) ? region : null;
}

function readConfig(env = process.env) {
  return {
    discord: {
      token: env.DISCORD_TOKEN ?? '',
      applicationId: env.APPLICATION_ID ?? '',
      // Optional: when present, commands register to this guild only (instant updates).
      guildId: (env.GUILD_ID ?? '').trim() || null
    },
    blizzard: {
      clientId: env.BLIZZARD_CLIENT_ID ?? '',
      clientSecret: env.BLIZZARD_CLIENT_SECRET ?? '',
      region: normalizeRegion(env.BLIZZARD_REGION) ?? DEFAULT_REGION,
      locale: (env.BLIZZARD_LOCALE ?? '').trim() || DEFAULT_LOCALE
    }
  };
}

// Returns a list of human-readable problems; empty means good to launch.
function validateConfig(config = readConfig()) {
  const problems = [];

  if (!config.discord.token) problems.push('DISCORD_TOKEN is not set.');
  if (!config.discord.applicationId) problems.push('APPLICATION_ID is not set.');
  if (!config.blizzard.clientId) problems.push('BLIZZARD_CLIENT_ID is not set.');
  if (!config.blizzard.clientSecret) problems.push('BLIZZARD_CLIENT_SECRET is not set.');

  return problems;
}

module.exports = {
  REGIONS,
  DEFAULT_REGION,
  DEFAULT_LOCALE,
  normalizeRegion,
  readConfig,
  validateConfig
};

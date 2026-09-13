// jest.setup.js
// Runs before the test framework and before any module is required.
//
// Command modules build their SlashCommandBuilder at load time, and the shape of
// the `realm` option depends on whether a home realm is configured. Pin the
// environment here so suites never depend on the developer's own .env.

process.env.BLIZZARD_REALM = 'Testrealm';
process.env.BLIZZARD_REGION = 'us';
process.env.BLIZZARD_GAME = 'retail';
process.env.BLIZZARD_LOCALE = 'en_US';

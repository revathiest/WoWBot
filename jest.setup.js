// jest.setup.js
// Runs before the test framework and before any module is required.
//
// Pin the environment here so suites never depend on the developer's own .env.

process.env.BLIZZARD_REGION = 'us';
process.env.BLIZZARD_LOCALE = 'en_US';

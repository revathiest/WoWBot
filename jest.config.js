module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__'],
  moduleFileExtensions: ['js', 'json'],
  // Only *.test.js are suites; everything else under __tests__ is shared helpers.
  testMatch: ['<rootDir>/__tests__/**/*.test.js'],
  // Pins BLIZZARD_* so results never depend on the developer's local .env.
  setupFiles: ['<rootDir>/jest.setup.js'],

  // === COVERAGE SETTINGS ===
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov'],
  collectCoverageFrom: [
    'commands/**/*.js',
    'handlers/**/*.js',
    'utils/**/*.js',
    'config/**/*.js',
    '!**/node_modules/**'
  ],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80
    }
  },

  verbose: false,
  silent: true,
  reporters: ['default']
};

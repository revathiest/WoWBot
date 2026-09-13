const path = require('path');
const { Routes } = require('discord.js');
const {
  COMMANDS_DIR,
  loadCommandsRecursively,
  registerCommands
} = require('../../utils/commandRegistration');

const baseConfig = {
  discord: { token: 'token', applicationId: 'app-id', guildId: null }
};

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('loadCommandsRecursively', () => {
  it('loads every command shipped in commands/', () => {
    const commands = loadCommandsRecursively();

    expect([...commands.keys()].sort()).toEqual([
      'character',
      'item',
      'mythicplus',
      'realm',
      'token'
    ]);
  });

  it('gives each command a builder and an execute function', () => {
    for (const [name, command] of loadCommandsRecursively()) {
      expect(command.data.toJSON().name).toBe(name);
      expect(typeof command.execute).toBe('function');
    }
  });

  it('returns an empty map for a directory that does not exist', () => {
    expect(loadCommandsRecursively(path.join(COMMANDS_DIR, 'nope')).size).toBe(0);
  });

  describe('with malformed command files', () => {
    const FIXTURES = path.join(__dirname, '..', 'fixtures', 'commands');

    it('keeps the good commands and skips the rest', () => {
      const commands = loadCommandsRecursively(FIXTURES);

      // good.js and nested/deep.js load; the malformed files and notes.txt do not.
      expect([...commands.keys()].sort()).toEqual(['deep', 'good']);
    });

    it('warns once per skipped file', () => {
      loadCommandsRecursively(FIXTURES);

      const warnings = console.warn.mock.calls.map(args => args.join(' ')).join('\n');
      expect(warnings).toContain('noData.js');
      expect(warnings).toContain('noExecute.js');
      expect(warnings).toContain('broken.js');
      expect(warnings).toContain('this command is broken');
    });
  });
});

function fakeCommand(name) {
  return {
    data: { name, toJSON: () => ({ name, description: `${name} description` }) },
    execute: jest.fn()
  };
}

describe('registerCommands', () => {
  it('publishes commands globally when no guild is configured', async () => {
    const client = {};
    const rest = { put: jest.fn(async () => {}) };
    const commandMap = new Map([['token', fakeCommand('token')]]);

    await registerCommands(client, { config: baseConfig, rest, commandMap });

    expect(client.commands).toBe(commandMap);
    expect(rest.put).toHaveBeenCalledWith(Routes.applicationCommands('app-id'), {
      body: [{ name: 'token', description: 'token description' }]
    });
  });

  it('publishes to a single guild when GUILD_ID is set', async () => {
    const rest = { put: jest.fn(async () => {}) };
    const config = { discord: { ...baseConfig.discord, guildId: 'guild-id' } };

    await registerCommands({}, { config, rest, commandMap: new Map([['token', fakeCommand('token')]]) });

    expect(rest.put).toHaveBeenCalledWith(
      Routes.applicationGuildCommands('app-id', 'guild-id'),
      expect.anything()
    );
  });

  it('skips registration when the application id is missing', async () => {
    const rest = { put: jest.fn() };
    const config = { discord: { token: 'token', applicationId: '', guildId: null } };
    const client = {};

    await registerCommands(client, { config, rest, commandMap: new Map() });

    expect(rest.put).not.toHaveBeenCalled();
    // Commands are still attached so the handler can answer sensibly.
    expect(client.commands).toBeInstanceOf(Map);
  });

  it('logs but does not throw when Discord rejects the registration', async () => {
    const rest = { put: jest.fn(async () => { throw new Error('missing access'); }) };

    await expect(
      registerCommands({}, { config: baseConfig, rest, commandMap: new Map() })
    ).resolves.toBeInstanceOf(Map);

    expect(console.error).toHaveBeenCalled();
  });
});

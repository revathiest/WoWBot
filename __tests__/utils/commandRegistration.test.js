const path = require('path');
const { Routes } = require('discord.js');
const {
  COMMANDS_DIR,
  clearGlobalCommands,
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
    const rest = { put: jest.fn(async () => {}), get: jest.fn(async () => []) };
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

describe('clearing global commands', () => {
  const guildConfig = { discord: { ...baseConfig.discord, guildId: 'guild-id' } };
  const commandMap = () => new Map([['token', fakeCommand('token')]]);

  it('removes leftover global commands after a guild registration', async () => {
    const rest = {
      put: jest.fn(async () => {}),
      get: jest.fn(async () => [{ id: '1', name: 'token' }, { id: '2', name: 'realm' }])
    };

    await registerCommands({}, { config: guildConfig, rest, commandMap: commandMap() });

    expect(rest.put).toHaveBeenCalledWith(Routes.applicationCommands('app-id'), { body: [] });
    // The guild registration must happen first, the wipe second.
    expect(rest.put.mock.calls[0][0]).toBe(Routes.applicationGuildCommands('app-id', 'guild-id'));
    expect(rest.put.mock.calls[1][0]).toBe(Routes.applicationCommands('app-id'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Removed 2 global command(s)'));
  });

  it('does not issue a wipe when there are no global commands', async () => {
    const rest = { put: jest.fn(async () => {}), get: jest.fn(async () => []) };

    await registerCommands({}, { config: guildConfig, rest, commandMap: commandMap() });

    expect(rest.put).toHaveBeenCalledTimes(1);
    expect(rest.put).not.toHaveBeenCalledWith(Routes.applicationCommands('app-id'), { body: [] });
  });

  it('leaves global commands alone when the guild registration failed', async () => {
    const rest = {
      put: jest.fn(async () => { throw new Error('missing access'); }),
      get: jest.fn(async () => [{ id: '1', name: 'token' }])
    };

    await registerCommands({}, { config: guildConfig, rest, commandMap: commandMap() });

    // Wiping here would leave the application with no commands at all.
    expect(rest.get).not.toHaveBeenCalled();
    expect(rest.put).toHaveBeenCalledTimes(1);
  });

  it('never wipes when registering globally', async () => {
    const rest = { put: jest.fn(async () => {}), get: jest.fn(async () => []) };

    await registerCommands({}, { config: baseConfig, rest, commandMap: commandMap() });

    expect(rest.get).not.toHaveBeenCalled();
    expect(rest.put).toHaveBeenCalledTimes(1);
  });

  it('keeps the guild registration when the wipe fails', async () => {
    const rest = {
      put: jest.fn(async () => {}),
      get: jest.fn(async () => { throw new Error('rate limited'); })
    };

    await expect(
      registerCommands({}, { config: guildConfig, rest, commandMap: commandMap() })
    ).resolves.toBeInstanceOf(Map);

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Could not clear global commands'));
  });

  it('reports how many commands it removed', async () => {
    const rest = {
      put: jest.fn(async () => {}),
      get: jest.fn(async () => [{ id: '1' }, { id: '2' }, { id: '3' }])
    };

    await expect(clearGlobalCommands(rest, 'app-id')).resolves.toBe(3);
  });

  it('tolerates a malformed listing', async () => {
    const rest = { put: jest.fn(async () => {}), get: jest.fn(async () => null) };

    await expect(clearGlobalCommands(rest, 'app-id')).resolves.toBe(0);
    expect(rest.put).not.toHaveBeenCalled();
  });
});

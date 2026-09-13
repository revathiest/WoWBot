const path = require('path');
const { Routes } = require('discord.js');
const {
  COMMANDS_DIR,
  clearGlobalCommands,
  loadCommandsRecursively,
  registerCommands,
  registerCommandsForGuild,
  registerGuildJoinHandler
} = require('../../utils/commandRegistration');

const baseConfig = {
  discord: { token: 'token', applicationId: 'app-id', guildId: null }
};

const guild = (id, name) => ({ id, name });

/** A client stub exposing the guild cache registration reads. */
function fakeClient(guilds = []) {
  return { guilds: { cache: new Map(guilds.map(g => [g.id, g])) } };
}

function fakeCommand(name) {
  return {
    data: { name, toJSON: () => ({ name, description: `${name} description` }) },
    execute: jest.fn()
  };
}

const oneCommand = () => new Map([['token', fakeCommand('token')]]);
const body = [{ name: 'token', description: 'token description' }];

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
      'arena',
      'audit',
      'character',
      'guild',
      'item',
      'mythicplus',
      'realm',
      'realms',
      'spam',
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

describe('registerCommands', () => {
  it('publishes to every guild the bot is in when none is configured', async () => {
    const client = fakeClient([guild('g1', 'Alpha'), guild('g2', 'Beta')]);
    const rest = { put: jest.fn(async () => {}), get: jest.fn(async () => []) };
    const commandMap = oneCommand();

    await registerCommands(client, { config: baseConfig, rest, commandMap });

    expect(client.commands).toBe(commandMap);
    // Guild commands appear instantly; global registration can take an hour.
    expect(rest.put).toHaveBeenCalledWith(Routes.applicationGuildCommands('app-id', 'g1'), { body });
    expect(rest.put).toHaveBeenCalledWith(Routes.applicationGuildCommands('app-id', 'g2'), { body });
  });

  it('pins to one guild when GUILD_ID is set, ignoring the others', async () => {
    const rest = { put: jest.fn(async () => {}), get: jest.fn(async () => []) };
    const config = { discord: { ...baseConfig.discord, guildId: 'guild-id' } };
    const client = fakeClient([guild('other', 'Other'), guild('guild-id', 'Pinned')]);

    await registerCommands(client, { config, rest, commandMap: oneCommand() });

    expect(rest.put).toHaveBeenCalledWith(
      Routes.applicationGuildCommands('app-id', 'guild-id'),
      expect.anything()
    );
    expect(rest.put).not.toHaveBeenCalledWith(
      Routes.applicationGuildCommands('app-id', 'other'),
      expect.anything()
    );
  });

  it('warns rather than throwing when the bot is in no guilds', async () => {
    const rest = { put: jest.fn(), get: jest.fn() };

    await registerCommands(fakeClient([]), { config: baseConfig, rest, commandMap: new Map() });

    expect(rest.put).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('not in any guild'));
  });

  it('keeps going when one guild rejects the registration', async () => {
    const rest = {
      put: jest.fn(async route =>
        route === Routes.applicationGuildCommands('app-id', 'g1')
          ? Promise.reject(new Error('Missing Access'))
          : undefined
      ),
      get: jest.fn(async () => [])
    };

    await registerCommands(fakeClient([guild('g1', 'Alpha'), guild('g2', 'Beta')]), {
      config: baseConfig,
      rest,
      commandMap: oneCommand()
    });

    expect(rest.put).toHaveBeenCalledWith(
      Routes.applicationGuildCommands('app-id', 'g2'),
      expect.anything()
    );
    expect(console.error).toHaveBeenCalled();
  });

  it('skips registration when the application id is missing', async () => {
    const rest = { put: jest.fn() };
    const config = { discord: { token: 'token', applicationId: '', guildId: null } };
    const client = fakeClient([guild('g1', 'Alpha')]);

    await registerCommands(client, { config, rest, commandMap: new Map() });

    expect(rest.put).not.toHaveBeenCalled();
    // Commands are still attached so the handler can answer sensibly.
    expect(client.commands).toBeInstanceOf(Map);
  });

  it('logs but does not throw when Discord rejects every registration', async () => {
    const rest = {
      put: jest.fn(async () => {
        throw new Error('missing access');
      }),
      get: jest.fn(async () => [])
    };

    await expect(
      registerCommands(fakeClient([guild('g1', 'Alpha')]), {
        config: baseConfig,
        rest,
        commandMap: oneCommand()
      })
    ).resolves.toBeInstanceOf(Map);

    expect(console.error).toHaveBeenCalled();
  });
});

describe('clearing global commands', () => {
  it('removes leftover global commands after a guild registration', async () => {
    const rest = {
      put: jest.fn(async () => {}),
      get: jest.fn(async () => [{ id: '1', name: 'token' }, { id: '2', name: 'realm' }])
    };

    await registerCommands(fakeClient([guild('g1', 'Alpha')]), {
      config: baseConfig,
      rest,
      commandMap: oneCommand()
    });

    expect(rest.put).toHaveBeenCalledWith(Routes.applicationCommands('app-id'), { body: [] });
    // Guild registration first, wipe second.
    expect(rest.put.mock.calls[0][0]).toBe(Routes.applicationGuildCommands('app-id', 'g1'));
    expect(rest.put.mock.calls[1][0]).toBe(Routes.applicationCommands('app-id'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Removed 2 global command(s)'));
  });

  it('does not issue a wipe when there are no global commands', async () => {
    const rest = { put: jest.fn(async () => {}), get: jest.fn(async () => []) };

    await registerCommands(fakeClient([guild('g1', 'Alpha')]), {
      config: baseConfig,
      rest,
      commandMap: oneCommand()
    });

    expect(rest.put).toHaveBeenCalledTimes(1);
  });

  it('leaves global commands alone when every guild registration failed', async () => {
    const rest = {
      put: jest.fn(async () => {
        throw new Error('missing access');
      }),
      get: jest.fn(async () => [{ id: '1', name: 'token' }])
    };

    await registerCommands(fakeClient([guild('g1', 'Alpha')]), {
      config: baseConfig,
      rest,
      commandMap: oneCommand()
    });

    // Wiping here would leave the application with no commands at all.
    expect(rest.get).not.toHaveBeenCalled();
  });

  it('keeps the guild registration when the wipe fails', async () => {
    const rest = {
      put: jest.fn(async () => {}),
      get: jest.fn(async () => {
        throw new Error('rate limited');
      })
    };

    await expect(
      registerCommands(fakeClient([guild('g1', 'Alpha')]), {
        config: baseConfig,
        rest,
        commandMap: oneCommand()
      })
    ).resolves.toBeInstanceOf(Map);

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not clear global commands')
    );
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

describe('joining a guild', () => {
  it('registers commands to a newly joined guild immediately', async () => {
    const rest = { put: jest.fn(async () => {}) };
    const client = { commands: oneCommand() };

    await expect(
      registerCommandsForGuild(client, guild('new1', 'Newcomer'), { config: baseConfig, rest })
    ).resolves.toBe(true);

    expect(rest.put).toHaveBeenCalledWith(Routes.applicationGuildCommands('app-id', 'new1'), {
      body
    });
  });

  it('ignores a guild this instance is pinned away from', async () => {
    const rest = { put: jest.fn() };
    const config = { discord: { ...baseConfig.discord, guildId: 'mine' } };

    await expect(
      registerCommandsForGuild({ commands: oneCommand() }, guild('theirs', 'Theirs'), {
        config,
        rest
      })
    ).resolves.toBe(false);

    expect(rest.put).not.toHaveBeenCalled();
  });

  it('reports failure rather than throwing', async () => {
    const rest = {
      put: jest.fn(async () => {
        throw new Error('Missing Access');
      })
    };

    await expect(
      registerCommandsForGuild({ commands: oneCommand() }, guild('g', 'G'), {
        config: baseConfig,
        rest
      })
    ).resolves.toBe(false);
  });

  it('does nothing without an application id', async () => {
    const rest = { put: jest.fn() };
    const config = { discord: { token: 't', applicationId: '', guildId: null } };

    await expect(
      registerCommandsForGuild({ commands: oneCommand() }, guild('g', 'G'), { config, rest })
    ).resolves.toBe(false);
  });

  it('subscribes to GuildCreate', () => {
    const client = { on: jest.fn() };

    registerGuildJoinHandler(client, { GuildCreate: 'guildCreate' });

    expect(client.on).toHaveBeenCalledWith('guildCreate', expect.any(Function));
  });
});

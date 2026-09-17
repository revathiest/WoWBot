jest.mock('../../utils/tickets/core', () => ({ handleComponent: jest.fn(async () => true) }));

const { MessageFlags } = require('discord.js');
const { handleComponent } = require('../../utils/tickets/core');
const {
  describeError,
  describeDeadInteraction,
  handleInteraction,
  isDeadInteraction,
  registerInteractionHandler,
  resetIgnoredGuilds,
  respondWithError
} = require('../../handlers/interactionHandler');
const { BlizzardApiError } = require('../../utils/blizzard/client');
const { createInteraction } = require('../helpers/interaction');

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('describeError', () => {
  it.each([
    [404, /Double-check the spelling/],
    [401, /credentials were rejected/],
    [403, /credentials were rejected/],
    [429, /rate limiting/],
    [500, /having problems/],
    [503, /having problems/]
  ])('maps HTTP %s to a useful message', (status, expected) => {
    expect(describeError(new BlizzardApiError('boom', { status }))).toMatch(expected);
  });

  it('passes through other Blizzard messages', () => {
    expect(describeError(new BlizzardApiError('Credentials are not configured.'))).toContain(
      'Credentials are not configured.'
    );
  });

  it('stays vague about unexpected errors', () => {
    expect(describeError(new TypeError('x is not a function'))).toBe(
      '❌ Something went wrong running that command.'
    );
  });
});

describe('respondWithError', () => {
  it('replies ephemerally when nothing has been sent yet', async () => {
    const interaction = createInteraction();

    await respondWithError(interaction, 'nope');

    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'nope',
      flags: MessageFlags.Ephemeral
    });
  });

  it('edits the deferred reply instead of sending a new one', async () => {
    const interaction = createInteraction();
    interaction.deferred = true;

    await respondWithError(interaction, 'nope');

    expect(interaction.editReply).toHaveBeenCalledWith({ content: 'nope' });
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it('swallows a failure to deliver the error', async () => {
    const interaction = createInteraction();
    interaction.reply.mockRejectedValue(new Error('unknown interaction'));

    await expect(respondWithError(interaction, 'nope')).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });
});

describe('handleInteraction', () => {
  it('ignores anything that is not a slash command', async () => {
    const interaction = createInteraction();
    interaction.isChatInputCommand = () => false;

    await handleInteraction(interaction);

    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it('runs the matching command', async () => {
    const execute = jest.fn(async () => {});
    const interaction = createInteraction({
      commandName: 'token',
      commands: new Map([['token', { execute }]])
    });

    await handleInteraction(interaction);

    expect(execute).toHaveBeenCalledWith(interaction);
  });

  it('tells the user when a command is no longer registered', async () => {
    const interaction = createInteraction({ commandName: 'ghost', commands: new Map() });

    await handleInteraction(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('no longer available') })
    );
  });

  it('handles a client with no command map at all', async () => {
    const interaction = createInteraction({ commandName: 'ghost' });
    interaction.client = {};

    await handleInteraction(interaction);

    expect(interaction.reply).toHaveBeenCalled();
  });

  it('converts a thrown Blizzard error into a friendly reply', async () => {
    const execute = jest.fn(async () => {
      throw new BlizzardApiError('Not found.', { status: 404 });
    });
    const interaction = createInteraction({
      commandName: 'character',
      commands: new Map([['character', { execute }]])
    });
    interaction.deferred = true;

    await handleInteraction(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith({
      content: expect.stringContaining('Double-check the spelling')
    });
  });
});

describe('dead interactions', () => {
  // 10062 Unknown interaction / 40060 already acknowledged. Both mean the
  // interaction cannot be answered; retrying only produces a second error.
  const deadError = code => Object.assign(new Error('Unknown interaction'), { code });

  it('recognises both dead codes', () => {
    expect(isDeadInteraction(deadError(10062))).toBe(true);
    expect(isDeadInteraction(deadError(40060))).toBe(true);
    expect(isDeadInteraction(new Error('something else'))).toBe(false);
    expect(isDeadInteraction(undefined)).toBe(false);
  });

  it('blames a duplicate instance when the interaction is still young', () => {
    // The case that actually happened: a 288ms-old interaction returning 10062.
    // This process was well inside the budget, so something else consumed the
    // token first. Reading 10062 as "we were slow" sent a real investigation
    // down the wrong path for hours.
    const now = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(now);

    const young = describeDeadInteraction({ code: 10062 }, { createdTimestamp: now - 288 });

    expect(young).toContain('288ms old');
    expect(young).toContain('answered in time');
    expect(young).toContain('ANOTHER INSTANCE');
    expect(young).toContain('npm run dev');
  });

  it('blames latency only when the interaction really was old', () => {
    const now = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(now);

    const old = describeDeadInteraction({ code: 10062 }, { createdTimestamp: now - 2900 });

    expect(old).toContain('2900ms old');
    expect(old).toContain('expired');
    expect(old).not.toContain('ANOTHER INSTANCE');
  });

  it('treats 40060 on an older interaction as a shared token too', () => {
    const now = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(now);

    const taken = describeDeadInteraction({ code: 40060 }, { createdTimestamp: now - 2500 });

    expect(taken).toContain('already answered');
    expect(taken).toContain('sharing this token');
  });

  it('copes with an interaction that has no timestamp', () => {
    expect(describeDeadInteraction({ code: 10062 }, {})).toContain('age unknown');
  });

  it('does not try to respond when the interaction expired', async () => {
    const execute = jest.fn(async () => {
      throw deadError(10062);
    });
    const interaction = createInteraction({
      commandName: 'spam',
      commands: new Map([['spam', { execute }]])
    });

    await handleInteraction(interaction);

    // The cascade this prevents: reply() -> 10062, then reply() again -> 40060.
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.editReply).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('expired'));
    expect(console.error).not.toHaveBeenCalled();
  });

  it('stays quiet when the error response itself hits a dead interaction', async () => {
    const interaction = createInteraction();
    interaction.reply.mockRejectedValue(deadError(40060));

    await respondWithError(interaction, 'nope');

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('interaction is gone'));
    expect(console.error).not.toHaveBeenCalled();
  });

  it('still reports ordinary command failures in full', async () => {
    const execute = jest.fn(async () => {
      throw new Error('genuine bug');
    });
    const interaction = createInteraction({
      commandName: 'spam',
      commands: new Map([['spam', { execute }]])
    });

    await handleInteraction(interaction);

    expect(console.error).toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalled();
  });
});

describe('registerInteractionHandler', () => {
  it('subscribes to the interaction event', () => {
    const client = { on: jest.fn() };

    registerInteractionHandler(client, { InteractionCreate: 'interactionCreate' });

    expect(client.on).toHaveBeenCalledWith('interactionCreate', handleInteraction);
  });
});

describe('guild scoping', () => {
  // Two deployments sharing a token stop racing once each ignores the other's
  // guild. This is the mechanism that makes that work.
  const originalGuildId = process.env.GUILD_ID;

  beforeEach(() => resetIgnoredGuilds());

  afterEach(() => {
    if (originalGuildId === undefined) delete process.env.GUILD_ID;
    else process.env.GUILD_ID = originalGuildId;
  });

  it('ignores an interaction from a guild this instance does not serve', async () => {
    process.env.GUILD_ID = 'mine';
    const execute = jest.fn();
    const interaction = createInteraction({
      commandName: 'token',
      commands: new Map([['token', { execute }]])
    });
    interaction.guildId = 'theirs';

    await handleInteraction(interaction);

    expect(execute).not.toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it('serves its own guild', async () => {
    process.env.GUILD_ID = 'mine';
    const execute = jest.fn(async () => {});
    const interaction = createInteraction({
      commandName: 'token',
      commands: new Map([['token', { execute }]])
    });
    interaction.guildId = 'mine';

    await handleInteraction(interaction);

    expect(execute).toHaveBeenCalled();
  });

  it('announces an ignored guild once, then stays quiet', async () => {
    // A pinned dev instance receives every interaction from the busy production
    // guild. Logging each would drown the dev console.
    process.env.GUILD_ID = 'mine';
    const commands = new Map([['token', { execute: jest.fn() }]]);

    for (let i = 0; i < 5; i += 1) {
      const interaction = createInteraction({ commandName: 'token', commands });
      interaction.guildId = 'theirs';
      await handleInteraction(interaction);
    }

    const notices = console.log.mock.calls.filter(args =>
      String(args[0]).includes('Ignoring events from guild theirs')
    );
    expect(notices).toHaveLength(1);
  });

  it('announces each ignored guild separately', async () => {
    process.env.GUILD_ID = 'mine';
    const commands = new Map([['token', { execute: jest.fn() }]]);

    for (const guildId of ['a', 'b']) {
      const interaction = createInteraction({ commandName: 'token', commands });
      interaction.guildId = guildId;
      await handleInteraction(interaction);
    }

    const notices = console.log.mock.calls.filter(args =>
      String(args[0]).includes('Ignoring events from guild')
    );
    expect(notices).toHaveLength(2);
  });

  it('ignores DMs', async () => {
    delete process.env.GUILD_ID;
    const execute = jest.fn();
    const interaction = createInteraction({
      commandName: 'token',
      commands: new Map([['token', { execute }]])
    });
    interaction.guildId = null;

    await handleInteraction(interaction);

    expect(execute).not.toHaveBeenCalled();
  });
});

describe('component routing', () => {
  /** A button interaction, which is neither a command nor ignorable. */
  function componentInteraction({ customId = 'ticket:create', kind = 'button' } = {}) {
    const interaction = createInteraction();

    interaction.customId = customId;
    interaction.isChatInputCommand = () => false;
    interaction.isButton = () => kind === 'button';
    interaction.isModalSubmit = () => kind === 'modal';

    return interaction;
  }

  beforeEach(() => {
    handleComponent.mockClear();
    handleComponent.mockResolvedValue(true);
  });

  it('routes a button to the component handlers', async () => {
    const interaction = componentInteraction();
    await handleInteraction(interaction);

    expect(handleComponent).toHaveBeenCalledWith(interaction);
  });

  it('routes a modal submission too', async () => {
    const interaction = componentInteraction({ customId: 'ticket:modal:create', kind: 'modal' });
    await handleInteraction(interaction);

    expect(handleComponent).toHaveBeenCalledWith(interaction);
  });

  it('never looks a component up as a slash command', async () => {
    const execute = jest.fn();
    const interaction = componentInteraction();
    interaction.client.commands = new Map([['ticket:create', { execute }]]);

    await handleInteraction(interaction);

    expect(execute).not.toHaveBeenCalled();
  });

  it('turns a component failure into a reply rather than a silent hang', async () => {
    handleComponent.mockRejectedValue(new Error('boom'));
    const interaction = componentInteraction();

    await handleInteraction(interaction);

    expect(interaction.reply).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });

  it('logs one line for a dead component interaction instead of a stack trace', async () => {
    handleComponent.mockRejectedValue(Object.assign(new Error('gone'), { code: 10062 }));
    const interaction = componentInteraction();

    await handleInteraction(interaction);

    expect(console.warn).toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it('ignores a component from a guild this instance does not serve', async () => {
    // Buttons need the same GUILD_ID pinning as commands, or two instances both
    // answer one click. A blank GUILD_ID serves every guild, so pin it here.
    const previous = process.env.GUILD_ID;
    process.env.GUILD_ID = 'pinned-guild';
    resetIgnoredGuilds();

    try {
      const interaction = componentInteraction();
      interaction.guildId = 'some-other-guild';

      await handleInteraction(interaction);

      expect(handleComponent).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.GUILD_ID;
      else process.env.GUILD_ID = previous;
    }
  });
});

describe('admin-only lockdown', () => {
  /** Runs `body` with ADMIN_ONLY forced to `value`, then restores it. */
  async function withAdminOnly(value, body) {
    const previous = process.env.ADMIN_ONLY;
    process.env.ADMIN_ONLY = value;

    try {
      await body();
    } finally {
      if (previous === undefined) delete process.env.ADMIN_ONLY;
      else process.env.ADMIN_ONLY = previous;
    }
  }

  it('refuses a command from somebody without Manage Server', async () => {
    // The registration flag only hides commands; a guild can override it, so
    // this is the check that actually holds.
    await withAdminOnly('true', async () => {
      const execute = jest.fn();
      const interaction = createInteraction({
        commandName: 'token',
        commands: new Map([['token', { execute }]]),
        permissions: false
      });

      await handleInteraction(interaction);

      expect(execute).not.toHaveBeenCalled();
      expect(interaction.reply).toHaveBeenCalled();
    });
  });

  it('allows an admin through', async () => {
    await withAdminOnly('true', async () => {
      const execute = jest.fn(async () => {});
      const interaction = createInteraction({
        commandName: 'token',
        commands: new Map([['token', { execute }]]),
        permissions: true
      });

      await handleInteraction(interaction);

      expect(execute).toHaveBeenCalled();
    });
  });

  it('lets everyone through again once the lock is lifted', async () => {
    await withAdminOnly('false', async () => {
      const execute = jest.fn(async () => {});
      const interaction = createInteraction({
        commandName: 'token',
        commands: new Map([['token', { execute }]]),
        permissions: false
      });

      await handleInteraction(interaction);

      expect(execute).toHaveBeenCalled();
    });
  });
});

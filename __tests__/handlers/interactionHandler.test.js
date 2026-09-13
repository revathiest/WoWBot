const { MessageFlags } = require('discord.js');
const {
  describeError,
  describeDeadInteraction,
  handleInteraction,
  isDeadInteraction,
  registerInteractionHandler,
  respondWithError
} = require('../../handlers/interactionHandler');
const { BlizzardApiError } = require('../../utils/blizzard/client');
const { createInteraction } = require('../helpers/interaction');

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
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

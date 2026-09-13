const { MessageFlags } = require('discord.js');
const {
  describeError,
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

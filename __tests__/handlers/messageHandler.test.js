jest.mock('../../utils/spam/config', () => {
  const actual = jest.requireActual('../../utils/spam/config');
  return { ...actual, loadConfig: jest.fn(), saveConfig: jest.fn() };
});

jest.mock('../../utils/spam/enforcement', () => ({
  act: jest.fn(async () => ({ acted: true, action: 'ban', deleted: true, blockedReason: null }))
}));

jest.mock('../../utils/tickets/core', () => ({ handleLobbyMessage: jest.fn(async () => false) }));

jest.mock('../../utils/spam/alert', () => ({
  buildAlertEmbed: jest.fn(() => ({ toJSON: () => ({}) })),
  sendAlert: jest.fn(async () => true)
}));

const { loadConfig, normalizeConfig } = require('../../utils/spam/config');
const enforcement = require('../../utils/spam/enforcement');
const alert = require('../../utils/spam/alert');
const state = require('../../utils/spam/state');
const {
  exemptionFor,
  handleMessageCreate,
  handleMessageUpdate,
  registerMessageHandler
} = require('../../handlers/messageHandler');
const { handleLobbyMessage } = require('../../utils/tickets/core');
const { createMember, createMessage } = require('../helpers/message');

const enabled = (overrides = {}) => normalizeConfig({ enabled: true, alertChannelId: 'c9', ...overrides });

beforeEach(() => {
  jest.clearAllMocks();
  state.clearAllState();
  loadConfig.mockReturnValue(enabled());
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe('exemptionFor', () => {
  it('allows an ordinary member through', () => {
    expect(exemptionFor(createMessage(), enabled())).toBeNull();
  });

  it.each([
    ['DMs', () => ({ ...createMessage(), guild: null }), enabled, 'not a guild message'],
    ['bots', () => createMessage({ isBot: true }), enabled, 'author is a bot'],
    ['when disabled', () => createMessage(), () => normalizeConfig({}), 'spam detection disabled'],
    [
      'exempt channels',
      () => createMessage({ channelId: 'quiet' }),
      () => enabled({ exemptChannelIds: ['quiet'] }),
      'exempt channel'
    ],
    [
      'exempt roles',
      () => createMessage({ member: createMember({ roleIds: ['vip'] }) }),
      () => enabled({ exemptRoleIds: ['vip'] }),
      'exempt role'
    ],
    [
      'moderators',
      () => createMessage({ member: createMember({ canManageMessages: true }) }),
      enabled,
      'member can manage messages'
    ],
    ['uncached members', () => createMessage({ member: null }), enabled, 'member not cached']
  ])('skips %s', (_label, makeMessage, makeConfig, expected) => {
    expect(exemptionFor(makeMessage(), makeConfig())).toBe(expected);
  });
});

describe('handleMessageCreate', () => {
  it('does nothing for ordinary chat', async () => {
    await handleMessageCreate(createMessage({ content: 'anyone for Kara tonight?' }));

    expect(enforcement.act).not.toHaveBeenCalled();
  });

  it('bans a new account on a single red flag', async () => {
    const member = createMember({ accountDays: 0.1, tenureDays: 0.1 });
    const message = createMessage({ content: 'free nitro here', member });

    await handleMessageCreate(message);

    expect(enforcement.act).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: expect.objectContaining({
          action: 'ban',
          reason: expect.stringContaining('Spam detection [suspicious]')
        })
      })
    );
  });

  it('leaves an established member alone for a single flag', async () => {
    const member = createMember({ accountDays: 400, tenureDays: 200 });

    await handleMessageCreate(createMessage({ content: 'free nitro here', member }));

    expect(enforcement.act).not.toHaveBeenCalled();
  });

  it('times out an established member in the compromise band', async () => {
    const member = createMember({ accountDays: 400, tenureDays: 200 });
    const message = createMessage({
      content: 'claim your free crypto airdrop wallet',
      member,
      mentionedUsers: 6
    });

    await handleMessageCreate(message);

    expect(enforcement.act).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: expect.objectContaining({
          action: 'timeout',
          reason: expect.stringContaining('Possible account compromise')
        })
      })
    );
  });

  it('alerts and forgets the user after acting', async () => {
    const member = createMember({ accountDays: 0.1, tenureDays: 0.1 });

    await handleMessageCreate(createMessage({ content: 'free nitro here', member }));

    expect(alert.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'c9' })
    );
    expect(state.stateSize().users).toBe(0);
  });

  it('still alerts when enforcement was blocked', async () => {
    enforcement.act.mockResolvedValue({
      acted: false,
      action: 'ban',
      deleted: true,
      blockedReason: 'the target has a role ranked at or above the bot'
    });
    const member = createMember({ accountDays: 0.1, tenureDays: 0.1 });

    await handleMessageCreate(createMessage({ content: 'free nitro here', member }));

    expect(alert.sendAlert).toHaveBeenCalled();
  });

  it('catches a rate-limit spam burst', async () => {
    const member = createMember({ accountDays: 0.1, tenureDays: 0.1 });

    for (let i = 0; i < 5; i += 1) {
      await handleMessageCreate(createMessage({ content: `message number ${i}`, member }));
    }

    expect(enforcement.act).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: expect.objectContaining({
          reason: expect.stringContaining('rate limit')
        })
      })
    );
  });
});

describe('handleMessageUpdate', () => {
  it('catches a message edited into a scam', async () => {
    const member = createMember({ accountDays: 0.1, tenureDays: 0.1 });
    const edited = createMessage({ content: 'free nitro discord.gg/abc', member });

    await handleMessageUpdate({ content: 'hello' }, edited);

    expect(enforcement.act).toHaveBeenCalled();
  });

  it('does not let an edit move the rate window', async () => {
    const member = createMember({ accountDays: 400, tenureDays: 200 });

    for (let i = 0; i < 10; i += 1) {
      await handleMessageUpdate({}, createMessage({ content: 'hello there friend', member }));
    }

    expect(state.stateSize().users).toBe(0);
    expect(enforcement.act).not.toHaveBeenCalled();
  });

  it('ignores a missing message', async () => {
    await expect(handleMessageUpdate({}, null)).resolves.toBeNull();
  });
});

describe('registerMessageHandler', () => {
  it('subscribes to create and update', () => {
    const client = { on: jest.fn() };

    registerMessageHandler(client, {
      MessageCreate: 'messageCreate',
      MessageUpdate: 'messageUpdate'
    });

    expect(client.on).toHaveBeenCalledWith('messageCreate', expect.any(Function));
    expect(client.on).toHaveBeenCalledWith('messageUpdate', expect.any(Function));
  });

  it('swallows handler errors so the process survives', async () => {
    const client = { on: jest.fn() };
    loadConfig.mockImplementation(() => {
      throw new Error('config exploded');
    });

    registerMessageHandler(client, { MessageCreate: 'a', MessageUpdate: 'b' });
    const wrapped = client.on.mock.calls[0][1];

    await expect(wrapped(createMessage())).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });
});

describe('ticket lobby policing', () => {
  beforeEach(() => {
    handleLobbyMessage.mockClear();
    handleLobbyMessage.mockResolvedValue(false);
  });

  it('offers every guild message to the lobby handler', async () => {
    loadConfig.mockReturnValue(normalizeConfig({ enabled: true }));
    const message = createMessage({ content: 'hello' });

    await handleMessageCreate(message);

    expect(handleLobbyMessage).toHaveBeenCalledWith(message);
  });

  it('stops once the lobby handler has dealt with the message', async () => {
    // A message that was just deleted is not worth scoring for spam.
    loadConfig.mockReturnValue(normalizeConfig({ enabled: true }));
    handleLobbyMessage.mockResolvedValue(true);

    expect(await handleMessageCreate(createMessage({ content: 'hello' }))).toBeNull();
    expect(enforcement.act).not.toHaveBeenCalled();
  });

  it('polices the lobby even while spam detection is switched off', async () => {
    // The two features are unrelated; the lobby is tidied either way.
    loadConfig.mockReturnValue(normalizeConfig({ enabled: false }));

    await handleMessageCreate(createMessage({ content: 'hello' }));

    expect(handleLobbyMessage).toHaveBeenCalled();
  });
});

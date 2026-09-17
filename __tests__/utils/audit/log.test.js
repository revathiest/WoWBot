// `shouldLog` defaults its config argument to `loadConfig()`. Pulled straight
// from requireActual it would close over the REAL loadConfig and read the real
// file, so it is rebound here to the mock.
jest.mock('../../../utils/audit/config', () => {
  const actual = jest.requireActual('../../../utils/audit/config');
  const loadConfig = jest.fn();

  return {
    ...actual,
    loadConfig,
    shouldLog: (entry, config = loadConfig()) => actual.shouldLog(entry, config)
  };
});

const { loadConfig, DEFAULTS, normalizeConfig, shouldLog } = require('../../../utils/audit/config');
const {
  FLUSH_INTERVAL_MS,
  MAX_MESSAGE_LENGTH,
  describeCommand,
  flush,
  formatEntry,
  packLines,
  record,
  reset
} = require('../../../utils/audit/log');

function config(overrides = {}) {
  return normalizeConfig({ enabled: true, channelId: 'log-1', verbosity: 'all', ...overrides });
}

function fakeClient({ isTextBased = true, sendFails = false } = {}) {
  const send = jest.fn(async () => {
    if (sendFails) throw new Error('Missing Access');
  });

  return {
    send,
    channels: { fetch: jest.fn(async id => ({ id, isTextBased: () => isTextBased, send })) }
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  reset();
  loadConfig.mockReturnValue(config());
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  reset();
  jest.restoreAllMocks();
});

describe('shouldLog', () => {
  it('records nothing while disabled', () => {
    expect(shouldLog({ category: 'Admin' }, config({ enabled: false }))).toBe(false);
  });

  it('records nothing without a channel', () => {
    expect(shouldLog({ category: 'Admin' }, config({ channelId: null }))).toBe(false);
  });

  it('records everything at "all"', () => {
    expect(shouldLog({ category: 'WoW' }, config({ verbosity: 'all' }))).toBe(true);
  });

  it('skips ordinary lookups at "admin"', () => {
    // /character and friends are the bulk of the traffic and rarely interesting.
    expect(shouldLog({ category: 'WoW' }, config({ verbosity: 'admin' }))).toBe(false);
  });

  it('keeps admin commands at "admin"', () => {
    expect(shouldLog({ category: 'Admin' }, config({ verbosity: 'admin' }))).toBe(true);
  });

  it('always keeps what the bot did on its own', () => {
    // An unprompted kick or a scheduled report is the whole point of a log.
    expect(shouldLog({ automatic: true, category: 'WoW' }, config({ verbosity: 'admin' }))).toBe(true);
  });

  it('records nothing at "off"', () => {
    expect(shouldLog({ automatic: true }, config({ verbosity: 'off' }))).toBe(false);
  });
});

describe('formatEntry', () => {
  it('names who did what, and where', () => {
    const line = formatEntry({
      at: 1_700_000_000_000,
      kind: 'command',
      action: 'ran `/token`',
      actorId: 'u1',
      channelId: 'c1'
    });

    expect(line).toContain('<@u1>');
    expect(line).toContain('ran `/token`');
    expect(line).toContain('<#c1>');
    expect(line).toContain('<t:1700000000:T>');
  });

  it('credits the bot when nobody asked', () => {
    expect(formatEntry({ at: 1, kind: 'report', action: 'posted the weekly report' })).toContain(
      'the bot'
    );
  });

  it('marks a failure', () => {
    expect(formatEntry({ at: 1, kind: 'error', action: 'ran `/x`', ok: false })).toContain('failed');
  });

  it('appends detail when there is any', () => {
    expect(formatEntry({ at: 1, kind: 'info', action: 'did a thing', detail: 'twice' })).toContain(
      '— twice'
    );
  });
});

describe('packLines', () => {
  it('keeps short runs in one message', () => {
    expect(packLines(['a', 'b'])).toEqual(['a\nb']);
  });

  it('splits at the message limit', () => {
    const lines = Array.from({ length: 50 }, () => 'x'.repeat(100));
    const messages = packLines(lines);

    expect(messages.length).toBeGreaterThan(1);
    messages.forEach(message => expect(message.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH));
  });

  it('truncates a single oversized line rather than looping forever', () => {
    const [message] = packLines(['x'.repeat(5000)]);
    expect(message.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
  });
});

describe('record', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('queues an entry rather than sending immediately', () => {
    const client = fakeClient();

    expect(record(client, { kind: 'command', action: 'ran `/token`', category: 'WoW' })).toBe(true);
    expect(client.channels.fetch).not.toHaveBeenCalled();
  });

  it('drops an entry the verbosity excludes', () => {
    loadConfig.mockReturnValue(config({ verbosity: 'admin' }));
    expect(record(fakeClient(), { kind: 'command', action: 'x', category: 'WoW' })).toBe(false);
  });

  it('flushes after the interval', async () => {
    const client = fakeClient();
    record(client, { kind: 'command', action: 'ran `/token`', category: 'WoW' });

    jest.advanceTimersByTime(FLUSH_INTERVAL_MS);
    await Promise.resolve();
    await Promise.resolve();

    expect(client.channels.fetch).toHaveBeenCalledWith('log-1');
  });

  it('batches a burst into one message', async () => {
    // Discord allows roughly five messages per five seconds per channel; one
    // message per action would burn through that and start dropping records.
    const client = fakeClient();

    for (let i = 0; i < 10; i += 1) {
      record(client, { kind: 'command', action: `ran \`/cmd${i}\``, category: 'WoW' });
    }

    jest.advanceTimersByTime(FLUSH_INTERVAL_MS);
    await Promise.resolve();
    await Promise.resolve();

    expect(client.send).toHaveBeenCalledTimes(1);
  });
});

describe('flush', () => {
  it('suppresses mentions, so the log does not ping people constantly', async () => {
    const client = fakeClient();
    record(client, { kind: 'command', action: 'ran `/token`', actorId: 'u1', category: 'WoW' });

    await flush();

    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({ allowedMentions: { parse: [] } })
    );
  });

  it('does nothing with an empty queue', async () => {
    await expect(flush()).resolves.toBeUndefined();
  });

  it('warns rather than throwing when the channel rejects the write', async () => {
    // Logging must never break the thing it is logging.
    const client = fakeClient({ sendFails: true });
    record(client, { kind: 'command', action: 'x', category: 'WoW' });

    await expect(flush()).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
  });

  it('warns when the log channel is not a text channel', async () => {
    const client = fakeClient({ isTextBased: false });
    record(client, { kind: 'command', action: 'x', category: 'WoW' });

    await flush();

    expect(client.send).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('describeCommand', () => {
  function interaction({ commandName = 'ticket', group = null, subcommand = null, throws = false } = {}) {
    return {
      commandName,
      options: {
        getSubcommandGroup: () => group,
        getSubcommand: () => {
          if (throws) throw new Error('no subcommand');
          return subcommand;
        }
      }
    };
  }

  it('renders a bare command', () => {
    expect(describeCommand(interaction({ commandName: 'token' }))).toBe('/token');
  });

  it('includes the subcommand', () => {
    expect(describeCommand(interaction({ subcommand: 'status' }))).toBe('/ticket status');
  });

  it('includes a subcommand group', () => {
    expect(describeCommand(interaction({ group: 'roles', subcommand: 'add' }))).toBe(
      '/ticket roles add'
    );
  });

  it('copes with a command that throws instead of returning null', () => {
    // discord.js throws for commands that have no subcommands at all.
    expect(describeCommand(interaction({ commandName: 'token', throws: true }))).toBe('/token');
  });
});

describe('defaults', () => {
  it('ships off', () => {
    expect(DEFAULTS.enabled).toBe(false);
  });
});

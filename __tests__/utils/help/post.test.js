jest.mock('fs');
jest.mock('../../../utils/channelLock');

const fs = require('fs');
const { lockChannel } = require('../../../utils/channelLock');
const store = require('../../../utils/help/store');
const { deleteAll, fetchExisting, publishHelp, refreshAll, setupHelpChannel } = require('../../../utils/help/post');

/**
 * A command map that produces an overview plus two PUBLIC sections.
 *
 * The admin command is deliberately present and deliberately not counted: the
 * posted help leaves those out, so three messages is the expected shape.
 */
function commands() {
  const { SlashCommandBuilder } = require('discord.js');
  const build = (name, category) => ({
    data: new SlashCommandBuilder().setName(name).setDescription('Does a thing.'),
    help: 'Does a thing.',
    category
  });

  return new Map([
    ['token', build('token', 'WoW')],
    ['help', build('help', 'Help')],
    ['spam', build('spam', 'Admin')]
  ]);
}

function fakeMessage(id) {
  return { id, edit: jest.fn(async () => {}), delete: jest.fn(async () => {}) };
}

function fakeChannel({ existing = {}, sendFails = false } = {}) {
  let next = 0;

  return {
    id: 'help-channel',
    isTextBased: () => true,
    guild: { id: 'g1' },
    send: jest.fn(async () => {
      if (sendFails) throw new Error('Missing Permissions');
      next += 1;
      return fakeMessage(`new${next}`);
    }),
    messages: {
      fetch: jest.fn(async id => {
        if (!existing[id]) throw new Error('Unknown Message');
        return existing[id];
      })
    }
  };
}

function fakeClient(channel, { guildName = 'Test Guild' } = {}) {
  return {
    user: { id: 'bot-1' },
    commands: commands(),
    guilds: { fetch: jest.fn(async () => ({ id: 'g1', name: guildName, channels: { fetch: jest.fn(async () => channel) } })) },
    channels: { fetch: jest.fn(async () => channel) }
  };
}

function fileContains(value) {
  fs.readFileSync.mockReturnValue(JSON.stringify(value));
}

function fileMissing() {
  const err = new Error('nope');
  err.code = 'ENOENT';
  fs.readFileSync.mockImplementation(() => {
    throw err;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  store.clearCache();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  lockChannel.mockResolvedValue({ ok: true, clearedRoles: [], warnings: [] });
});

afterEach(() => jest.restoreAllMocks());

describe('fetchExisting', () => {
  it('returns every message when they all still exist', async () => {
    const existing = { a: fakeMessage('a'), b: fakeMessage('b') };
    const found = await fetchExisting(fakeChannel({ existing }), ['a', 'b']);

    expect(found.map(m => m.id)).toEqual(['a', 'b']);
  });

  it('returns null when any one has been deleted', async () => {
    // Partial is no use: a missing message in the middle cannot be patched
    // back into place, because a new one lands at the bottom.
    const existing = { a: fakeMessage('a') };
    expect(await fetchExisting(fakeChannel({ existing }), ['a', 'gone'])).toBeNull();
  });

  it('returns null when nothing has been posted yet', async () => {
    expect(await fetchExisting(fakeChannel(), [])).toBeNull();
  });
});

describe('publishHelp', () => {
  it('refuses when no channel is configured', async () => {
    fileMissing();
    expect(await publishHelp(fakeClient(fakeChannel()), 'g1', commands())).toMatchObject({
      ok: false,
      reason: expect.stringContaining('no help channel')
    });
  });

  it('publishes one message per section on a first run', async () => {
    fileContains({ g1: { channelId: 'help-channel', messageIds: [] } });
    const channel = fakeChannel();

    const result = await publishHelp(fakeClient(channel), 'g1', commands());

    expect(result).toMatchObject({ ok: true, mode: 'published' });
    // Overview + WoW + Help. The Admin command is excluded.
    expect(channel.send).toHaveBeenCalledTimes(3);
  });

  it('leaves admin commands out of the posted help', async () => {
    // The help channel is readable by the whole server; listing commands that
    // answer "you need Manage Server" is noise to almost everyone reading it.
    fileContains({ g1: { channelId: 'help-channel', messageIds: [] } });
    const channel = fakeChannel();

    await publishHelp(fakeClient(channel), 'g1', commands());

    const titles = channel.send.mock.calls.flatMap(([payload]) =>
      payload.embeds.map(embed => embed.toJSON().title)
    );

    expect(titles.some(title => title.includes('WoW'))).toBe(true);
    expect(titles.some(title => title.includes('Admin'))).toBe(false);
  });

  it('edits in place when the content changed but the shape did not', async () => {
    const existing = { m1: fakeMessage('m1'), m2: fakeMessage('m2'), m3: fakeMessage('m3') };
    fileContains({
      g1: { channelId: 'help-channel', messageIds: ['m1', 'm2', 'm3'], fingerprint: 'stale' }
    });
    const channel = fakeChannel({ existing });

    const result = await publishHelp(fakeClient(channel), 'g1', commands());

    expect(result).toMatchObject({ ok: true, mode: 'updated' });
    expect(channel.send).not.toHaveBeenCalled();
    expect(existing.m2.edit).toHaveBeenCalled();
  });

  it('writes nothing at all when the commands have not changed', async () => {
    // This is the normal case on a restart. Rewriting every message each boot
    // would leave an edit on a post nobody touched.
    const existing = { m1: fakeMessage('m1'), m2: fakeMessage('m2'), m3: fakeMessage('m3') };
    fileContains({ g1: { channelId: 'help-channel', messageIds: ['m1', 'm2', 'm3'] } });
    const channel = fakeChannel({ existing });

    // First run records the fingerprint...
    await publishHelp(fakeClient(channel), 'g1', commands());
    jest.clearAllMocks();

    // ...and a second run with the same commands does nothing.
    const result = await publishHelp(fakeClient(channel), 'g1', commands());

    expect(result.mode).toBe('unchanged');
    expect(existing.m1.edit).not.toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('notices when a command is added and rewrites the post', async () => {
    const existing = { m1: fakeMessage('m1'), m2: fakeMessage('m2'), m3: fakeMessage('m3') };
    fileContains({ g1: { channelId: 'help-channel', messageIds: ['m1', 'm2', 'm3'] } });
    const channel = fakeChannel({ existing });

    await publishHelp(fakeClient(channel), 'g1', commands());

    const { SlashCommandBuilder } = require('discord.js');
    const extended = commands();
    extended.set('newthing', {
      data: new SlashCommandBuilder().setName('newthing').setDescription('New.'),
      help: 'A brand new command.',
      category: 'WoW'
    });

    jest.clearAllMocks();
    const result = await publishHelp(fakeClient(channel), 'g1', extended);

    expect(result.mode).toBe('updated');
    expect(existing.m2.edit).toHaveBeenCalled();
  });

  it('replaces the post when a section has been added', async () => {
    // Two stored messages, three needed: the shape changed, so patching would
    // put the new section in the wrong place.
    const existing = { m1: fakeMessage('m1'), m2: fakeMessage('m2') };
    fileContains({ g1: { channelId: 'help-channel', messageIds: ['m1', 'm2'] } });
    const channel = fakeChannel({ existing });

    const result = await publishHelp(fakeClient(channel), 'g1', commands());

    expect(result.mode).toBe('published');
    expect(existing.m1.delete).toHaveBeenCalled();
    expect(existing.m2.delete).toHaveBeenCalled();
  });

  it('republishes when a message was deleted by hand', async () => {
    fileContains({ g1: { channelId: 'help-channel', messageIds: ['m1', 'gone', 'm3'] } });
    const channel = fakeChannel({ existing: { m1: fakeMessage('m1'), m3: fakeMessage('m3') } });

    expect((await publishHelp(fakeClient(channel), 'g1', commands())).mode).toBe('published');
  });

  it('adds jump links to the overview once the sections have ids', async () => {
    fileContains({ g1: { channelId: 'help-channel', messageIds: [] } });
    const channel = fakeChannel();

    await publishHelp(fakeClient(channel), 'g1', commands());

    // The header is posted, then edited a second time with the links.
    const header = await channel.send.mock.results[0].value;
    expect(header.edit).toHaveBeenCalled();
  });

  it('records the message ids so the next run can edit them', async () => {
    fileContains({ g1: { channelId: 'help-channel', messageIds: [] } });

    const result = await publishHelp(fakeClient(fakeChannel()), 'g1', commands());

    expect(store.get('g1').messageIds).toEqual(result.messageIds);
  });

  it('records a fingerprint so the next boot can skip the work', async () => {
    fileContains({ g1: { channelId: 'help-channel', messageIds: [] } });

    await publishHelp(fakeClient(fakeChannel()), 'g1', commands());

    expect(store.get('g1').fingerprint).toEqual(expect.any(String));
  });

  it('reports a channel it cannot post in', async () => {
    fileContains({ g1: { channelId: 'help-channel', messageIds: [] } });

    expect(await publishHelp(fakeClient(fakeChannel({ sendFails: true })), 'g1', commands())).toMatchObject({
      ok: false
    });
  });

  it('refuses a channel that is not text-based', async () => {
    fileContains({ g1: { channelId: 'help-channel', messageIds: [] } });
    const channel = { ...fakeChannel(), isTextBased: () => false };

    expect(await publishHelp(fakeClient(channel), 'g1', commands())).toMatchObject({ ok: false });
  });

  it('reports an unreachable guild', async () => {
    fileContains({ g1: { channelId: 'help-channel', messageIds: [] } });
    const client = fakeClient(fakeChannel());
    client.guilds.fetch.mockRejectedValue(new Error('Unknown Guild'));

    expect(await publishHelp(client, 'g1', commands())).toMatchObject({ ok: false });
  });
});

describe('setupHelpChannel', () => {
  it('locks the channel before posting', async () => {
    fileMissing();
    const channel = fakeChannel();
    channel.guild = { id: 'g1', name: 'Test Guild', channels: { fetch: jest.fn(async () => channel) } };

    const result = await setupHelpChannel(fakeClient(channel), {
      guildId: 'g1',
      channel,
      botId: 'bot-1'
    });

    expect(lockChannel).toHaveBeenCalledWith(channel, expect.objectContaining({ botId: 'bot-1' }));
    expect(result.post.ok).toBe(true);
    expect(lockChannel.mock.invocationCallOrder[0]).toBeLessThan(channel.send.mock.invocationCallOrder[0]);
  });

  it('removes the old post when the channel moves', async () => {
    const old = fakeMessage('old1');
    fileContains({ g1: { channelId: 'old-channel', messageIds: ['old1'] } });

    const oldChannel = fakeChannel({ existing: { old1: old } });
    const channel = fakeChannel();
    channel.guild = {
      id: 'g1',
      name: 'Test Guild',
      channels: { fetch: jest.fn(async id => (id === 'old-channel' ? oldChannel : channel)) }
    };

    await setupHelpChannel(fakeClient(channel), { guildId: 'g1', channel, botId: 'bot-1' });

    expect(old.delete).toHaveBeenCalled();
  });
});

describe('refreshAll', () => {
  it('skips guilds this instance does not serve', async () => {
    fileContains({ g1: { channelId: 'help-channel', messageIds: [] } });
    const client = fakeClient(fakeChannel());

    const results = await refreshAll(client, commands(), { inScope: () => false });

    expect(results).toEqual([]);
    expect(client.guilds.fetch).not.toHaveBeenCalled();
  });

  it('refreshes each configured guild', async () => {
    fileContains({ g1: { channelId: 'help-channel', messageIds: [] } });

    const results = await refreshAll(fakeClient(fakeChannel()), commands());

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
  });

  it('warns rather than throwing when one guild fails', async () => {
    fileContains({ g1: { channelId: 'help-channel', messageIds: [] } });
    const client = fakeClient(fakeChannel());
    client.guilds.fetch.mockRejectedValue(new Error('Unknown Guild'));

    await refreshAll(client, commands());

    expect(console.warn).toHaveBeenCalled();
  });
});

describe('deleteAll', () => {
  it('tolerates messages that are already gone', async () => {
    await expect(deleteAll(fakeChannel(), ['gone'])).resolves.toBeUndefined();
  });
});

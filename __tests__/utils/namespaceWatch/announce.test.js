const {
  STATE_WORDS,
  announce,
  buildAnnouncement,
  describeChange,
  resolveChannel
} = require('../../../utils/namespaceWatch/announce');

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

function textChannel(overrides = {}) {
  return {
    id: '111111111111111111',
    name: 'bot-activity-log',
    guildId: '999',
    isTextBased: () => true,
    send: jest.fn().mockResolvedValue({}),
    ...overrides
  };
}

function clientWith(channel, { guildId = '999' } = {}) {
  return {
    channels: { fetch: jest.fn().mockResolvedValue(channel) },
    guilds: {
      cache: new Map([
        [guildId, { id: guildId, channels: { cache: new Map([[channel.id, channel]]) } }]
      ])
    }
  };
}

// discord.js collections expose `find`; a Map does not.
function withFind(map) {
  map.find = predicate => [...map.values()].find(predicate);
  return map;
}

function clientByName(channel, { guildId = '999' } = {}) {
  const channels = withFind(new Map([[channel.id, channel]]));

  return {
    channels: { fetch: jest.fn() },
    guilds: { cache: new Map([[guildId, { id: guildId, channels: { cache: channels } }]]) }
  };
}

describe('resolveChannel', () => {
  it('fetches by id when given a snowflake', async () => {
    const channel = textChannel();
    const client = clientWith(channel);

    expect(await resolveChannel(client, { channel: channel.id })).toBe(channel);
    expect(client.channels.fetch).toHaveBeenCalledWith(channel.id);
  });

  it('searches guilds by name otherwise', async () => {
    const channel = textChannel();
    const client = clientByName(channel);

    expect(await resolveChannel(client, { channel: 'bot-activity-log' })).toBe(channel);
  });

  it('tolerates a leading hash and any casing', async () => {
    const channel = textChannel();
    const client = clientByName(channel);

    expect(await resolveChannel(client, { channel: '#BOT-Activity-Log' })).toBe(channel);
  });

  it('returns null for a blank target', async () => {
    expect(await resolveChannel(clientByName(textChannel()), { channel: '  ' })).toBeNull();
  });

  it('returns null when no channel has that name', async () => {
    const client = clientByName(textChannel());
    expect(await resolveChannel(client, { channel: 'somewhere-else' })).toBeNull();
  });

  it('ignores a voice channel that happens to share the name', async () => {
    const voice = textChannel({ isTextBased: () => false });
    expect(await resolveChannel(clientByName(voice), { channel: 'bot-activity-log' })).toBeNull();
  });

  it('refuses a channel outside a pinned instance scope', async () => {
    const channel = textChannel({ guildId: '888' });
    const client = clientWith(channel);

    expect(await resolveChannel(client, { channel: channel.id, guildId: '999' })).toBeNull();
  });

  it('skips guilds out of scope when searching by name', async () => {
    const channel = textChannel({ guildId: '888' });
    const client = clientByName(channel, { guildId: '888' });

    expect(await resolveChannel(client, { channel: 'bot-activity-log', guildId: '999' })).toBeNull();
  });

  it('returns null when the fetch throws', async () => {
    const client = clientWith(textChannel());
    client.channels.fetch.mockRejectedValue(new Error('gone'));

    expect(await resolveChannel(client, { channel: '111111111111111111' })).toBeNull();
  });
});

describe('buildAnnouncement', () => {
  it('says nothing when nothing changed', () => {
    expect(buildAnnouncement({ changes: [] })).toBeNull();
  });

  it('builds a message for a patch change alone', () => {
    const embed = buildAnnouncement({ changes: [], patch: '1.61.0', patchChanged: true });
    expect(embed).not.toBeNull();
    expect(embed.data.description).toContain('1.61.0');
  });

  it('titles an arrival as endpoints coming online', () => {
    const embed = buildAnnouncement({
      changes: [{ key: 'dynamic.token', from: 'pending', to: 'available' }]
    });

    expect(embed.data.title).toContain('came online');
    expect(embed.data.color).toBe(0x2ecc71);
  });

  it('titles a regression as endpoints stopping', () => {
    const embed = buildAnnouncement({
      changes: [{ key: 'static.item', from: 'available', to: 'rejected' }]
    });

    expect(embed.data.title).toContain('stopped answering');
    expect(embed.data.color).toBe(0xe74c3c);
  });

  it('calls a mixed result out rather than picking a side', () => {
    const embed = buildAnnouncement({
      changes: [
        { key: 'dynamic.token', from: 'pending', to: 'available' },
        { key: 'static.item', from: 'available', to: 'rejected' }
      ]
    });

    expect(embed.data.color).toBe(0xf1c40f);
  });

  it('names all three namespaces for the configured region', () => {
    const embed = buildAnnouncement({
      changes: [{ key: 'static.item', from: 'pending', to: 'available' }],
      region: 'eu'
    });

    expect(embed.data.description).toContain('static-forever-eu');
    expect(embed.data.description).toContain('dynamic-forever-eu');
    expect(embed.data.description).toContain('profile-forever-eu');
  });

  it('shows the region name, which is the tell that this is an internal group', () => {
    const embed = buildAnnouncement({
      changes: [{ key: 'static.item', from: 'pending', to: 'available' }],
      regionName: 'CAMWOW North America'
    });

    expect(embed.data.description).toContain('CAMWOW North America');
  });

  it('omits the region line when there is no name to show', () => {
    const embed = buildAnnouncement({
      changes: [{ key: 'static.item', from: 'pending', to: 'available' }]
    });

    expect(embed.data.description).not.toContain('Region:');
  });

  it('adds a field per change', () => {
    const embed = buildAnnouncement({
      changes: [
        { key: 'dynamic.token', from: 'pending', to: 'available' },
        { key: 'static.item', from: 'pending', to: 'available' }
      ]
    });

    expect(embed.data.fields).toHaveLength(2);
  });

  it('truncates rather than exceeding the field limit', () => {
    const changes = Array.from({ length: 14 }, (unused, index) => ({
      key: `made.up.${index}`,
      from: 'pending',
      to: 'available'
    }));

    const embed = buildAnnouncement({ changes });

    expect(embed.data.fields).toHaveLength(11);
    expect(embed.data.fields[10].value).toContain('4 more');
  });
});

describe('describeChange', () => {
  it('reads as a transition in plain words', () => {
    const field = describeChange({ key: 'dynamic.realm-index', from: 'pending', to: 'available' });

    expect(field.value).toContain(STATE_WORDS.pending);
    expect(field.value).toContain(STATE_WORDS.available);
  });

  it('says what the endpoint unlocks', () => {
    const field = describeChange({
      key: 'dynamic.ruleset-index',
      from: 'pending',
      to: 'available'
    });
    expect(field.value).toContain('/realms');
  });

  it('points at the probe character when the character check goes bad', () => {
    // The usual cause is the probe character being deleted or renamed, not the
    // profile API breaking, so the message has to say where to look first.
    const field = describeChange({ key: 'profile.character', from: 'available', to: 'pending' });
    expect(field.value).toContain('probe character');
  });

  it('does not nag about the probe character when that check is healthy', () => {
    const field = describeChange({ key: 'profile.character', from: 'pending', to: 'available' });
    expect(field.value).not.toContain('probe character');
  });

  it('falls back to the key for a check it does not know', () => {
    expect(describeChange({ key: 'who.knows', from: 'pending', to: 'available' }).name)
      .toContain('who.knows');
  });
});

describe('announce', () => {
  it('does nothing without an embed', async () => {
    expect(await announce(clientByName(textChannel()), null, { channel: 'bot-activity-log' }))
      .toMatchObject({ posted: false });
  });

  it('sends the embed with mentions suppressed', async () => {
    const channel = textChannel();
    const client = clientByName(channel);
    const embed = buildAnnouncement({ changes: [{ key: 'static.item', from: 'pending', to: 'available' }] });

    const result = await announce(client, embed, { channel: 'bot-activity-log' });

    expect(result).toMatchObject({ posted: true, channelId: channel.id });
    expect(channel.send).toHaveBeenCalledWith({
      embeds: [embed],
      allowedMentions: { parse: [] }
    });
  });

  it('warns and gives up when the channel is missing', async () => {
    const client = clientByName(textChannel());
    const embed = buildAnnouncement({ changes: [{ key: 'static.item', from: 'pending', to: 'available' }] });

    expect(await announce(client, embed, { channel: 'nowhere' }))
      .toMatchObject({ posted: false, reason: 'channel not found' });
    expect(console.warn).toHaveBeenCalled();
  });

  it('never throws when the send fails', async () => {
    const channel = textChannel();
    channel.send.mockRejectedValue(new Error('missing permissions'));
    const embed = buildAnnouncement({ changes: [{ key: 'static.item', from: 'pending', to: 'available' }] });

    const result = await announce(clientByName(channel), embed, { channel: 'bot-activity-log' });

    expect(result.posted).toBe(false);
    expect(result.reason).toBe('missing permissions');
  });
});

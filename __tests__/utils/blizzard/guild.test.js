jest.mock('../../../utils/blizzard/client');

const { request } = require('../../../utils/blizzard/client');
const { getGuild, getGuildRoster, guildPath, slugifyGuild } = require('../../../utils/blizzard/guild');

beforeEach(() => {
  jest.clearAllMocks();
  request.mockResolvedValue({ ok: true });
});

describe('slugifyGuild', () => {
  it('slugs a name the same way a realm name would be', () => {
    expect(slugifyGuild('Circle of Lore')).toBe('circle-of-lore');
  });
});

describe('guildPath', () => {
  it('builds the bare guild path with no suffix', () => {
    expect(guildPath('circle-of-lore')).toBe('/data/wow/guild/circle-of-lore');
  });

  it('appends a suffix for sub-resources', () => {
    expect(guildPath('circle-of-lore', '/roster')).toBe('/data/wow/guild/circle-of-lore/roster');
  });
});

describe('getGuildRoster', () => {
  it('requests the roster under the profile namespace', async () => {
    await getGuildRoster('circle-of-lore');

    expect(request).toHaveBeenCalledWith('/data/wow/guild/circle-of-lore/roster', {
      namespace: 'profile'
    });
  });

  it('forwards caller options alongside the namespace', async () => {
    await getGuildRoster('circle-of-lore', { region: 'eu' });

    expect(request).toHaveBeenCalledWith('/data/wow/guild/circle-of-lore/roster', {
      region: 'eu',
      namespace: 'profile'
    });
  });
});

describe('getGuild', () => {
  it('requests the guild profile under the profile namespace', async () => {
    await getGuild('circle-of-lore');

    expect(request).toHaveBeenCalledWith('/data/wow/guild/circle-of-lore', { namespace: 'profile' });
  });

  it('forwards caller options alongside the namespace', async () => {
    await getGuild('circle-of-lore', { region: 'eu' });

    expect(request).toHaveBeenCalledWith('/data/wow/guild/circle-of-lore', {
      region: 'eu',
      namespace: 'profile'
    });
  });
});

jest.mock('../../../utils/onboarding/state');
jest.mock('../../../utils/onboarding/alert', () => ({
  ...jest.requireActual('../../../utils/onboarding/alert'),
  sendAlert: jest.fn(async () => true)
}));
jest.mock('../../../utils/onboarding/config', () => ({
  ...jest.requireActual('../../../utils/onboarding/config'),
  loadConfig: jest.fn(),
  saveConfig: jest.fn()
}));

const { recordSweep, wasWarned } = require('../../../utils/onboarding/state');
const { sendAlert } = require('../../../utils/onboarding/alert');
const { loadConfig, saveConfig, DEFAULTS, MAX_KICKS_PER_SWEEP } = require('../../../utils/onboarding/config');
const { DAY_MS } = require('../../../utils/onboarding/classify');
const {
  KICK_REASON,
  fetchMembers,
  inspectGuild,
  runSweep,
  startOnboardingSweeper,
  sweepGuild
} = require('../../../utils/onboarding/sweep');

const NOW = Date.UTC(2026, 8, 14, 12, 0, 0);
const GUILD_ID = 'test-guild';

function config(overrides = {}) {
  return {
    ...DEFAULTS,
    enabled: true,
    enabledAt: NOW - 365 * DAY_MS,
    alertChannelId: 'mod-log',
    ...overrides
  };
}

/**
 * A fake GuildMember. `kick` and `send` are spies so tests can assert on what
 * actually happened to a person.
 */
function guildMember({
  id,
  daysAgo = 0,
  roleIds = [],
  bot = false,
  kickable = true,
  dmFails = false,
  highestPosition = 1
} = {}) {
  const member = {
    id,
    joinedTimestamp: NOW - daysAgo * DAY_MS,
    user: { bot, tag: `${id}#0001` },
    roles: {
      cache: new Map([[GUILD_ID, {}], ...roleIds.map(roleId => [roleId, {}])]),
      highest: { comparePositionTo: other => highestPosition - other.position }
    },
    kick: jest.fn(async () => {
      if (!kickable) throw new Error('Missing Permissions');
    }),
    send: jest.fn(async () => {
      if (dmFails) throw new Error('Cannot send messages to this user');
    })
  };

  return member;
}

/** A guild whose member list is the given members, with the bot able to kick. */
function fakeGuild(members, { canKick = true, ownerId = 'owner', botPosition = 10 } = {}) {
  const byId = new Map(members.map(member => [member.id, member]));

  return {
    id: GUILD_ID,
    name: 'Test Guild',
    ownerId,
    members: {
      me: {
        permissions: { has: () => canKick },
        roles: { highest: { comparePositionTo: other => botPosition - other.position, position: botPosition } }
      },
      fetch: jest.fn(async id => {
        if (id === undefined) return byId;
        const member = byId.get(id);
        if (!member) throw new Error('Unknown Member');
        return member;
      })
    }
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});

  loadConfig.mockReturnValue(config());
  wasWarned.mockReturnValue(false);
  recordSweep.mockReturnValue({});
});

afterEach(() => jest.restoreAllMocks());

// discord.js compares role positions; the fakes above need a `position` to read.
function withPosition(member, position) {
  member.roles.highest.position = position;
  return member;
}

describe('fetchMembers', () => {
  it('describes every member', async () => {
    const guild = fakeGuild([guildMember({ id: 'u1', daysAgo: 3 })]);
    const members = await fetchMembers(guild);

    expect(members).toEqual([expect.objectContaining({ id: 'u1', roleCount: 0 })]);
  });

  it('returns null rather than an empty list when the fetch fails', async () => {
    // An empty list would read as "nobody has roles" — the one misreading that
    // could empty a server.
    const guild = fakeGuild([]);
    guild.members.fetch.mockRejectedValue(new Error('Missing Intents'));

    expect(await fetchMembers(guild)).toBeNull();
    expect(console.error).toHaveBeenCalled();
  });
});

describe('sweepGuild', () => {
  it('kicks a roleless member past the deadline, with a reason', async () => {
    const overdue = withPosition(guildMember({ id: 'u1', daysAgo: 9 }), 1);
    const guild = fakeGuild([overdue]);

    const result = await sweepGuild(guild, { config: config(), now: NOW });

    expect(overdue.kick).toHaveBeenCalledWith(KICK_REASON);
    expect(result.kicked.map(m => m.id)).toEqual(['u1']);
  });

  it('DMs the member BEFORE kicking them', async () => {
    // Discord will not deliver to someone you no longer share a guild with.
    const overdue = withPosition(guildMember({ id: 'u1', daysAgo: 9 }), 1);
    const guild = fakeGuild([overdue]);

    await sweepGuild(guild, { config: config(), now: NOW });

    expect(overdue.send).toHaveBeenCalled();
    expect(overdue.send.mock.invocationCallOrder[0]).toBeLessThan(
      overdue.kick.mock.invocationCallOrder[0]
    );
  });

  it('still kicks when the DM cannot be delivered', async () => {
    const overdue = withPosition(guildMember({ id: 'u1', daysAgo: 9, dmFails: true }), 1);
    const guild = fakeGuild([overdue]);

    const result = await sweepGuild(guild, { config: config(), now: NOW });

    expect(overdue.kick).toHaveBeenCalled();
    expect(result.kicked[0].dmDelivered).toBe(false);
  });

  it('reminds a member approaching the deadline without kicking them', async () => {
    const soon = withPosition(guildMember({ id: 'u1', daysAgo: 6 }), 1);
    const guild = fakeGuild([soon]);

    const result = await sweepGuild(guild, { config: config(), now: NOW });

    expect(soon.send).toHaveBeenCalled();
    expect(soon.kick).not.toHaveBeenCalled();
    expect(result.warned.map(m => m.id)).toEqual(['u1']);
  });

  it('never touches a member who has a role', async () => {
    const safe = withPosition(guildMember({ id: 'u1', daysAgo: 400, roleIds: ['r1'] }), 1);
    const guild = fakeGuild([safe]);

    await sweepGuild(guild, { config: config(), now: NOW });

    expect(safe.kick).not.toHaveBeenCalled();
    expect(safe.send).not.toHaveBeenCalled();
  });

  it('never touches a bot', async () => {
    const bot = withPosition(guildMember({ id: 'b1', daysAgo: 400, bot: true }), 1);
    const guild = fakeGuild([bot]);

    await sweepGuild(guild, { config: config(), now: NOW });

    expect(bot.kick).not.toHaveBeenCalled();
  });

  it('never touches anyone who joined before the cutoff', async () => {
    const old = withPosition(guildMember({ id: 'u1', daysAgo: 400 }), 1);
    const guild = fakeGuild([old]);

    const result = await sweepGuild(guild, { config: config({ enabledAt: NOW - DAY_MS }), now: NOW });

    expect(old.kick).not.toHaveBeenCalled();
    expect(result.kicked).toEqual([]);
  });

  it('re-checks roles against the live member before kicking', async () => {
    // Somebody who picked a role seconds ago must not be removed for not having
    // one, however stale the classification snapshot is.
    const member = withPosition(guildMember({ id: 'u1', daysAgo: 9 }), 1);
    const guild = fakeGuild([member]);

    guild.members.fetch.mockImplementation(async id => {
      if (id === undefined) return new Map([['u1', member]]);
      // By the time the kick comes round, they have a role.
      member.roles.cache.set('r1', {});
      return member;
    });

    const result = await sweepGuild(guild, { config: config(), now: NOW });

    expect(member.kick).not.toHaveBeenCalled();
    expect(result.kicked).toEqual([]);
  });

  it('reports a kick the bot is not allowed to make', async () => {
    const member = withPosition(guildMember({ id: 'u1', daysAgo: 9 }), 1);
    const guild = fakeGuild([member], { canKick: false });

    const result = await sweepGuild(guild, { config: config(), now: NOW });

    expect(member.kick).not.toHaveBeenCalled();
    expect(result.blocked).toEqual([
      expect.objectContaining({ reason: expect.stringContaining('Kick Members') })
    ]);
  });

  it('never kicks the server owner', async () => {
    const owner = withPosition(guildMember({ id: 'owner', daysAgo: 9 }), 1);
    const guild = fakeGuild([owner], { ownerId: 'owner' });

    const result = await sweepGuild(guild, { config: config(), now: NOW });

    expect(owner.kick).not.toHaveBeenCalled();
    expect(result.blocked[0].reason).toContain('owner');
  });

  it('reports a member ranked above the bot rather than failing silently', async () => {
    const admin = withPosition(guildMember({ id: 'u1', daysAgo: 9 }), 50);
    const guild = fakeGuild([admin], { botPosition: 10 });

    const result = await sweepGuild(guild, { config: config(), now: NOW });

    expect(admin.kick).not.toHaveBeenCalled();
    expect(result.blocked[0].reason).toContain('at or above the bot');
  });

  it('records a kick that Discord rejects', async () => {
    const member = withPosition(guildMember({ id: 'u1', daysAgo: 9, kickable: false }), 1);
    const guild = fakeGuild([member]);

    const result = await sweepGuild(guild, { config: config(), now: NOW });

    expect(result.kicked).toEqual([]);
    expect(result.blocked[0].reason).toBe('Missing Permissions');
  });

  it('caps how many it removes in one pass', async () => {
    const members = Array.from({ length: MAX_KICKS_PER_SWEEP + 5 }, (_, i) =>
      withPosition(guildMember({ id: `u${i}`, daysAgo: 9 + i }), 1)
    );
    const guild = fakeGuild(members);

    const result = await sweepGuild(guild, { config: config(), now: NOW });

    expect(result.kicked).toHaveLength(MAX_KICKS_PER_SWEEP);
    expect(result.capped).toBe(true);
  });

  it('removes the most overdue first when capped', async () => {
    const members = Array.from({ length: MAX_KICKS_PER_SWEEP + 2 }, (_, i) =>
      withPosition(guildMember({ id: `u${i}`, daysAgo: 8 + i }), 1)
    );
    const guild = fakeGuild(members);

    const result = await sweepGuild(guild, { config: config(), now: NOW });

    // u11 is the oldest of the batch.
    expect(result.kicked[0].id).toBe(`u${MAX_KICKS_PER_SWEEP + 1}`);
  });

  it('touches nobody on a dry run', async () => {
    const overdue = withPosition(guildMember({ id: 'u1', daysAgo: 9 }), 1);
    const due = withPosition(guildMember({ id: 'u2', daysAgo: 6 }), 1);
    const guild = fakeGuild([overdue, due]);

    const result = await sweepGuild(guild, { config: config(), now: NOW, dryRun: true });

    expect(overdue.kick).not.toHaveBeenCalled();
    expect(overdue.send).not.toHaveBeenCalled();
    expect(due.send).not.toHaveBeenCalled();
    expect(recordSweep).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
  });

  it('does nothing at all when the member list cannot be read', async () => {
    const guild = fakeGuild([]);
    guild.members.fetch.mockRejectedValue(new Error('Missing Intents'));

    expect(await sweepGuild(guild, { config: config(), now: NOW })).toBeNull();
  });

  it('forgets the warning record for somebody it just removed', async () => {
    const overdue = withPosition(guildMember({ id: 'u1', daysAgo: 9 }), 1);
    const guild = fakeGuild([overdue]);

    await sweepGuild(guild, { config: config(), now: NOW });

    expect(recordSweep).toHaveBeenCalledWith(expect.objectContaining({ keepIds: [] }));
  });

  it('keeps tracking members still inside the grace period', async () => {
    const fresh = withPosition(guildMember({ id: 'u1', daysAgo: 1 }), 1);
    const guild = fakeGuild([fresh]);

    await sweepGuild(guild, { config: config(), now: NOW });

    expect(recordSweep).toHaveBeenCalledWith(expect.objectContaining({ keepIds: ['u1'] }));
  });
});

describe('inspectGuild', () => {
  it('classifies without touching anybody', async () => {
    const overdue = withPosition(guildMember({ id: 'u1', daysAgo: 9 }), 1);
    const guild = fakeGuild([overdue]);

    const result = await inspectGuild(guild, { config: config(), now: NOW });

    expect(result.kick.map(m => m.id)).toEqual(['u1']);
    expect(overdue.kick).not.toHaveBeenCalled();
  });

  it('is null when the member list cannot be read', async () => {
    const guild = fakeGuild([]);
    guild.members.fetch.mockRejectedValue(new Error('nope'));

    expect(await inspectGuild(guild, { config: config(), now: NOW })).toBeNull();
  });
});

describe('runSweep', () => {
  function clientWith(guilds) {
    return { guilds: { cache: new Map(guilds.map(guild => [guild.id, guild])) } };
  }

  it('posts a record of what it did', async () => {
    const guild = fakeGuild([withPosition(guildMember({ id: 'u1', daysAgo: 9 }), 1)]);

    await runSweep(clientWith([guild]), { config: config(), now: NOW });

    expect(sendAlert).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'mod-log' }));
  });

  it('stays quiet when there was nothing to do', async () => {
    const guild = fakeGuild([withPosition(guildMember({ id: 'u1', daysAgo: 1 }), 1)]);

    await runSweep(clientWith([guild]), { config: config(), now: NOW });

    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('records when the sweep last ran', async () => {
    const guild = fakeGuild([]);

    await runSweep(clientWith([guild]), { config: config(), now: NOW });

    expect(saveConfig).toHaveBeenCalledWith({ lastSweepAt: NOW });
  });

  it('does not stamp the clock on a dry run', async () => {
    const guild = fakeGuild([]);

    await runSweep(clientWith([guild]), { config: config(), now: NOW, dryRun: true });

    expect(saveConfig).not.toHaveBeenCalled();
  });
});

describe('startOnboardingSweeper', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function clientWith(guilds) {
    return { guilds: { cache: new Map(guilds.map(guild => [guild.id, guild])) } };
  }

  it('does nothing while the sweep is switched off', () => {
    loadConfig.mockReturnValue(config({ enabled: false }));
    const guild = fakeGuild([withPosition(guildMember({ id: 'u1', daysAgo: 99 }), 1)]);

    startOnboardingSweeper(clientWith([guild]), { intervalMs: 1000, now: () => NOW });
    jest.advanceTimersByTime(5000);

    expect(guild.members.fetch).not.toHaveBeenCalled();
  });

  it('runs once switched on', async () => {
    const guild = fakeGuild([withPosition(guildMember({ id: 'u1', daysAgo: 9 }), 1)]);

    startOnboardingSweeper(clientWith([guild]), { intervalMs: 1000, now: () => NOW });
    jest.advanceTimersByTime(1000);
    await Promise.resolve();

    expect(guild.members.fetch).toHaveBeenCalled();
  });

  it('stops when told to', () => {
    const guild = fakeGuild([]);
    const stop = startOnboardingSweeper(clientWith([guild]), { intervalMs: 1000, now: () => NOW });

    stop();
    jest.advanceTimersByTime(10_000);

    expect(guild.members.fetch).not.toHaveBeenCalled();
  });
});

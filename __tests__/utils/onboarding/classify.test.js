const {
  DAY_MS,
  classifyMembers,
  daysRemaining,
  describeMember,
  exemptionFor
} = require('../../../utils/onboarding/classify');

const NOW = Date.UTC(2026, 8, 14, 12, 0, 0);
const GUILD_ID = 'guild-1';

function config(overrides = {}) {
  return { graceDays: 7, warnAfterDays: 5, enabledAt: null, ...overrides };
}

/** A described member, `daysAgo` days into the server. */
function member(id, { daysAgo = 0, roleCount = 0, isBot = false, joined } = {}) {
  return {
    id,
    tag: `${id}#0001`,
    joinedTimestamp: joined === undefined ? NOW - daysAgo * DAY_MS : joined,
    roleCount,
    isBot
  };
}

/** A discord.js-shaped GuildMember, for describeMember only. */
function guildMember({ id = 'u1', roleIds = [], bot = false, joinedTimestamp = NOW } = {}) {
  return {
    id,
    joinedTimestamp,
    user: { bot, tag: `${id}#0001` },
    roles: { cache: new Map([[GUILD_ID, {}], ...roleIds.map(roleId => [roleId, {}])]) }
  };
}

describe('describeMember', () => {
  it('does not count @everyone as a chosen role', () => {
    // @everyone is always in roles.cache and nobody picks it.
    expect(describeMember(guildMember({ roleIds: [] }), GUILD_ID).roleCount).toBe(0);
  });

  it('counts real roles', () => {
    expect(describeMember(guildMember({ roleIds: ['r1', 'r2'] }), GUILD_ID).roleCount).toBe(2);
  });

  it('carries the bot flag through', () => {
    expect(describeMember(guildMember({ bot: true }), GUILD_ID).isBot).toBe(true);
  });

  it('reports an unknown join date as null rather than zero', () => {
    // Zero would read as 1970 — ancient, and therefore instantly kickable.
    expect(describeMember(guildMember({ joinedTimestamp: null }), GUILD_ID).joinedTimestamp).toBeNull();
  });

  it('survives a member with no cached roles', () => {
    expect(describeMember({ id: 'u1' }, GUILD_ID)).toMatchObject({ roleCount: 0, joinedTimestamp: null });
  });
});

describe('exemptionFor', () => {
  it('never touches bots', () => {
    expect(exemptionFor(member('bot', { daysAgo: 30, isBot: true }), config())).toBe('a bot');
  });

  it('exempts anyone holding a role', () => {
    expect(exemptionFor(member('u1', { daysAgo: 30, roleCount: 1 }), config())).toBe('has a role');
  });

  it('refuses to act on an unknown join date', () => {
    // Missing data must never be grounds for removal.
    expect(exemptionFor(member('u1', { joined: null }), config())).toBe('join date unknown');
  });

  it('exempts members who predate the cutoff', () => {
    const cutoff = NOW - 10 * DAY_MS;
    expect(exemptionFor(member('u1', { daysAgo: 30 }), config({ enabledAt: cutoff }))).toBe(
      'joined before the sweep was switched on'
    );
  });

  it('does not exempt someone who joined after the cutoff', () => {
    const cutoff = NOW - 10 * DAY_MS;
    expect(exemptionFor(member('u1', { daysAgo: 8 }), config({ enabledAt: cutoff }))).toBeNull();
  });
});

describe('classifyMembers', () => {
  it('kicks a roleless member past the grace period', () => {
    const { kick } = classifyMembers([member('u1', { daysAgo: 8 })], config(), { now: NOW });
    expect(kick.map(m => m.id)).toEqual(['u1']);
  });

  it('kicks exactly on the deadline', () => {
    const { kick } = classifyMembers([member('u1', { daysAgo: 7 })], config(), { now: NOW });
    expect(kick).toHaveLength(1);
  });

  it('warns between the reminder day and the deadline', () => {
    const { warn, kick } = classifyMembers([member('u1', { daysAgo: 5 })], config(), { now: NOW });

    expect(warn.map(m => m.id)).toEqual(['u1']);
    expect(kick).toEqual([]);
  });

  it('does not warn the same person twice', () => {
    const { warn, waiting } = classifyMembers([member('u1', { daysAgo: 5 })], config(), {
      now: NOW,
      isWarned: id => id === 'u1'
    });

    expect(warn).toEqual([]);
    expect(waiting.map(m => m.id)).toEqual(['u1']);
  });

  it('still kicks someone who was already warned', () => {
    const { kick } = classifyMembers([member('u1', { daysAgo: 9 })], config(), {
      now: NOW,
      isWarned: () => true
    });

    expect(kick).toHaveLength(1);
  });

  it('leaves a fresh joiner alone', () => {
    const { waiting, warn, kick } = classifyMembers([member('u1', { daysAgo: 1 })], config(), { now: NOW });

    expect(waiting.map(m => m.id)).toEqual(['u1']);
    expect(warn).toEqual([]);
    expect(kick).toEqual([]);
  });

  it('never kicks a member who picked a role, however long they waited', () => {
    const { kick, exempt } = classifyMembers([member('u1', { daysAgo: 400, roleCount: 1 })], config(), {
      now: NOW
    });

    expect(kick).toEqual([]);
    expect(exempt).toHaveLength(1);
  });

  it('removes nobody when the cutoff postdates everyone', () => {
    // This is the guarantee behind "only applies to new joiners".
    const members = [member('u1', { daysAgo: 30 }), member('u2', { daysAgo: 400 })];
    const { kick, warn } = classifyMembers(members, config({ enabledAt: NOW }), { now: NOW });

    expect(kick).toEqual([]);
    expect(warn).toEqual([]);
  });

  it('puts the longest-waiting first, so a capped sweep takes the most overdue', () => {
    const members = [
      member('newer', { daysAgo: 8 }),
      member('oldest', { daysAgo: 30 }),
      member('middle', { daysAgo: 12 })
    ];

    expect(classifyMembers(members, config(), { now: NOW }).kick.map(m => m.id)).toEqual([
      'oldest',
      'middle',
      'newer'
    ]);
  });

  it('separates a mixed server correctly', () => {
    const members = [
      member('bot', { daysAgo: 30, isBot: true }),
      member('hasrole', { daysAgo: 30, roleCount: 2 }),
      member('overdue', { daysAgo: 10 }),
      member('duewarning', { daysAgo: 6 }),
      member('fresh', { daysAgo: 2 })
    ];

    const result = classifyMembers(members, config(), { now: NOW });

    expect(result.kick.map(m => m.id)).toEqual(['overdue']);
    expect(result.warn.map(m => m.id)).toEqual(['duewarning']);
    expect(result.waiting.map(m => m.id)).toEqual(['fresh']);
    expect(result.exempt.map(m => m.id).sort()).toEqual(['bot', 'hasrole']);
  });

  it('handles an empty server', () => {
    expect(classifyMembers([], config(), { now: NOW })).toEqual({
      kick: [],
      warn: [],
      waiting: [],
      exempt: []
    });
  });
});

describe('daysRemaining', () => {
  it('counts down to the deadline', () => {
    expect(daysRemaining(member('u1', { daysAgo: 2 }), config(), NOW)).toBe(5);
  });

  it('never goes negative', () => {
    expect(daysRemaining(member('u1', { daysAgo: 30 }), config(), NOW)).toBe(0);
  });

  it('is null when the join date is unknown', () => {
    expect(daysRemaining(member('u1', { joined: null }), config(), NOW)).toBeNull();
  });
});

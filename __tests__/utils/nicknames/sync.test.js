jest.mock('../../../utils/reports/links', () => ({
  ...jest.requireActual('../../../utils/reports/links'),
  mainFor: jest.fn()
}));

const { PermissionFlagsBits } = require('discord.js');

const { mainFor } = require('../../../utils/reports/links');
const {
  MAX_NICKNAME_LENGTH,
  applyPlan,
  canRename,
  desiredNickname,
  planFor,
  planGuild,
  syncGuild,
  syncMember
} = require('../../../utils/nicknames/sync');

function member({
  id = 'u1',
  nickname = null,
  displayName = 'Someone',
  position = 1,
  setFails = false
} = {}) {
  return {
    id,
    nickname,
    displayName,
    roles: { highest: { position, comparePositionTo: other => position - other.position } },
    setNickname: jest.fn(async () => {
      if (setFails) throw new Error('Missing Permissions');
    })
  };
}

function guild({ canManage = true, ownerId = 'owner', botPosition = 10 } = {}) {
  return {
    id: 'g1',
    ownerId,
    members: {
      me: {
        permissions: { has: flag => canManage && flag === PermissionFlagsBits.ManageNicknames },
        roles: {
          highest: {
            position: botPosition,
            comparePositionTo: other => botPosition - other.position
          }
        }
      }
    }
  };
}

const BUTUD = { name: 'Butud', realm: 'Nightslayer', main: true };

beforeEach(() => {
  jest.clearAllMocks();
  mainFor.mockReturnValue(BUTUD);
});

describe('desiredNickname', () => {
  it('is the character name', () => {
    expect(desiredNickname(BUTUD)).toBe('Butud');
  });

  it('trims to Discord\'s 32-character cap rather than failing', () => {
    const long = desiredNickname({ name: 'x'.repeat(50) });
    expect(long.length).toBe(MAX_NICKNAME_LENGTH);
  });

  it('is null when there is no character', () => {
    expect(desiredNickname(null)).toBeNull();
    expect(desiredNickname({ name: '   ' })).toBeNull();
  });
});

describe('canRename', () => {
  it('allows an ordinary member', () => {
    expect(canRename(guild(), member())).toEqual({ ok: true });
  });

  it('never allows renaming the server owner', () => {
    // Discord forbids this outright; no permission grants it.
    const result = canRename(guild({ ownerId: 'u1' }), member({ id: 'u1' }));

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('server owner') });
  });

  it('refuses somebody ranked at or above the bot', () => {
    // The usual case for officers, and the reason refusals are reported.
    const result = canRename(guild({ botPosition: 5 }), member({ position: 9 }));

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('at or above') });
  });

  it('refuses without the Manage Nicknames permission', () => {
    expect(canRename(guild({ canManage: false }), member())).toMatchObject({
      ok: false,
      reason: expect.stringContaining('Manage Nicknames')
    });
  });
});

describe('planFor', () => {
  it('plans a rename when the nickname is wrong', () => {
    expect(planFor(guild(), member({ nickname: 'Old' }), BUTUD)).toMatchObject({
      action: 'rename',
      from: 'Old',
      to: 'Butud'
    });
  });

  it('does nothing when the nickname is already right', () => {
    expect(planFor(guild(), member({ nickname: 'Butud' }), BUTUD)).toMatchObject({
      action: 'skip',
      reason: 'already correct'
    });
  });

  it('skips somebody with no main', () => {
    expect(planFor(guild(), member(), null)).toMatchObject({ action: 'skip', reason: 'no main set' });
  });

  it('carries the refusal reason through, rather than just declining', () => {
    const plan = planFor(guild({ botPosition: 1 }), member({ position: 9 }), BUTUD);

    expect(plan).toMatchObject({ action: 'skip', to: 'Butud' });
    expect(plan.reason).toContain('at or above');
  });
});

describe('applyPlan', () => {
  it('renames', async () => {
    const target = member({ nickname: 'Old' });
    await applyPlan(target, { action: 'rename', to: 'Butud' });

    expect(target.setNickname).toHaveBeenCalledWith('Butud', expect.any(String));
  });

  it('does nothing for a skip', async () => {
    const target = member();
    await applyPlan(target, { action: 'skip', reason: 'already correct' });

    expect(target.setNickname).not.toHaveBeenCalled();
  });

  it('turns a rejection into a skip with the reason', async () => {
    const target = member({ setFails: true });
    const result = await applyPlan(target, { action: 'rename', to: 'Butud' });

    expect(result).toMatchObject({ action: 'skip', reason: 'Missing Permissions' });
  });
});

describe('syncMember', () => {
  it('renames a member to their main', async () => {
    const target = member({ nickname: 'Old' });
    await syncMember(guild(), target);

    expect(target.setNickname).toHaveBeenCalledWith('Butud', expect.any(String));
  });

  it('leaves somebody with no linked character alone', async () => {
    mainFor.mockReturnValue(null);
    const target = member();

    expect(await syncMember(guild(), target)).toBeNull();
    expect(target.setNickname).not.toHaveBeenCalled();
  });
});

describe('planGuild', () => {
  it('ignores members who have linked nothing', () => {
    // The bot has no opinion about anybody else's name.
    mainFor.mockImplementation(id => (id === 'linked' ? BUTUD : null));

    const plans = planGuild(guild(), [member({ id: 'linked' }), member({ id: 'other' })]);

    expect(plans).toHaveLength(1);
  });
});

describe('syncGuild', () => {
  it('separates what it did from what it could not', async () => {
    const ordinary = member({ id: 'a', nickname: 'Old' });
    const officer = member({ id: 'b', position: 99 });

    const { renamed, skipped } = await syncGuild(guild({ botPosition: 10 }), [ordinary, officer]);

    expect(renamed.map(entry => entry.member.id)).toEqual(['a']);
    expect(skipped.map(entry => entry.member.id)).toEqual(['b']);
  });

  it('carries on after one member fails', async () => {
    const broken = member({ id: 'a', setFails: true });
    const fine = member({ id: 'b', nickname: 'Old' });

    const { renamed } = await syncGuild(guild(), [broken, fine]);

    expect(renamed.map(entry => entry.member.id)).toEqual(['b']);
  });
});

const { act, deleteMessage, preflight } = require('../../../utils/spam/enforcement');
const { createMember, createMessage } = require('../../helpers/message');

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

const decision = (overrides = {}) => ({
  action: 'ban',
  durationMs: 3600000,
  reason: 'Spam detection [suspicious]: test',
  ...overrides
});

describe('preflight', () => {
  it('allows a normal action', () => {
    const message = createMessage();
    expect(preflight({ guild: message.guild, member: message.member, action: 'ban' })).toEqual({
      ok: true
    });
  });

  it('refuses when the bot lacks the permission', () => {
    const message = createMessage({ botCanAct: false });

    const result = preflight({ guild: message.guild, member: message.member, action: 'ban' });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('Ban Members');
  });

  it('names the right permission for a timeout', () => {
    const message = createMessage({ botCanAct: false });

    expect(
      preflight({ guild: message.guild, member: message.member, action: 'timeout' }).reason
    ).toContain('Moderate Members');
  });

  it('refuses to touch the server owner', () => {
    const member = createMember({ id: 'owner1' });
    const message = createMessage({ member, ownerId: 'owner1' });

    expect(preflight({ guild: message.guild, member, action: 'ban' })).toEqual({
      ok: false,
      reason: 'the target is the server owner'
    });
  });

  it('refuses a target ranked at or above the bot', () => {
    const member = createMember({ highestRolePosition: 20 });
    const message = createMessage({ member, botRolePosition: 10 });

    expect(preflight({ guild: message.guild, member, action: 'ban' }).reason).toContain(
      'ranked at or above the bot'
    );
  });

  it('refuses a timeout Discord says is impossible', () => {
    const member = createMember({ moderatable: false });
    const message = createMessage({ member });

    expect(preflight({ guild: message.guild, member, action: 'timeout' }).reason).toContain(
      'not moderatable'
    );
  });

  it('refuses when the bot is not cached in the guild', () => {
    expect(preflight({ guild: {}, member: createMember(), action: 'ban' }).ok).toBe(false);
  });
});

describe('deleteMessage', () => {
  it('reports success', async () => {
    const message = createMessage();
    await expect(deleteMessage(message)).resolves.toBe(true);
  });

  it('tolerates an already-deleted message', async () => {
    const message = createMessage();
    message.delete.mockRejectedValue(new Error('Unknown Message'));

    await expect(deleteMessage(message)).resolves.toBe(false);
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('act', () => {
  it('deletes then bans, purging the rest of the wave', async () => {
    const message = createMessage();
    const member = message.member;

    const outcome = await act({ message, member, decision: decision() });

    expect(message.delete).toHaveBeenCalled();
    expect(member.ban).toHaveBeenCalledWith({
      reason: 'Spam detection [suspicious]: test',
      deleteMessageSeconds: 3600
    });
    expect(outcome).toEqual({ acted: true, action: 'ban', deleted: true, blockedReason: null });
  });

  it('times out with the configured duration', async () => {
    const message = createMessage();
    const member = message.member;

    await act({ message, member, decision: decision({ action: 'timeout', durationMs: 900000 }) });

    expect(member.timeout).toHaveBeenCalledWith(900000, 'Spam detection [suspicious]: test');
    expect(member.ban).not.toHaveBeenCalled();
  });

  it('does not act when the preflight refuses, and says why', async () => {
    const message = createMessage({ botCanAct: false });
    const member = message.member;

    const outcome = await act({ message, member, decision: decision() });

    expect(member.ban).not.toHaveBeenCalled();
    expect(outcome.acted).toBe(false);
    expect(outcome.blockedReason).toContain('Ban Members');
    // The message is still removed even when the ban cannot happen.
    expect(outcome.deleted).toBe(true);
  });

  it('reports a failure thrown by Discord rather than throwing', async () => {
    const message = createMessage();
    const member = message.member;
    member.ban.mockRejectedValue(new Error('Missing Permissions'));

    const outcome = await act({ message, member, decision: decision() });

    expect(outcome).toMatchObject({ acted: false, blockedReason: 'Missing Permissions' });
    expect(console.error).toHaveBeenCalled();
  });
});

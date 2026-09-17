const { PermissionFlagsBits } = require('discord.js');
const {
  ALLOWED,
  DENIED,
  adminRoles,
  canLock,
  isLocked,
  lockChannel,
  postingRoleOverwrites,
  unlockChannel
} = require('../../utils/channelLock');

const EVERYONE = 'guild-1';

/** A role whose server-wide permissions are the given flags. */
function role(id, permissions = []) {
  return { id, permissions: { has: flag => permissions.includes(flag) } };
}

/** An existing channel overwrite, as discord.js exposes it. */
function overwrite(id, { allow = [], deny = [] } = {}) {
  return {
    id,
    allow: { has: flag => allow.includes(flag) },
    deny: { has: flag => deny.includes(flag) }
  };
}

function fakeChannel({
  canManage = true,
  overwrites = [],
  roles = [],
  editFails = false
} = {}) {
  const edit = jest.fn(async id => {
    if (editFails) throw new Error('Missing Permissions');
    return { id };
  });

  return {
    id: 'channel-1',
    guild: {
      id: EVERYONE,
      roles: {
        everyone: { id: EVERYONE },
        cache: new Map([[EVERYONE, role(EVERYONE)], ...roles.map(r => [r.id, r])])
      },
      members: {
        me: { permissionsIn: () => ({ has: flag => canManage && flag === PermissionFlagsBits.ManageRoles }) }
      }
    },
    permissionOverwrites: {
      edit,
      cache: new Map(overwrites.map(o => [o.id, o]))
    }
  };
}

/** The permission object passed to a permissionOverwrites.edit call. */
function editFor(channel, id) {
  const call = channel.permissionOverwrites.edit.mock.calls.find(([target]) => target === id);
  return call?.[1] ?? null;
}

describe('canLock', () => {
  it('requires Manage Permissions in the channel, not Manage Channels', () => {
    expect(canLock(fakeChannel()).ok).toBe(true);
    expect(canLock(fakeChannel({ canManage: false }))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('Manage Permissions')
    });
  });

  it('refuses when the bot is not cached', () => {
    expect(canLock({ guild: {} }).ok).toBe(false);
  });
});

describe('adminRoles', () => {
  it('includes roles with Manage Server as well as Administrator', () => {
    // A Manage Server role does NOT bypass a ViewChannel denial the way
    // Administrator does, so it has to be granted access explicitly.
    const channel = fakeChannel({
      roles: [
        role('admin', [PermissionFlagsBits.Administrator]),
        role('mod', [PermissionFlagsBits.ManageGuild]),
        role('member', [])
      ]
    });

    expect(adminRoles(channel.guild).map(r => r.id).sort()).toEqual(['admin', 'mod']);
  });

  it('never includes @everyone', () => {
    const channel = fakeChannel({ roles: [] });
    expect(adminRoles(channel.guild)).toEqual([]);
  });
});

describe('postingRoleOverwrites', () => {
  it('finds roles whose channel overwrite grants posting', () => {
    // These beat the @everyone denial, so the lock has to clear them too.
    const channel = fakeChannel({
      overwrites: [
        overwrite('chatty', { allow: [PermissionFlagsBits.SendMessages] }),
        overwrite('quiet', { deny: [PermissionFlagsBits.SendMessages] })
      ]
    });

    const found = postingRoleOverwrites(channel, { botId: 'bot-1', everyoneId: EVERYONE });

    expect(found.map(o => o.id)).toEqual(['chatty']);
  });

  it('ignores @everyone and the bot', () => {
    const channel = fakeChannel({
      overwrites: [
        overwrite(EVERYONE, { allow: [PermissionFlagsBits.SendMessages] }),
        overwrite('bot-1', { allow: [PermissionFlagsBits.SendMessages] })
      ]
    });

    expect(postingRoleOverwrites(channel, { botId: 'bot-1', everyoneId: EVERYONE })).toEqual([]);
  });
});

describe('lockChannel — public', () => {
  it('lets everyone read but nobody write', async () => {
    const channel = fakeChannel();
    const result = await lockChannel(channel, { botId: 'bot-1' });

    expect(result.ok).toBe(true);

    const everyone = editFor(channel, EVERYONE);
    expect(everyone.ViewChannel).toBe(true);
    expect(everyone.SendMessages).toBe(false);
  });

  it('denies slash commands, so replies cannot bury the post', async () => {
    const channel = fakeChannel();
    await lockChannel(channel, { botId: 'bot-1' });

    expect(editFor(channel, EVERYONE).UseApplicationCommands).toBe(false);
  });

  it('denies every content-creating permission', async () => {
    const channel = fakeChannel();
    await lockChannel(channel, { botId: 'bot-1' });

    const everyone = editFor(channel, EVERYONE);
    DENIED.forEach(permission => expect(everyone[permission]).toBe(false));
  });

  it('keeps the bot able to post', async () => {
    const channel = fakeChannel();
    await lockChannel(channel, { botId: 'bot-1' });

    expect(editFor(channel, 'bot-1')).toMatchObject({ SendMessages: true, ViewChannel: true });
  });

  it('revokes role overwrites that would beat the @everyone denial', async () => {
    const channel = fakeChannel({
      overwrites: [overwrite('chatty', { allow: [PermissionFlagsBits.SendMessages] })]
    });

    const result = await lockChannel(channel, { botId: 'bot-1' });

    expect(result.clearedRoles).toEqual(['chatty']);
    expect(editFor(channel, 'chatty')).toEqual({ SendMessages: false });
  });

  it('reports failure rather than claiming a lock it did not apply', async () => {
    const channel = fakeChannel({ canManage: false });

    expect(await lockChannel(channel, { botId: 'bot-1' })).toMatchObject({ ok: false });
  });

  it('fails cleanly when Discord rejects the @everyone edit', async () => {
    const channel = fakeChannel({ editFails: true });

    expect(await lockChannel(channel, { botId: 'bot-1' })).toMatchObject({
      ok: false,
      reason: 'Missing Permissions'
    });
  });
});

describe('lockChannel — admin-only', () => {
  function adminChannel() {
    return fakeChannel({
      roles: [role('mod', [PermissionFlagsBits.ManageGuild]), role('member', [])]
    });
  }

  it('hides the channel from everyone', async () => {
    const channel = adminChannel();
    const result = await lockChannel(channel, { botId: 'bot-1', visibility: 'admins' });

    expect(result.hidden).toBe(true);
    expect(editFor(channel, EVERYONE).ViewChannel).toBe(false);
  });

  it('grants read access to roles that can manage the server', async () => {
    const channel = adminChannel();
    const result = await lockChannel(channel, { botId: 'bot-1', visibility: 'admins' });

    expect(result.grantedRoles).toEqual(['mod']);
    expect(editFor(channel, 'mod')).toMatchObject({ ViewChannel: true, SendMessages: false });
  });

  it('does not grant access to ordinary roles', async () => {
    const channel = adminChannel();
    await lockChannel(channel, { botId: 'bot-1', visibility: 'admins' });

    expect(editFor(channel, 'member')).toBeNull();
  });

  it('warns when no role can see it, since that is easy to miss', async () => {
    const channel = fakeChannel({ roles: [role('member', [])] });
    const result = await lockChannel(channel, { botId: 'bot-1', visibility: 'admins' });

    expect(result.warnings).toEqual([expect.stringContaining('Administrator')]);
  });
});

describe('unlockChannel', () => {
  it('clears the denials rather than granting anything', async () => {
    const channel = fakeChannel();
    const result = await unlockChannel(channel);

    expect(result.ok).toBe(true);
    DENIED.forEach(permission => expect(editFor(channel, EVERYONE)[permission]).toBeNull());
  });

  it('also clears ViewChannel, or a hidden channel would stay invisible', async () => {
    const channel = fakeChannel();
    await unlockChannel(channel);

    ALLOWED.forEach(permission => expect(editFor(channel, EVERYONE)[permission]).toBeNull());
  });

  it('reports a failure', async () => {
    expect(await unlockChannel(fakeChannel({ canManage: false }))).toMatchObject({ ok: false });
  });
});

describe('isLocked', () => {
  it('is true when @everyone cannot post', () => {
    const channel = fakeChannel({
      overwrites: [overwrite(EVERYONE, { deny: [PermissionFlagsBits.SendMessages] })]
    });

    expect(isLocked(channel)).toBe(true);
  });

  it('is false for an ordinary channel', () => {
    expect(isLocked(fakeChannel())).toBe(false);
  });

  it('tolerates a missing channel', () => {
    expect(isLocked(null)).toBe(false);
  });
});

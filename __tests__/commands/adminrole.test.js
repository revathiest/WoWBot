jest.mock('../../utils/adminRoles/config', () => ({
  addRole: jest.fn(),
  getRoleIds: jest.fn(),
  removeRole: jest.fn()
}));

const { PermissionFlagsBits } = require('discord.js');

const { addRole, getRoleIds, removeRole } = require('../../utils/adminRoles/config');
const command = require('../../commands/admin/adminrole');
const { createInteraction } = require('../helpers/interaction');

function interaction({ subcommand, role, permissions = true, roles = [] } = {}) {
  return createInteraction({
    commandName: 'adminrole',
    subcommand,
    options: role ? { role } : {},
    permissions,
    roles
  });
}

function said(fake) {
  const [payload] = fake.reply.mock.calls.at(-1);
  return payload.content;
}

beforeEach(() => {
  jest.clearAllMocks();
  getRoleIds.mockReturnValue([]);
});

describe('command shape', () => {
  it('is named /adminrole and declares Manage Server', () => {
    const json = command.data.toJSON();

    expect(json.name).toBe('adminrole');
    expect(json.default_member_permissions).toBe(String(PermissionFlagsBits.ManageGuild));
  });
});

describe('permissions', () => {
  it('refuses a member without Manage Server', async () => {
    const fake = interaction({ subcommand: 'list', permissions: false });
    await command.execute(fake);

    expect(said(fake)).toContain('Manage Server');
  });

  it('refuses a member whose only access is a configured admin role', async () => {
    // /adminrole manages that very list, so it must not accept it as a credential.
    getRoleIds.mockReturnValue(['granted-role']);
    const fake = interaction({ subcommand: 'list', permissions: false, roles: ['granted-role'] });
    await command.execute(fake);

    expect(said(fake)).toContain('Manage Server');
  });
});

describe('/adminrole add', () => {
  it('grants the role and confirms it', async () => {
    addRole.mockReturnValue(['role-1']);
    const fake = interaction({ subcommand: 'add', role: { id: 'role-1' } });
    await command.execute(fake);

    expect(addRole).toHaveBeenCalledWith('test-guild', 'role-1');
    expect(said(fake)).toContain('can now run admin commands');
  });
});

describe('/adminrole remove', () => {
  it('revokes a role that was configured', async () => {
    getRoleIds.mockReturnValue(['role-1']);
    const fake = interaction({ subcommand: 'remove', role: { id: 'role-1' } });
    await command.execute(fake);

    expect(removeRole).toHaveBeenCalledWith('test-guild', 'role-1');
    expect(said(fake)).toContain('can no longer run admin commands');
  });

  it('reports a role that was never configured', async () => {
    getRoleIds.mockReturnValue([]);
    const fake = interaction({ subcommand: 'remove', role: { id: 'role-1' } });
    await command.execute(fake);

    expect(said(fake)).toContain('did not have admin-command access');
  });
});

describe('/adminrole list', () => {
  it('lists the configured roles', async () => {
    getRoleIds.mockReturnValue(['role-1', 'role-2']);
    const fake = interaction({ subcommand: 'list' });
    await command.execute(fake);

    const [payload] = fake.reply.mock.calls.at(-1);
    const embed = payload.embeds[0].toJSON();
    expect(embed.description).toContain('role-1');
    expect(embed.description).toContain('role-2');
  });

  it('says so when no roles are configured', async () => {
    const fake = interaction({ subcommand: 'list' });
    await command.execute(fake);

    const [payload] = fake.reply.mock.calls.at(-1);
    const embed = payload.embeds[0].toJSON();
    expect(embed.description).toContain('No extra roles configured');
  });
});

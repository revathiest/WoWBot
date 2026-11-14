jest.mock('../../utils/adminRoles/config', () => ({
  getRoleIds: jest.fn()
}));

const { getRoleIds } = require('../../utils/adminRoles/config');
const { hasManageGuild, isAdmin } = require('../../utils/permissions');
const { createInteraction } = require('../helpers/interaction');

beforeEach(() => {
  jest.clearAllMocks();
  getRoleIds.mockReturnValue([]);
});

describe('hasManageGuild', () => {
  it('is true when the member has Manage Server', () => {
    expect(hasManageGuild(createInteraction({ permissions: true }))).toBe(true);
  });

  it('is false without Manage Server and ignores configured roles', () => {
    getRoleIds.mockReturnValue(['admin-role']);
    expect(hasManageGuild(createInteraction({ permissions: false, roles: ['admin-role'] }))).toBe(false);
  });
});

describe('isAdmin', () => {
  it('is true with Manage Server, regardless of configured roles', () => {
    expect(isAdmin(createInteraction({ permissions: true }))).toBe(true);
  });

  it('is false without Manage Server when no admin roles are configured', () => {
    expect(isAdmin(createInteraction({ permissions: false }))).toBe(false);
  });

  it('is true for a member holding a configured admin role', () => {
    getRoleIds.mockReturnValue(['admin-role']);
    expect(isAdmin(createInteraction({ permissions: false, roles: ['admin-role'] }))).toBe(true);
  });

  it('is false for a member whose roles do not include a configured admin role', () => {
    getRoleIds.mockReturnValue(['admin-role']);
    expect(isAdmin(createInteraction({ permissions: false, roles: ['some-other-role'] }))).toBe(false);
  });

  it('looks up roles for the interaction\'s own guild', () => {
    getRoleIds.mockReturnValue(['admin-role']);
    isAdmin(createInteraction({ permissions: false, roles: ['admin-role'] }));
    expect(getRoleIds).toHaveBeenCalledWith('test-guild');
  });

  it('is false when the member has no role cache at all', () => {
    getRoleIds.mockReturnValue(['admin-role']);
    const interaction = createInteraction({ permissions: false });
    interaction.member = undefined;
    expect(isAdmin(interaction)).toBe(false);
  });
});

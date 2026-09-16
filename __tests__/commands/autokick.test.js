jest.mock('../../utils/onboarding/sweep');
jest.mock('../../utils/onboarding/config', () => ({
  ...jest.requireActual('../../utils/onboarding/config'),
  loadConfig: jest.fn(),
  saveConfig: jest.fn(),
  enable: jest.fn(),
  disable: jest.fn()
}));

const { PermissionFlagsBits } = require('discord.js');

const {
  DEFAULTS,
  MAX_KICKS_PER_SWEEP,
  disable,
  enable,
  loadConfig,
  saveConfig
} = require('../../utils/onboarding/config');
const { inspectGuild, sweepGuild } = require('../../utils/onboarding/sweep');
const command = require('../../commands/admin/autokick');
const { createInteraction } = require('../helpers/interaction');

function config(overrides = {}) {
  return { ...DEFAULTS, alertChannelId: 'mod-log', ...overrides };
}

function interaction({ subcommand, subcommandGroup = null, options = {}, permissions = true } = {}) {
  return createInteraction({
    commandName: 'autokick',
    subcommand,
    subcommandGroup,
    options,
    permissions
  });
}

function payloadOf(fake) {
  const call = fake.editReply.mock.calls.at(-1) ?? fake.reply.mock.calls.at(-1);
  return call[0];
}

function said(fake) {
  const payload = payloadOf(fake);
  return typeof payload === 'string' ? payload : payload.content;
}

beforeEach(() => {
  jest.clearAllMocks();
  loadConfig.mockReturnValue(config());
  saveConfig.mockImplementation(changes => ({ ...config(), ...changes }));
  enable.mockReturnValue(config({ enabled: true, enabledAt: Date.now() }));
  disable.mockReturnValue(config({ enabled: false }));
  inspectGuild.mockResolvedValue({ kick: [], warn: [], waiting: [], exempt: [], memberCount: 0 });
  sweepGuild.mockResolvedValue({ kicked: [], warned: [], blocked: [], capped: false, dryRun: false });
});

describe('command shape', () => {
  it('is named /autokick and declares Manage Server', () => {
    const json = command.data.toJSON();

    expect(json.name).toBe('autokick');
    expect(json.default_member_permissions).toBe(String(PermissionFlagsBits.ManageGuild));
  });

  it('requires an explicit confirmation on the manual run', () => {
    const run = command.data.toJSON().options.find(option => option.name === 'run');
    const confirm = run.options.find(option => option.name === 'confirm');

    expect(confirm.required).toBe(true);
  });
});

describe('permissions', () => {
  it('refuses a member without Manage Server', async () => {
    const fake = interaction({ subcommand: 'status', permissions: false });
    await command.execute(fake);

    expect(said(fake)).toContain('Manage Server');
    expect(loadConfig).not.toHaveBeenCalled();
  });
});

describe('/autokick status', () => {
  it('says it is off by default', () => {
    expect(command.buildStatusEmbed(config()).toJSON().description).toContain('Disabled');
  });

  it('shows the grace period and reminder when on', () => {
    const embed = command.buildStatusEmbed(config({ enabled: true, graceDays: 7, warnAfterDays: 5 }));
    expect(embed.toJSON().description).toContain('**7 days**');
  });

  it('always explains the cutoff, since that is what protects existing members', () => {
    const fields = command.buildStatusEmbed(config()).toJSON().fields;
    const cutoff = fields.find(f => f.name === 'Cutoff');

    expect(cutoff.value).toContain('nobody');
  });

  it('names the cutoff date once one is stamped', () => {
    const embed = command.buildStatusEmbed(config({ enabled: true, enabledAt: 1_800_000_000_000 }));
    const cutoff = embed.toJSON().fields.find(f => f.name === 'Cutoff');

    expect(cutoff.value).toContain('<t:');
    expect(cutoff.value).toContain('permanently exempt');
  });

  it('shows the per-sweep cap', () => {
    const fields = command.buildStatusEmbed(config()).toJSON().fields;
    expect(fields.find(f => f.name === 'Max per sweep').value).toBe(String(MAX_KICKS_PER_SWEEP));
  });
});

describe('/autokick configure enabled', () => {
  it('refuses to switch on without an audit channel', async () => {
    // Removals are permanent from the member's side; there must be a record.
    loadConfig.mockReturnValue(config({ alertChannelId: null }));
    const fake = interaction({
      subcommand: 'enabled',
      subcommandGroup: 'configure',
      options: { value: true }
    });

    await command.execute(fake);

    expect(enable).not.toHaveBeenCalled();
    expect(said(fake)).toContain('audit channel');
  });

  it('switches on and stamps the cutoff', async () => {
    const fake = interaction({
      subcommand: 'enabled',
      subcommandGroup: 'configure',
      options: { value: true }
    });

    await command.execute(fake);

    expect(enable).toHaveBeenCalled();
    expect(said(fake)).toContain('Nobody already in the server can be removed');
  });

  it('switches off with no preconditions', async () => {
    const fake = interaction({
      subcommand: 'enabled',
      subcommandGroup: 'configure',
      options: { value: false }
    });

    await command.execute(fake);

    expect(disable).toHaveBeenCalled();
    expect(said(fake)).toContain('Nobody will be removed');
  });
});

describe('/autokick configure grace and reminder', () => {
  it('sets the grace period', async () => {
    saveConfig.mockReturnValue(config({ graceDays: 14, warnAfterDays: 5 }));
    const fake = interaction({
      subcommand: 'grace',
      subcommandGroup: 'configure',
      options: { days: 14 }
    });

    await command.execute(fake);

    expect(saveConfig).toHaveBeenCalledWith({ graceDays: 14 });
    expect(said(fake)).toContain('**14 days**');
  });

  it('reports the reminder being pulled back under a shortened deadline', async () => {
    saveConfig.mockReturnValue(config({ graceDays: 3, warnAfterDays: 2 }));
    const fake = interaction({
      subcommand: 'reminder',
      subcommandGroup: 'configure',
      options: { days: 9 }
    });

    await command.execute(fake);

    expect(said(fake)).toContain('day **2**');
  });

  it('confirms a reminder that fits', async () => {
    saveConfig.mockReturnValue(config({ graceDays: 7, warnAfterDays: 4 }));
    const fake = interaction({
      subcommand: 'reminder',
      subcommandGroup: 'configure',
      options: { days: 4 }
    });

    await command.execute(fake);

    expect(said(fake)).toContain('**4 days**');
  });

  it('sets the audit channel', async () => {
    const fake = interaction({
      subcommand: 'alert-channel',
      subcommandGroup: 'configure',
      options: { channel: { id: 'c1' } }
    });

    await command.execute(fake);

    expect(saveConfig).toHaveBeenCalledWith({ alertChannelId: 'c1' });
  });

  it('sets the role picker the DMs point at', async () => {
    const fake = interaction({
      subcommand: 'role-channel',
      subcommandGroup: 'configure',
      options: { channel: { id: 'c2' } }
    });

    await command.execute(fake);

    expect(saveConfig).toHaveBeenCalledWith({ roleChannelId: 'c2' });
  });
});

describe('/autokick preview', () => {
  it('defers, since fetching the member list is slow', async () => {
    const fake = interaction({ subcommand: 'preview' });
    await command.execute(fake);

    expect(fake.deferReply).toHaveBeenCalled();
  });

  it('changes nothing', async () => {
    const fake = interaction({ subcommand: 'preview' });
    await command.execute(fake);

    expect(sweepGuild).not.toHaveBeenCalled();
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it('shows who is at risk', async () => {
    inspectGuild.mockResolvedValue({
      kick: [{ tag: 'bob#0001', daysInServer: 9 }],
      warn: [],
      waiting: [],
      exempt: [],
      memberCount: 1
    });

    const fake = interaction({ subcommand: 'preview' });
    await command.execute(fake);

    expect(payloadOf(fake).embeds[0].toJSON().fields[0].value).toBe('1');
  });

  it('names the missing intent when the member list cannot be read', async () => {
    inspectGuild.mockResolvedValue(null);
    const fake = interaction({ subcommand: 'preview' });

    await command.execute(fake);

    expect(said(fake)).toContain('Server Members intent');
  });
});

describe('/autokick run', () => {
  it('does nothing without an explicit confirmation', async () => {
    const fake = interaction({ subcommand: 'run', options: { confirm: false } });
    await command.execute(fake);

    expect(sweepGuild).not.toHaveBeenCalled();
    expect(said(fake)).toContain('/autokick preview');
  });

  it('refuses to run while the sweep is switched off', async () => {
    // Running while off would act without a cutoff, and the cutoff is what
    // protects existing members.
    const fake = interaction({ subcommand: 'run', options: { confirm: true } });
    await command.execute(fake);

    expect(sweepGuild).not.toHaveBeenCalled();
    expect(said(fake)).toContain('sweep is off');
  });

  it('sweeps for real once confirmed and enabled', async () => {
    loadConfig.mockReturnValue(config({ enabled: true }));
    sweepGuild.mockResolvedValue({
      kicked: [{ tag: 'bob#0001', daysInServer: 9 }],
      warned: [],
      blocked: [],
      capped: false,
      dryRun: false
    });

    const fake = interaction({ subcommand: 'run', options: { confirm: true } });
    await command.execute(fake);

    expect(sweepGuild).toHaveBeenCalled();
    expect(said(fake)).toContain('1 removed');
  });

  it('reports a failed member fetch instead of claiming success', async () => {
    loadConfig.mockReturnValue(config({ enabled: true }));
    sweepGuild.mockResolvedValue(null);

    const fake = interaction({ subcommand: 'run', options: { confirm: true } });
    await command.execute(fake);

    expect(said(fake)).toContain('nothing was done');
  });
});

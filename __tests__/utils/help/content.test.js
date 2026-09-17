const { SlashCommandBuilder } = require('discord.js');
const {
  MAX_EMBED_LENGTH,
  MAX_FIELDS,
  MAX_FIELD_LENGTH,
  buildCommandEmbed,
  buildHeaderEmbed,
  buildHelpMessages,
  buildSectionMessages,
  buildToc,
  commandField,
  embedLength,
  groupByCategory,
  messageLink,
  subcommandsOf
} = require('../../../utils/help/content');

/** A command module, as the loader produces them. */
function command({
  name = 'thing',
  help = 'Does a thing.',
  category = 'WoW',
  subcommands = [],
  groups = []
} = {}) {
  const data = new SlashCommandBuilder().setName(name).setDescription(help.slice(0, 100));

  subcommands.forEach(sub =>
    data.addSubcommand(builder => builder.setName(sub).setDescription(`Does ${sub}.`))
  );

  groups.forEach(group =>
    data.addSubcommandGroup(builder =>
      builder
        .setName(group.name)
        .setDescription(`The ${group.name} group.`)
        .addSubcommand(child => child.setName(group.child).setDescription(`Does ${group.child}.`))
    )
  );

  return { data, help, category };
}

function commandMap(entries) {
  return new Map(entries.map(([name, options]) => [name, command({ name, ...options })]));
}

describe('subcommandsOf', () => {
  it('finds plain subcommands', () => {
    expect(subcommandsOf(command({ subcommands: ['show', 'hide'] })).map(s => s.name)).toEqual([
      'show',
      'hide'
    ]);
  });

  it('flattens a subcommand group into "group child"', () => {
    const entries = subcommandsOf(command({ groups: [{ name: 'roles', child: 'add' }] }));
    expect(entries.map(s => s.name)).toEqual(['roles add']);
  });

  it('is empty for a command with no subcommands', () => {
    expect(subcommandsOf(command())).toEqual([]);
  });

  it('tolerates a command with no data', () => {
    expect(subcommandsOf({})).toEqual([]);
  });
});

describe('commandField', () => {
  it('leads with the description', () => {
    const field = commandField('token', command({ help: 'Shows the token price.' }));

    expect(field.name).toBe('/token');
    expect(field.value).toContain('Shows the token price.');
  });

  it('lists subcommands, since a bare description does not say where to start', () => {
    const field = commandField('ticket', command({ subcommands: ['status'] }));
    expect(field.value).toContain('`status`');
  });

  it('never exceeds a field value limit', () => {
    const many = Array.from({ length: 60 }, (_, i) => `subcommand${i}`);
    const field = commandField('big', command({ subcommands: many.slice(0, 25) }));

    expect(field.value.length).toBeLessThanOrEqual(MAX_FIELD_LENGTH);
  });
});

describe('groupByCategory', () => {
  it('puts WoW before Admin regardless of insertion order', () => {
    const commands = commandMap([
      ['spam', { category: 'Admin' }],
      ['token', { category: 'WoW' }]
    ]);

    expect(groupByCategory(commands).map(([category]) => category)).toEqual(['WoW', 'Admin']);
  });

  it('sorts commands inside a category', () => {
    const commands = commandMap([
      ['token', { category: 'WoW' }],
      ['arena', { category: 'WoW' }]
    ]);

    expect(groupByCategory(commands)[0][1].map(([name]) => name)).toEqual(['arena', 'token']);
  });

  it('files an uncategorised command under Other, at the end', () => {
    const commands = new Map([
      ['mystery', { data: new SlashCommandBuilder().setName('m').setDescription('d'), help: 'x' }],
      ['token', command({ category: 'WoW' })]
    ]);

    expect(groupByCategory(commands).map(([category]) => category)).toEqual(['WoW', 'Other']);
  });
});

describe('buildHeaderEmbed', () => {
  it('names the server when it can', () => {
    const embed = buildHeaderEmbed(commandMap([['token', {}]]), { guildName: 'My Guild' }).toJSON();
    expect(embed.title).toBe('My Guild — Bot Commands');
  });

  it('omits jump links until the sections have been posted', () => {
    const embed = buildHeaderEmbed(commandMap([['token', {}]])).toJSON();
    expect(embed.fields.some(f => f.name.includes('Jump to'))).toBe(false);
  });

  it('renders jump links once it has them', () => {
    const toc = [{ label: 'WoW', emoji: '⚔️', count: 3, url: 'https://example.test/1' }];
    const embed = buildHeaderEmbed(commandMap([['token', {}]]), { toc }).toJSON();

    const jump = embed.fields.find(f => f.name.includes('Jump to'));
    expect(jump.value).toContain('https://example.test/1');
    expect(jump.value).toContain('3 commands');
  });

  it('says "1 command" rather than "1 commands"', () => {
    const toc = [{ label: 'Help', emoji: 'ℹ️', count: 1, url: 'https://example.test/1' }];
    const embed = buildHeaderEmbed(commandMap([['help', {}]]), { toc }).toJSON();

    const jump = embed.fields.find(f => f.name.includes('Jump to')).value;

    expect(jump).toMatch(/1 command$/);
    expect(jump).not.toContain('1 commands');
  });

  it('counts the commands in the footer', () => {
    const embed = buildHeaderEmbed(commandMap([['a', {}], ['b', {}]])).toJSON();
    expect(embed.footer.text).toBe('2 commands available');
  });
});

describe('buildSectionMessages', () => {
  it('produces one message per category', () => {
    const commands = commandMap([
      ['token', { category: 'WoW' }],
      ['spam', { category: 'Admin' }]
    ]);

    expect(buildSectionMessages(commands).map(s => s.label)).toEqual(['WoW', 'Admin']);
  });

  it('carries the command count for the table of contents', () => {
    const commands = commandMap([
      ['token', { category: 'WoW' }],
      ['arena', { category: 'WoW' }]
    ]);

    expect(buildSectionMessages(commands)[0].count).toBe(2);
  });

  it('splits a category that will not fit in one embed', () => {
    // 30 commands is past the 25-field cap, so the section has to continue in
    // a second embed rather than silently losing five of them.
    const commands = commandMap(
      Array.from({ length: 30 }, (_, i) => [`cmd${String(i).padStart(2, '0')}`, { category: 'WoW' }])
    );

    const [section] = buildSectionMessages(commands);

    expect(section.embeds.length).toBeGreaterThan(1);
    expect(section.embeds[1].toJSON().title).toContain('continued');
  });

  it('keeps every command when it splits', () => {
    const commands = commandMap(
      Array.from({ length: 30 }, (_, i) => [`cmd${String(i).padStart(2, '0')}`, { category: 'WoW' }])
    );

    const [section] = buildSectionMessages(commands);
    const total = section.embeds.reduce((sum, e) => sum + (e.toJSON().fields ?? []).length, 0);

    expect(total).toBe(30);
  });

  it('never exceeds Discord\'s limits on any embed', () => {
    const commands = commandMap(
      Array.from({ length: 40 }, (_, i) => [
        `cmd${i}`,
        { category: 'WoW', subcommands: ['one', 'two', 'three'] }
      ])
    );

    for (const section of buildSectionMessages(commands)) {
      for (const embed of section.embeds) {
        expect(embedLength(embed)).toBeLessThanOrEqual(MAX_EMBED_LENGTH);
        expect((embed.toJSON().fields ?? []).length).toBeLessThanOrEqual(MAX_FIELDS);
      }
    }
  });
});

describe('buildHelpMessages', () => {
  it('leads with an overview, then one message per category', () => {
    const commands = commandMap([
      ['token', { category: 'WoW' }],
      ['spam', { category: 'Admin' }]
    ]);

    expect(buildHelpMessages(commands).map(m => m.label)).toEqual(['Overview', 'WoW', 'Admin']);
  });

  it('gives every message at least one embed', () => {
    const messages = buildHelpMessages(commandMap([['token', { category: 'WoW' }]]));
    messages.forEach(message => expect(message.embeds.length).toBeGreaterThan(0));
  });
});

describe('buildToc', () => {
  it('links each section to its published message', () => {
    const sections = [{ label: 'WoW', emoji: '⚔️', count: 2, messageId: 'm1' }];
    const toc = buildToc(sections, { guildId: 'g', channelId: 'c' });

    expect(toc[0].url).toBe(messageLink({ guildId: 'g', channelId: 'c', messageId: 'm1' }));
  });
});

describe('buildCommandEmbed', () => {
  it('titles with the command and describes it', () => {
    const embed = buildCommandEmbed('token', command({ help: 'Shows the price.' })).toJSON();

    expect(embed.title).toBe('/token');
    expect(embed.description).toBe('Shows the price.');
  });

  it('spells out subcommands as they would be typed', () => {
    const embed = buildCommandEmbed('ticket', command({ subcommands: ['status'] })).toJSON();
    expect(embed.fields[0].value).toContain('/ticket status');
  });

  it('omits the subcommand field when there are none', () => {
    expect(buildCommandEmbed('token', command()).toJSON().fields).toBeUndefined();
  });
});

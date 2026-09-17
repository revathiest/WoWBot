const { EmbedBuilder } = require('discord.js');
const {
  MAX_EMBED_LENGTH,
  MAX_FIELDS_PER_EMBED,
  MAX_FIELD_LENGTH,
  chunkLines,
  embedLength,
  packFields,
  packIntoMessages,
  toFields
} = require('../../utils/embeds');

describe('embedLength', () => {
  it('counts everything Discord counts', () => {
    const embed = new EmbedBuilder()
      .setTitle('ab')
      .setDescription('cde')
      .addFields({ name: 'fg', value: 'hi' })
      .setFooter({ text: 'j' });

    expect(embedLength(embed)).toBe(2 + 3 + 2 + 2 + 1);
  });

  it('tolerates an empty or missing embed', () => {
    expect(embedLength(null)).toBe(0);
    expect(embedLength({})).toBe(0);
  });
});

describe('chunkLines', () => {
  it('keeps a short list in one chunk', () => {
    expect(chunkLines(['a', 'b'])).toEqual([['a', 'b']]);
  });

  it('splits on the character limit', () => {
    const chunks = chunkLines(Array.from({ length: 20 }, () => 'x'.repeat(200)));

    chunks.forEach(chunk =>
      expect(chunk.join('\n').length).toBeLessThanOrEqual(MAX_FIELD_LENGTH)
    );
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('splits on a line count when asked, for columns', () => {
    expect(chunkLines(['a', 'b', 'c', 'd'], { maxLines: 2 })).toEqual([
      ['a', 'b'],
      ['c', 'd']
    ]);
  });

  it('truncates a single line too long to fit, rather than looping', () => {
    const [[line]] = chunkLines(['x'.repeat(5000)]);
    expect(line.length).toBeLessThanOrEqual(MAX_FIELD_LENGTH);
  });
});

describe('toFields', () => {
  it('heads only the first chunk, so continuations read as one list', () => {
    const fields = toFields('Names', ['a', 'b', 'c', 'd'], { maxLines: 2 });

    expect(fields[0].name).toBe('Names');
    expect(fields[1].name).toBe('\u200b');
  });

  it('marks columns inline', () => {
    expect(toFields('Names', ['a'], { inline: true })[0].inline).toBe(true);
  });
});

describe('packFields', () => {
  const decorate = fields => new EmbedBuilder().addFields(fields);

  it('keeps a small set in one embed', () => {
    expect(packFields([{ name: 'a', value: 'b' }], decorate)).toHaveLength(1);
  });

  it('starts a new embed past the field cap', () => {
    const fields = Array.from({ length: MAX_FIELDS_PER_EMBED + 5 }, () => ({
      name: 'n',
      value: 'v'
    }));

    const embeds = packFields(fields, decorate);

    expect(embeds).toHaveLength(2);
    expect(embeds[0].toJSON().fields).toHaveLength(MAX_FIELDS_PER_EMBED);
  });

  it('starts a new embed past the character cap', () => {
    const fields = Array.from({ length: 10 }, () => ({ name: 'n', value: 'x'.repeat(1000) }));

    packFields(fields, decorate).forEach(embed =>
      expect(embedLength(embed)).toBeLessThanOrEqual(MAX_EMBED_LENGTH)
    );
  });

  it('leaves room for a title and description added afterwards', () => {
    // Without the reservation an embed measured at 5,900 here comes back over
    // the limit once decorate adds its title, and Discord rejects the message.
    const fields = Array.from({ length: 10 }, () => ({ name: 'n', value: 'x'.repeat(600) }));
    const description = 'y'.repeat(500);

    const embeds = packFields(
      fields,
      chunk => new EmbedBuilder().setTitle('A title').setDescription(description).addFields(chunk),
      { reserve: 'A title'.length + description.length }
    );

    embeds.forEach(embed => expect(embedLength(embed)).toBeLessThanOrEqual(MAX_EMBED_LENGTH));
  });

  it('numbers the embeds so continuations can be labelled', () => {
    const fields = Array.from({ length: 30 }, () => ({ name: 'n', value: 'v' }));
    const titles = packFields(fields, (chunk, index) =>
      new EmbedBuilder().setTitle(`Part ${index}`).addFields(chunk)
    ).map(embed => embed.toJSON().title);

    expect(titles).toEqual(['Part 0', 'Part 1']);
  });
});

describe('packIntoMessages', () => {
  it('keeps a couple of small embeds in one message', () => {
    const embeds = [new EmbedBuilder().setTitle('a'), new EmbedBuilder().setTitle('b')];
    expect(packIntoMessages(embeds)).toHaveLength(1);
  });

  it('splits past ten embeds', () => {
    const embeds = Array.from({ length: 12 }, () => new EmbedBuilder().setTitle('x'));
    expect(packIntoMessages(embeds)).toHaveLength(2);
  });

  it('splits past the per-message character budget', () => {
    const embeds = Array.from({ length: 4 }, () =>
      new EmbedBuilder().setDescription('x'.repeat(2000))
    );

    const messages = packIntoMessages(embeds);

    messages.forEach(message =>
      expect(message.reduce((sum, embed) => sum + embedLength(embed), 0)).toBeLessThanOrEqual(6000)
    );
    expect(messages.length).toBeGreaterThan(1);
  });

  it('is empty for no embeds', () => {
    expect(packIntoMessages([])).toEqual([]);
  });
});

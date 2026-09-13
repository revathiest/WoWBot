# WoW Bot

A Discord bot that pulls World of Warcraft data from the **Blizzard Battle.net API** and returns it as slash commands. Character profiles, Mythic+ ratings, realm status, item lookups, and the WoW Token price.

Built with [discord.js](https://discord.js.org/) v14 on Node.js, with no database and no privileged gateway intents.

---

## Commands

| Command | What it does |
| --- | --- |
| `/character <character> <realm> [region]` | Level, race, class and spec, faction, guild, item level, achievement points, and last login, with the character's avatar and render. |
| `/mythicplus <character> <realm> [region]` | Current-season Mythic+ rating and the best keystone runs, showing key level, dungeon, time, and whether it was timed. |
| `/realm <realm> [region]` | Realm type, category, timezone, up/down status, population, queue state, and connected realms. Suggests near matches on a miss. |
| `/item <query> [region]` | Item lookup by **exact name** or item ID: quality, item level, type, slot, required level, sell price, and icon. |
| `/realms [search] [game] [region]` | Lists every playable realm, or searches them. Shows exact slugs when searching. |
| `/token [region]` | Current WoW Token price in gold. |

Every command takes an optional `region` (`US`, `EU`, `KR`, `TW`). All except `/mythicplus` also take an optional `game`. When omitted, `BLIZZARD_REGION` and `BLIZZARD_GAME` are used.

### Game versions

| `game` | Namespace | What it covers |
| --- | --- | --- |
| `retail` | `dynamic-us` | Modern WoW. |
| `classic` | `dynamic-classic-us` | Progression Classic — **the Burning Crusade Anniversary realms** (Maladath, Skyfury, Angerforge, Faerlina, Whitemane…) alongside the other progression realms. |
| `classic-era` | `dynamic-classic1x-us` | Permanent vanilla, including Hardcore (Whitemane, Doomhowl, Living Flame…). |

Blizzard exposes only these three. There is no per-expansion namespace — `classictbc`, `classicwlk`, `classic2x` and similar all return 403, so TBC Anniversary realms are reached through `classic`, not a namespace of their own.

`/mythicplus` is Retail-only and takes no `game` option, since Mythic+ does not exist in Classic.

> **Classic caveat:** Game Data (realms, status, population, items, token) is fully available for Classic. Blizzard's **character profile** data for Classic is thin to non-existent, so `/character` may return "not found" for a character that plainly exists.

> **Note on `/item`:** Blizzard's item search matches full names only — there is no substring or fuzzy search in the API. `Thunderfury` will not find `Thunderfury, Blessed Blade of the Windseeker`; pass the exact name or the item ID.

---

## Setup

### 1. Create the Discord application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and create an application.
2. Under **Bot**, click *Reset Token* and copy the token → `DISCORD_TOKEN`.
3. Under **General Information**, copy the *Application ID* → `APPLICATION_ID`.
4. Under **OAuth2 → URL Generator**, tick the `bot` and `applications.commands` scopes, then invite the bot with the generated URL.

No privileged intents are needed — the bot only uses the `Guilds` intent and responds to slash commands.

### 2. Create the Blizzard API client

1. Go to the [Battle.net Developer Portal](https://develop.battle.net/access/clients) and create a client.
2. Copy the *Client ID* → `BLIZZARD_CLIENT_ID` and *Client Secret* → `BLIZZARD_CLIENT_SECRET`.

The bot authenticates with the OAuth **client credentials** flow, which only reaches public game and profile data. No player ever needs to log in.

### 3. Configure the environment

```bash
cp .env.example .env
```

| Variable | Required | Description |
| --- | --- | --- |
| `DISCORD_TOKEN` | yes | Bot token. |
| `APPLICATION_ID` | yes | Discord application (client) ID. |
| `GUILD_ID` | no | When set, slash commands register to this guild only and appear instantly, and any global commands are removed so nothing appears twice. Leave blank to register globally, which can take up to an hour to propagate. |
| `BLIZZARD_CLIENT_ID` | yes | Battle.net API client ID. |
| `BLIZZARD_CLIENT_SECRET` | yes | Battle.net API client secret. |
| `BLIZZARD_REGION` | no | Default region: `us`, `eu`, `kr`, or `tw`. Defaults to `us`. |
| `BLIZZARD_LOCALE` | no | Response locale, e.g. `en_US`, `de_DE`, `ko_KR`. Defaults to `en_US`. |
| `BLIZZARD_GAME` | no | Default game version: `retail`, `classic`, or `classic-era`. Defaults to `retail`. |

The bot refuses to start and names what is missing if a required value is absent.

### 4. Install and run

```bash
npm install
npm start
```

For local development, `npm run dev` restarts on file changes.

---

## Deploying to PebbleHost

1. Upload the project **without** `node_modules/` and `.env`.
2. Set the startup file to `index.js`.
3. Add the environment variables from the table above in the panel's *Startup* / *Variables* section rather than uploading a `.env` file.
4. Start the server. Slash commands register automatically once the bot connects.

---

## Project structure

```
index.js                     Entry point: validates config, wires events, logs in
config/index.js              Environment parsing and validation
commands/wow/                One file per slash command
handlers/interactionHandler  Routes interactions and turns errors into replies
utils/blizzard/client.js     OAuth tokens, namespaces, timeouts, retries
utils/blizzard/profile.js    Character endpoints (profile-{region} namespace)
utils/blizzard/gameData.js   Realm, token, and item endpoints
utils/blizzard/realms.js     Cached realm index, resolution, and search
utils/commandRegistration.js Recursive command loader + Discord registration
utils/wow.js                 Slugs, colours, and formatting helpers
__tests__/                   Jest suites mirroring the source layout
```

### Adding a command

Drop a file anywhere under `commands/` exporting `data` (a `SlashCommandBuilder`) and `execute(interaction)`. The loader picks it up recursively on the next start — there is no list to update. A file that fails to load is logged and skipped rather than stopping the bot.

```js
const { SlashCommandBuilder } = require('discord.js');
const { addRegionOption, resolveRegion } = require('../../utils/commandOptions');

const data = new SlashCommandBuilder().setName('example').setDescription('An example.');
addRegionOption(data);

module.exports = {
  data,
  async execute(interaction) {
    await interaction.deferReply();
    await interaction.editReply(`Region: ${resolveRegion(interaction)}`);
  }
};
```

Throw from `execute` and the interaction handler will translate it into a sensible user-facing message — Blizzard 404s, rate limits, credential failures, and outages each get their own wording.

---

## API behaviour worth knowing

- **Command scope.** Guild-scoped and global commands stack in Discord's UI, so a command registered both ways is listed twice. When `GUILD_ID` is set, the bot registers to that guild and then clears the global set. The wipe runs only after the guild registration succeeds, so a failure there cannot leave the application with no commands.

  > ⚠️ Because of this, do not point a development instance at the same `APPLICATION_ID` as a production instance that registers globally — starting the dev bot will remove production's commands. Use a separate Discord application for development.

- **Token caching.** One OAuth token is fetched on first use and reused until it expires (about 24 hours), refreshed a minute early. Concurrent requests share a single token fetch.
- **Retries.** Rate limits (429), server errors (5xx), and network failures are retried up to three times with backoff, honouring `Retry-After`. 404s and other 4xx responses fail immediately.
- **Rate limits.** Blizzard allows 36,000 requests per hour and 100 per second per client, which these commands will not approach in normal use.
- **Regions.** `us`, `eu`, `kr`, and `tw` are supported. China sits behind a separate gateway (`gateway.battlenet.com.cn`) and is not wired up.
- **Realm slugs are resolved from the live realm index**, not guessed, because Blizzard's slug rule is unintuitive: hyphens and apostrophes are *deleted* rather than turned into separators (`Azjol-Nerub` → `azjolnerub`), while accents are *preserved* (`Festung der Stürme` → `festung-der-stürme`). The index is cached for six hours per region+game, and matching is forgiving — `Azjol-Nerub`, `azjol nerub`, and `AZJOLNERUB` all resolve. If the index cannot be read, the bot falls back to a derived slug, which is validated against all 801 live realms.
- **Internal realms are hidden.** Blizzard's index includes non-playable entries (`US1A2-INST`, `US2 CWOW CSI 80`, `zzz_RDB EU`); `/realms` filters them out. US retail drops from 345 entries to 248 playable realms.

---

## Testing

```bash
npm test
```

Runs Jest with coverage, enforcing an 80% global threshold. The Blizzard API is never called from tests — `global.fetch` and the endpoint modules are mocked.

---

## License

MIT — see [LICENSE](LICENSE).

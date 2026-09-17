# WoW Bot

A Discord bot that pulls World of Warcraft data from the **Blizzard Battle.net API** and returns it as slash commands. Character profiles, Mythic+ ratings, realm status, item lookups, and the WoW Token price.

It also posts a **daily guild report** — roster changes, arena movement, and PvP activity, compared
against the previous one — runs a **support ticket system**, keeps a **self-updating help post**, records
what it does to an **audit log**, and includes spam detection with automatic banning, modelled on
trust tiers rather than a single threshold.

Built with [discord.js](https://discord.js.org/) v14 on Node.js, with no database. A handful of small
JSON files under `data/` hold settings and last week's snapshots; everything else is fetched live.

---

## Commands

| Command | What it does |
| --- | --- |
| `/character <character> [realm] [game] [region]` | Level, race, class and spec, faction, guild, item level, achievement points, last login, and **every equipped item** linked to the right Wowhead database, plus the character's avatar and render. |
| `/mythicplus <character> <realm> [region]` | Current-season Mythic+ rating and the best keystone runs, showing key level, dungeon, time, and whether it was timed. |
| `/realm [realm] [game] [region]` | Realm type, category, timezone, up/down status, population, queue state, and connected realms. Suggests near matches on a miss. |
| `/item <query> [region]` | Item lookup by **exact name** or item ID: quality, item level, type, slot, required level, sell price, and icon. |
| `/realms [search] [game] [region]` | Lists every playable realm, or searches them. Shows exact slugs when searching. |
| `/token [region]` | Current WoW Token price in gold. |
| `/arena ladder \| rank` | Arena ladder standings for a bracket, or where one character ranks across 2v2, 3v3 and 5v5. |
| `/guild <guild> [realm] [game] [region]` | Guild roster: size, faction, guild master, class and level spread, and max-level members. |
| `/audit <character> [realm] [game] [region]` | Raid-readiness check — finds missing enchants on the slots TBC actually enchants. |
| `/report status \| now \| post \| track \| untrack \| configure …` | The guild report: track guilds, set the channel and schedule, and preview or post on demand. Requires Manage Server. |
| `/iam add \| remove \| list \| forget` | Link your characters so reports mention you instead of just naming the character. Optional, and open to everyone. |
| `/iam manage assign \| unassign` | Link a character to another member on their behalf. Requires Manage Server. |
| `/help show \| setup \| unlock \| status` | Lists every command. `setup` posts them to a read-only channel. |
| `/auditlog status \| channel \| enabled \| verbosity` | Records what the bot does to a hidden, admin-only channel. Requires Manage Server. |
| `/autokick status \| preview \| run \| configure …` | Removes members who never pick a role, after a reminder DM. Requires Manage Server. |
| `/ticket set-channel \| set-archive \| roles \| status \| history` | Sets up the support ticket system and looks up past tickets. Requires Manage Server. |
| `/spam status \| test \| configure …` | Inspect, dry-run, and tune spam detection. Requires Manage Server. |

Every command takes an optional `region` (`US`, `EU`, `KR`, `TW`). All except `/mythicplus` also take an optional `game`. When omitted, `BLIZZARD_REGION` and `BLIZZARD_GAME` are used.

### Game versions

| `game` | Namespace | What it covers |
| --- | --- | --- |
| `anniversary` | `dynamic-classicann-us` | **TBC Anniversary** — Dreamscythe, Nightslayer, Maladath (US); Thunderstrike, Spineshatter (EU). |
| `retail` | `dynamic-us` | Modern WoW. |
| `classic` | `dynamic-classic-us` | Classic progression, currently the Mists of Pandaria track. |
| `classic-era` | `dynamic-classic1x-us` | Permanent vanilla, including Hardcore (Whitemane, Doomhowl, Living Flame…). |

> ⚠️ **`classicann` is not in Blizzard's API documentation** and cannot be found by probing: an invalid namespace and an unauthorised one both return an identical generic `403 Forbidden`, so guessing names proves nothing. It is documented only on [Blizzard's API forum](https://us.forums.blizzard.com/en/blizzard/t/tbc-anniversary-namespaces-and-data-refreshes/57155). Never conclude a namespace is absent because it 403s.

The `anniversary` static data is genuine TBC: 9 classes (no Death Knight), 10 races including Blood Elf and Draenei, and items cut off at TBC — the Warglaive of Azzinoth resolves while Shadowmourne (WotLK) 404s. There is no WoW Token, so `/token` says so rather than erroring.

`/mythicplus` is Retail-only and takes no `game` option, since Mythic+ does not exist in Classic.

**Character profiles work on TBC Anniversary** — verified against live characters on Nightslayer (level 70, class, race, guild, item level, avatar). The catch is that the realm must be looked up in the right game version: a realm found in another version produces a message naming the `game` option to use, rather than a bare "not found".

Set `BLIZZARD_GAME` to the version your guild plays so nobody has to pass the option.

> **Note on `/item`:** Blizzard's item search matches full names only — there is no substring or fuzzy search in the API. `Thunderfury` will not find `Thunderfury, Blessed Blade of the Windseeker`; pass the exact name or the item ID.

---

## Guild reports

Once a day (or once a week) the bot posts a report per tracked guild: who joined and left, who levelled up (and who
finally hit the cap), rank promotions, arena movement across 2v2/3v3/5v5, and who racked up the most
honorable kills. Two guilds in one Discord server is a normal setup — track both, and they either
share a channel or get one each.

### Setting it up

```
/report track guild:Apex realm:Nightslayer
/report track guild:Second Guild realm:Nightslayer channel:#second-guild-news
/report configure channel channel:#guild-news
/report configure schedule hour:18
/report configure enabled value:true
```

### Daily, and the channel is cleared each time

Reports post **daily** by default, and the bot deletes its own previous reports before posting
the new one, so the channel only ever shows the current one. Messages from anyone else are left
alone — pointing the report at a busy channel by mistake costs nobody their conversation.

```
/report configure schedule hour:18 frequency:weekly day:Monday
/report configure clear-channel value:false
```

### Who is on Discord

Each report carries two counts — **on Discord** and **not on Discord** — and a button that DMs
you the full breakdown, so the report itself stays short. The breakdown splits three ways:

| Group | Meaning |
| --- | --- |
| 🟢 On Discord | The character is linked, and that account is still in the server. |
| 🚪 Left the server | The character is linked, but the account is gone. |
| ⚪ Not linked | Nobody has claimed the character. |

The last group is the honest limit of what the bot knows: it can only connect a character to an
account when somebody claims it with `/iam add` or an admin assigns it with
`/iam manage assign`, so anyone in that list may well be in the server without having done so.

`/report status` shows what is tracked, where each guild posts, and when the next report is due.

- **Times are UTC.** There is no timezone option — `hour:18` means 18:00 UTC everywhere.
- **The schedule is a slot, not a timer.** If the bot is offline at the scheduled hour it posts when
  it comes back, and restarting a dozen times in an hour still produces exactly one report.
- **Turning reports on does not fire one immediately**; it arms the next slot.

### Seeing one early

`/report now` builds the report and shows it to you **without posting it and without resetting the
week** — safe to run whenever. `/report post` publishes for real and starts a new week from that
moment.

### The first report is a baseline

Blizzard's API only ever reports *current* state: a season's total wins, a lifetime honorable-kill
count, today's roster. None of it is per-period. So the bot stores a snapshot each run and subtracts it
from the next one — which means a newly tracked guild's first report is a starting position, and real
real change appears from the second onward. `/report status` says which guilds are still waiting
for a baseline.

### Getting mentioned by name

By default a report names characters, because it is built from the guild roster and the bot has no
idea who plays what. Anyone can change that for themselves:

```
/iam add character:Butud
/iam list
/iam remove character:Butud
/iam forget
```

Linking is optional and open to everyone — reports work fine with nobody linked. A claimed character
is verified against the API before it is stored, and a character already claimed by someone else is
refused. `/iam forget` deletes everything the bot holds about you in one step; the file stores nothing
but a Discord user id and the character names that person typed in.

Admins can do it on someone's behalf, which is useful for people who will never run the command
themselves:

```
/iam manage assign user:@Ken character:Butud
/iam manage unassign user:@Ken character:Butud
```

Unlike a member's own claim, an admin assignment **moves** a character that somebody else had already
claimed — that is usually the dispute being settled — and says out loud who lost it.

### What it costs

A report is one roster call, three cached ladder calls, and one honorable-kill lookup per member —
about 250 calls for a 240-member guild, finishing in under ten seconds. Well inside Blizzard's limit
of 36,000 requests an hour.

---

## Auto-kicking members who never pick a role

New members who have not selected any role within a week are reminded by DM, then removed. Both
timings are configurable, and nothing happens until you switch it on.

```
/autokick configure alert-channel channel:#mod-log
/autokick configure role-channel channel:#pick-your-roles
/autokick preview
/autokick configure enabled value:true
```

### It cannot kick anyone who is already here

The moment you switch it on, the bot stamps a cutoff. **Anyone who was already in the server at that
instant is permanently exempt**, however long they have gone without a role. Only members who join
afterwards are ever removed. `/autokick status` shows the cutoff, and `/autokick preview` tells you how
many existing members it is protecting — which is usually why a first preview looks emptier than
expected.

Switching the feature off and on again re-stamps the cutoff, granting an amnesty to anyone who joined
in between. That direction is deliberate: re-enabling can surprise you by doing nothing, never by
removing somebody you did not expect.

### What actually happens

| Day | What the member gets |
| --- | --- |
| 0 | Joins. Nothing happens. |
| 5 (configurable) | A DM: pick your roles, here is where, you have N days left. |
| 7 (configurable) | A DM explaining the removal, then the kick. |

The reminder DM is always sent **before** the kick, because Discord will not deliver a message to
someone you no longer share a server with. Many people have DMs closed — the removal goes ahead
either way, and the audit channel records that the DM did not land.

A kick is not a ban. Removed members can rejoin at any time with an invite.

### Safety rails

- **Ships disabled**, and cannot be enabled without an audit channel — with no database, that channel
  is the only record of who was removed and why.
- **`/autokick preview` changes nothing** and shows exactly who is at risk and how long each person
  has left. Run it before enabling, and any time after.
- **A manual `/autokick run` requires `confirm:true`.**
- **At most 10 members are removed per sweep.** If more are due, the rest wait for the next pass and
  the audit channel says so. A misconfiguration costs a handful of people and raises a flag rather
  than clearing the server.
- **Bots, anyone holding any role, and the server owner are never touched.** Neither is anyone the
  bot cannot act on due to role hierarchy — those are reported in the audit channel instead of
  failing silently.
- **Missing data never causes a kick.** If the member list cannot be read, the sweep does nothing at
  all rather than assuming nobody has roles.

The sweep runs every ten minutes, so a removal lands shortly after the deadline passes rather than
exactly on it.

---

## Support tickets

Members press a button in a lobby channel, describe their problem in a form, and get a private channel
with the moderators. Moderators claim it, answer, and close it — at which point the channel is locked
and moved to an archive category.

```
/ticket set-channel channel:#support archive_category:Closed Tickets
/ticket roles add role:@Moderator
/ticket status
```

That posts the panel with the **Open Ticket** button. The panel is re-posted automatically every time
the bot starts, so deleting it or purging the channel cannot leave a dead button behind.

### The flow

| Step | What happens |
| --- | --- |
| Member presses **Open Ticket** | A form asks what they need help with (10–400 characters). |
| They submit it | A private `ticket-name-12` channel is created, visible only to them, the bot, and the moderator roles. The opener and those roles are pinged once. |
| A moderator presses **Claim** | The button locks and shows who took it, so two people do not both answer. |
| A moderator presses **Close** | The opener loses access, moderators keep read access, and the channel moves to the archive category. |

Moderator roles are set with `/ticket roles add`. Until at least one is configured, anyone with Manage
Channels can claim and close; **Manage Server always works regardless**.

`/ticket history` shows recent tickets, or one member's, with who opened, claimed and closed each.

### Differences from the Squadron 42 bot

This was ported from that bot's ticket module. The behaviour is the same; four things were fixed on the
way over:

- **The lobby channel no longer has to live inside a category.** The original refuses to create a
  ticket when it does not, which breaks the system with no obvious cause.
- **A failed channel creation no longer leaves a phantom ticket.** The original records the ticket
  first, so a permissions problem leaves a ticket that exists in the database and nowhere else.
- **Adding a moderator role no longer locks out admins.** In the original, the permission fallback
  applies *only* while no roles are configured.
- **There is a limit of 3 open tickets per person.** Each one is a real channel, and the original has
  no limit.

Storage is the other difference: Squadron 42 keeps tickets in MySQL, and this bot has no database, so
they live in `data/tickets.json` alongside the other settings. Closed tickets are kept as history, up
to a cap of 1,000.

### Lobby policing

By default the lobby channel is kept clear: a message from a non-moderator is deleted and the sender is
told why by DM (or by a short-lived reply if their DMs are closed). Turn it off with
`/ticket lobby-policing value:false`.

---

## The help post

`/help setup channel:#help` posts the command list to a channel and locks that channel down.

```
/help setup channel:#help
```

What you get is several posts: an overview with **jump links**, then one post per category (WoW
lookups, Help, Admin). Long categories split across extra posts on their own, so it keeps working as
commands are added.

**It maintains itself, and there is no refresh command.** The content is generated from the commands
the bot has actually loaded — every command already carries its own description and subcommand list —
and it is checked on every startup. Add, rename, or remove a command and the post follows without
anyone touching it.

The check is cheap and does the least it can get away with:

| Situation | What happens |
| --- | --- |
| Nothing changed | **Nothing is written.** The post carries a fingerprint of its own content, so an ordinary restart does not leave an edit on a post nobody touched. |
| A command changed | The existing posts are edited in place, so links to them keep working. |
| A section was added, removed, or a post was deleted | The whole post is republished. Discord messages cannot be reordered, so patching a hole would leave the sections out of order. |

**Admin commands are left out of the posted version.** The channel is readable by the whole server,
and a list of commands that answer "you need the Manage Server permission" is noise to nearly
everyone reading it. Admins still see them in `/help show`.

`/help show` gives anyone the same list privately — including the admin commands, if they can use
them — and `/help show command:ticket` explains a single command.

### Locked channels

The help channel is set so **everyone can read it and only the bot can post**. The same lock is
applied to the ticket lobby, so the Open Ticket button can never be pushed out of view.

This includes denying slash commands in those channels — a command reply would bury the post it is
meant to sit below.

> ⚠️ **Members with the Administrator permission bypass channel permissions and can still post.** No
> bot can prevent that. The commands say so when they apply a lock rather than promising a guarantee
> that does not hold.

`/help unlock channel:#help` reverses it. Note it *removes* the restrictions rather than granting
anything, so the channel goes back to inheriting from its category and roles.

---

## Audit log

A chronological record of what the bot did, written to a channel that is **hidden from everyone except
admins**.

```
/auditlog channel channel:#bot-log
/auditlog enabled value:true
```

Setting the channel hides it: `@everyone` loses sight of it, roles with Manage Server are granted read
access explicitly, and only the bot can post. (Manage Server does not bypass a view denial the way
Administrator does, which is why those roles are granted access rather than assumed.)

Each line says when, who, what, and where:

```
9:04 PM ⌨️ @Ken ran /character in #general
9:05 PM 🎫 @Sam opened ticket #12 in #ticket-sam-12
9:06 PM 🔧 @Ken changed the audit log settings in #admin
3:00 AM 📊 the bot posted the daily guild report — 2 guilds to 1 channel
```

### Verbosity

| Level | What it records |
| --- | --- |
| `all` (default) | Every command and button, plus everything the bot does on its own. |
| `admin` | Configuration and moderation only, plus everything automatic. Skips lookups like `/character`, which are most of the traffic. |
| `off` | Nothing. |

Anything the bot does **unprompted** — a weekly report, an onboarding sweep — is recorded at every
level except `off`, since that is the part nobody else witnessed.

Entries are batched and written every few seconds rather than one message per action. Discord allows
about five messages per five seconds per channel, and a burst of activity would otherwise blow through
that and start dropping the records. Logging never interferes with the action being logged: if the log
channel is misconfigured, the bot warns in its console and carries on.

Spam enforcement and the onboarding sweep keep their own detailed alert channels for reviewing a
single decision; this is the flat feed of everything.

---

## Setup

### 1. Create the Discord application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and create an application.
2. Under **Bot**, click *Reset Token* and copy the token → `DISCORD_TOKEN`.
3. Under **General Information**, copy the *Application ID* → `APPLICATION_ID`.
4. Under **OAuth2 → URL Generator**, tick the `bot` and `applications.commands` scopes, then invite the bot with the generated URL.

**Two privileged intents are required** for spam detection. Under **Bot → Privileged Gateway Intents**,
enable **Message Content Intent** and **Server Members Intent**. Without them the bot fails to log in
with a "disallowed intents" error.

The bot also needs these permissions in the guild: Manage Messages, Moderate Members, Ban Members, and
View Channel / Send Messages / Embed Links in the alert channel.

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
| `GUILD_ID` | no | **Rarely needed.** Leave blank and the bot serves every guild it joins, registering commands per-guild on the way in. Set it only to pin one instance to a single guild, in which case it ignores every other guild entirely. |
| `BLIZZARD_CLIENT_ID` | yes | Battle.net API client ID. |
| `BLIZZARD_CLIENT_SECRET` | yes | Battle.net API client secret. |
| `BLIZZARD_REGION` | no | Default region: `us`, `eu`, `kr`, or `tw`. Defaults to `us`. |
| `BLIZZARD_LOCALE` | no | Response locale, e.g. `en_US`, `de_DE`, `ko_KR`. Defaults to `en_US`. |
| `BLIZZARD_GAME` | no | Default game version: `anniversary`, `retail`, `classic`, or `classic-era`. Defaults to `retail`. |
| `BLIZZARD_REALM` | no | Home realm. When set, `realm` becomes optional on `/character` and `/realm` and defaults to this. |

The bot refuses to start and names what is missing if a required value is absent.

### 4. Install and run

```bash
npm install
npm start
```

For local development, `npm run dev` restarts on file changes.

---

## Running production and dev at the same time

One bot token, two instances, no conflict — pin each one to its own server with
`GUILD_ID`.

| Instance | `GUILD_ID` | Serves |
| --- | --- | --- |
| Production (PebbleHost) | your main server's id | Main server only |
| Dev (local, `npm run dev`) | your test server's id | Test server only |

A pinned instance registers commands **only** to its guild and **ignores every
interaction and message from anywhere else**. Both instances still receive all
events — that is unavoidable on a shared token — but only the one that owns the
guild acts, so exactly one answers.

To get a server id: enable Developer Mode in Discord (User Settings → Advanced),
then right-click the server and choose *Copy Server ID*.

### Two rules that keep it working

1. **Set `GUILD_ID` on both.** If either is left blank, that instance serves
   *every* guild, takes over the other's server, and the two start racing for
   every command. The bot warns at startup when it is unpinned in more than one
   guild.
2. **This holds only while production serves one server.** If production ever
   needs a second server, it cannot be pinned — and then it will conflict with
   dev again. At that point, give dev its own Discord application and token,
   which removes the problem structurally rather than by configuration.

A pinned instance logs each ignored guild **once** on first sight and then stays
quiet, so a dev console is not buried by traffic from a busy production server.

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
utils/audit/                 Audit log: config, buffered writer
utils/channelLock.js         Making a channel bot-writable, publicly or admin-only
utils/help/                  Help post: generated content, store, publishing
utils/onboarding/            Auto-kick sweep: config, classification, DMs, alerts, scheduling
utils/tickets/               Support tickets: store, embeds and buttons, create/claim/close flow
utils/reports/               Weekly report: config, collection, diffing, rendering, scheduling
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

- **`/audit` checks enchants, not gems.** Blizzard exposes gems that are socketed but never the socket list — `sockets` is absent from equipped items and null on the item document — so an empty socket cannot be told apart from an item with no sockets. The audit also only flags slots TBC can actually enchant; neck, waist, trinkets, shirt and tabard are skipped, as is a relic in the ranged slot.

- **Arena ladders are cached for 10 minutes.** A single TBC bracket returns around 5,000 entries and finding one character means scanning the whole list, so repeated `/arena rank` lookups reuse the cached ladder. The season id is resolved from the API, never hardcoded.

- **A 404 from a character's PvP summary is normal.** In a real 240-member guild, 23 members had no `pvp-summary` at all — bank alts parked at level 1, plus characters whose profile Blizzard has not published. The weekly report counts those as "no data" rather than errors, and only warns about genuine failures like rate limits.

- **Guild rosters give a class ID, not a class name.** On Anniversary, roster entries carry `playable_class.id` with no `name`, so class names have to be resolved through the playable-class index. (Direct character profiles *do* include the name — it is only the roster payload that omits it.)

- **Guild names have no index to resolve against**, unlike realms. The slug is derived with the same rule realms use, so a guild must be spelled as it appears in game; a miss reports the slug it tried rather than guessing again.

- **Commands register per guild, never globally.** Guild commands appear instantly; global registration can take up to an hour to propagate, which makes a new command feel broken. On startup the bot registers to every guild it is in, and it registers to any guild that invites it the moment it joins — no restart needed. Leftover global commands are cleared so nothing shows up twice.

- **`GUILD_ID` pins an instance to one guild.** Leave it blank for normal use. Set it and the instance registers only there and **ignores interactions and messages from every other guild**, which is how two deployments can share one bot token without fighting.

  > ⚠️ Without a `GUILD_ID`, running two instances on one token means both receive every interaction and race to answer it. The loser gets `DiscordAPIError[10062] Unknown interaction` — which looks like a timeout but is not. Either pin each instance to its own guild, or give each environment a separate Discord application.

- **`node --watch` does not pick up new command files.** It watches the module graph, and commands are loaded dynamically at ready-time, so a **brand-new** file in `commands/` never triggers a restart. Restart `npm run dev` manually after adding a command, or the running process will keep answering "that command is no longer available".

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

# Agent notes

Conventions for anyone — human or agent — working in this repository.

## Shape of the project

- **CommonJS, not ESM.** `require` / `module.exports` throughout. Do not add `"type": "module"`.
- **No database.** Everything from the Blizzard API is fetched per request. Four JSON files under `data/` are the exceptions, and each earned its place:
  - `spam.json` — moderation settings, so `/spam configure` survives a restart.
  - `reports.json` — weekly-report settings: which WoW guilds are tracked, where and when to post.
  - `reports/<guild-key>.json` — last week's snapshot per tracked guild. **This one is load-bearing, not a cache.** The Blizzard API reports only current state — a season's total wins, a lifetime honorable-kill count, today's roster — so "gained 180 rating this week" cannot be computed without keeping last week's numbers to subtract from. Delete these and every report degrades to a first run.
  - `onboarding.json` — settings for the auto-kick sweep, including the cutoff instant that protects existing members.
  - `onboarding-warned.json` — who has already had the "pick a role" reminder DM, so a restarting bot does not DM the same person repeatedly. Self-prunes every sweep.
  - `tickets.json` — ticket lobby settings, moderator roles, open tickets, and closed-ticket history. Replaces the three MySQL tables the ticket system used in the bot it was ported from.
  - `help.json` — which channel the help post lives in, and the ids of the messages that make it up.
  - `audit.json` — the audit log channel and how much to record.
  - `links.json` — Discord user id → the characters that person claimed with `/iam`, or that an admin assigned with `/iam manage assign`. **This is the only user data the bot stores**, it is volunteered rather than harvested, it holds nothing but an id and character names, and `/iam forget` deletes a user's entry outright. Keep it that way: do not add display names, activity, or anything the user did not type in themselves.

  Do not add another store without a very good reason.
- **Privileged intents: `MessageContent` and `GuildMembers` are enabled, for spam detection only.** They must be switched on in the Discord Developer Portal or login fails. Do not add further privileged intents, and do not use these two for anything beyond moderation.
- **Native `fetch`.** Node 20+ provides it. Do not add axios, node-fetch, or a request library.

## Layering

Keep these boundaries — the tests rely on them for mocking:

| Layer | Rule |
| --- | --- |
| `config/` | The only place that reads `process.env`. Everything else takes a config object or calls `readConfig()`. |
| `utils/blizzard/client.js` | The only place that calls `fetch` or knows about OAuth, namespaces, and retries. |
| `utils/blizzard/profile.js`, `gameData.js` | Thin endpoint wrappers. One function per endpoint, no formatting. |
| `commands/` | Build embeds and reply. No `fetch`, no token handling. |
| `handlers/` | Routing and error translation only. |
| `utils/spam/` | `detector.js`, `state.js` and `patterns.js` must stay free of discord.js — that is what makes them testable with plain object literals. Only `enforcement.js` and `alert.js` touch Discord types. |

## Commands

- One file per command under `commands/`, exporting `data` (a `SlashCommandBuilder`), `execute(interaction)`, plus `help` and `category` strings.
- The loader is recursive and automatic. Never maintain a manual command list.
- Registration scope is driven by `GUILD_ID`: set means guild-scoped plus a wipe of the global set (duplicates otherwise), unset means global. The wipe must stay conditional on the guild registration having succeeded — clearing first would leave the application with no commands if the guild call fails.
- Export `buildEmbed` (and any pure helper) so it can be tested without an interaction.
- Always `deferReply()` first — Blizzard calls routinely exceed Discord's 3-second interaction window.
- Handle `404` inside the command when a specific message helps the user (name the realm slug that was tried). Let every other error propagate; `handlers/interactionHandler.js` translates it.
- Use `addRegionOption` / `resolveRegion` from `utils/commandOptions.js` so every command takes `region` identically.

## Discord gotchas

- **Commands are always guild-scoped, never global.** `registerCommands` publishes to every guild in the cache, and `registerGuildJoinHandler` covers guilds joined later. Global commands are cleared after at least one guild succeeds. Do not "simplify" this back to a global `put` — global propagation takes up to an hour.
- **`GUILD_ID` pins an instance.** Blank means serve every guild. Set means register only there and drop events from anywhere else, via `isGuildInScope` in `utils/guildScope.js`, checked at the top of both handlers. This is what lets two deployments share a token; before it existed they raced and the loser got a baffling `10062`.
- **`10062` on a young interaction means a duplicate instance, not slowness.** If the interaction is well inside the 3000ms budget, this process answered in time and something else consumed the token first. `describeDeadInteraction` in `handlers/interactionHandler.js` encodes this; do not "simplify" it back to a plain timeout message.
- **`node --watch` ignores brand-new files.** Commands are required dynamically at ready-time, so adding a file under `commands/` does not restart a `npm run dev` session. The loader's "just drop a file in" convenience does not hold in watch mode.

## Blizzard API gotchas

- Namespaces are mandatory: `profile-{region}` for characters, `dynamic-{region}` for realms and the token, `static-{region}` for items.
- **One flavour has no realms at all.** Classic Forever addresses characters as `{name}-{surname}` with no realm segment, and has rulesets where every other flavour has realms. Read the "Classic Forever" section below before touching anything that takes a realm.
- Namespaces also carry the game version: `dynamic-classic-us`, `profile-classicann-us`. Build them with `buildNamespace` from `config/`; never concatenate by hand.
- **A 403 does not mean a namespace is absent.** An invalid namespace and an unauthorised one return an identical generic `403 Forbidden`, so a 403 proves nothing either way. `classicann` (TBC Anniversary) is undocumented in the API reference and was found only on Blizzard's API forum. If a realm seems missing, suspect a namespace you do not know about before concluding the data is unpublished.
- **A 404 is different, and it is informative.** Measured 2026-11-06: an unrecognised namespace 403s (`zzqqxxnonsense`, `classic2x`, `classictbc`, `era`, `vanilla`, `hardcore`, `classic-forever`, and omitting the parameter), while an *accepted* namespace with no document at that path returns `404 BLZWEBAPI00000404` — the same thing `dynamic-us` plus a bogus realm slug returns. So a 404 is positive evidence the namespace exists. This is what identified `forever`.
- **The 404 body splits it further.** A 404 with an EMPTY body means the route does not exist (`/data/wow/nonsense/index` under `dynamic-us`); a 404 carrying `BLZWEBAPI00000404` means the route and namespace are both real and there is simply no document there. Checking the body is sharper than checking the status.
- **There is no discovery endpoint.** `/data/wow/`, `/data/wow/index`, `/data/` and `/` all 404, *including* under a namespace that definitely works, and there is no OpenAPI document under `us.api.blizzard.com` or `develop.battle.net`. "Which endpoints are live?" cannot be asked, only tested one known path at a time — which is why `utils/namespaceWatch/checks.js` is a hand-maintained list and must stay in step with the wrappers in `utils/blizzard/`.
- **Never derive a realm slug when you can resolve one.** Use `resolveRealm` from `utils/blizzard/realms.js`, which matches against the live index — but reach for `resolveCharacterTarget`/`resolveRealmTarget` in `utils/commandOptions.js` from a command, since those also handle the realmless flavour. Blizzard deletes hyphens and apostrophes (`Azjol-Nerub` → `azjolnerub`) but keeps accents (`festung-der-stürme`), so the naive transformation is wrong for roughly a quarter of realms. `slugifyRealm` implements the verified rule and exists as the offline fallback.
- Character names must be lowercased in paths — use `encodeCharacterName`.
- **Endpoint wrappers take realm SLUGS, never names.** `slugifyRealm` is not idempotent: it deletes hyphens, so applying it to an existing slug turns `area-52` into `area52` and every request 404s. Resolve once with `resolveRealm`, then pass the slug down. A **null** slug is meaningful: it tells `characterPath` and `guildPath` to omit the realm segment entirely.
- Equipment payloads omit `level.value` on Classic and Anniversary; only retail supplies item levels. Render it conditionally.
- Search endpoints return **localized maps** (`{ en_US: "..." }`) while direct document fetches return plain strings. Run anything user-visible through `localized()`.
- Realm status and population live on the **connected realm**, not the realm document.
- Mythic+ ratings are RGB component objects, not integers; `ratingColor()` packs them.
- Currency values are in copper. `formatGold()` converts.

## Classic Forever (realmless flavour)

Classic Forever (`game: forever`, namespaces `static-forever-{region}` / `dynamic-forever-{region}` / `profile-forever-{region}`) does not have realms. It is the only supported flavour that works this way, and it is why several realm-shaped helpers now take a null realm. All of the below was measured against the live API on 2026-11-06.

- **A character is ONE path segment: `{name}-{surname}`, lowercased.** `/profile/wow/character/judgement-judy` → 200, with `realm: null`, a `surname` field, and a `ruleset` of `{ id, name }`. Build the slug with `characterSlug` from `utils/wow.js` and pass the realm slug as **null** — `characterPath` then omits the realm segment. Never interpolate a realm yourself; writing the string `"null"` into a path is a bug that already happened once, in `pvp.js`.
- **A guild is one segment too.** `/data/wow/guild/circle-of-lore` → 200, and `/roster` under it works. Same rule: `guildPath(null, slug)`.
- **Rulesets replace realms.** `/data/wow/ruleset/index` → 200 with four: `1` PvP, `2` Normal, `3` Roleplay, `15` Roleplay PvP, each carrying a `status` and an `auctions` link. `utils/blizzard/rulesets.js` caches and resolves them, deliberately shaped like `realms.js`. A ruleset is **not** part of a character's address — it hangs off the profile as a property, so you never need one to look a character up. `/realm` and `/realms` report them so those commands have something true to say.
- **The index gives ids only.** Ruleset index entries are `{ id, key.href }` — no name, no status — so listing them costs one request per ruleset. That is why the assembled list is what gets cached, not the index.
- **The auction index needs a trailing slash.** `/data/wow/ruleset/{id}/auctions/` works; without the slash it 404s. Nothing else in this API behaves that way, so leave it alone.
- **There are no realms, and there never will be.** `/data/wow/realm/index` and `/data/wow/connected-realm/index` 404, while `/data/wow/search/realm` returns **200 with `pageCount: 0`**. The realm collection is live and permanently empty, not unpublished — do not write anything that waits for it to fill.
- **Characters appear only from level 10, and only after logging out.** So a 404 on a character you believe exists is usually one of those two, not a broken namespace. In a 33-member roster, 22 answered `pvp-summary` and the 11 that did not were all below level 10.
- **All four regions serve it**, each with its own region id: 91 US, 93 EU, 92 KR, 94 TW. Characters are region-scoped — `judgement-judy` is EU and 404s in US.
- **`active_spec` and `active_title` are always null**, and `titles` returns `{}`. Render them conditionally; `/character` already does.
- **There is no armory page.** `armoryUrl` returns null when given no realm, because the site's character route has no realm-less shape. Callers must treat null as "no link" — `setURL(null)` throws.
- **Wowhead has no Forever database.** `WOWHEAD_PATH.forever` points at `classic/`, which is correct: Forever is patch 1.60.1.

### What cannot work, and why

These are properties of the game, not gaps Blizzard will fill. `UNSUPPORTED` in `config/index.js` holds the user-facing reason for each, and the commands reply with it instead of failing:

- **`/token`** — no WoW Token in vanilla; `/data/wow/token/index` 404s.
- **`/arena`** — arena arrived in The Burning Crusade. `pvp-season/index` and `pvp-region/index` 404; `pvp-summary` carries only `honorable_kills` and `pvp_rank`, the vanilla honour system.
- **`/mythicplus`** — keystones arrived in Legion. The endpoint 200s but returns only `current_period`, with no rating and no runs. The command is unaffected in practice because it hardcodes `game: 'retail'` and never switches version.
- **`hunter-pets`** 404s, and auction item data is sparse.

### Consequences for shared code

- **`addRealmOption` is never `setRequired(true)`.** One slash-command definition is registered for every flavour, so marking realm required would make Discord demand one from the flavour that cannot use it. The requirement moved to `resolveCharacterTarget`, which can see the chosen game. The cost is that a missing realm is reported when the command runs rather than as you type.
- **Use `resolveCharacterTarget` and `resolveRealmTarget`** from `utils/commandOptions.js` rather than calling `resolveRealm` in a command. They return either a ready-to-use target or a user-facing `error`, and they are the single place that knows two addressing shapes exist.
- **`characterKey` and `memberKey` take a surname.** Without it two Forever characters sharing a first name collapse into one entry and their report lines merge. Omitting the surname reproduces the original name-only key, so links and snapshots written before Forever existed still match.
- **A realmless link stores no realm.** `normalizeCharacter` refuses to fall back to `BLIZZARD_REALM` for these — that would key a character under a realm it is not on — and requires a surname instead.
- **A configured home realm is meaningless here.** `/realm` reads its option directly rather than through `resolveRealmName`, because applying a realm name as a ruleset name could only ever fail.

## Namespace watch

Polls the `forever` namespace and posts to `#bot-activity-log` when an endpoint the bot depends on changes state. It was built to answer "can we support this yet?"; that is now answered, so what it catches is REGRESSIONS.

- **One canary per capability the bot actually uses.** `static.playable-class`, `static.item`, `dynamic.region`, `dynamic.ruleset-index`, `profile.character`. The list is hand-maintained because there is no discovery endpoint, and it must stay in step with the wrappers in `utils/blizzard/`.
- **It does not watch the realm index.** `/data/wow/realm/index` 404s permanently and `/data/wow/search/realm` answers with `pageCount: 0`, so a check on either could never go green and would read as a standing outage. It watches `dynamic.ruleset-index` instead.
- **It does not watch `/token` or `pvp-season`.** Those cannot exist in 1.60.1 — see `UNSUPPORTED` in `config/index.js`. Polling them would report an outage forever.
- **`empty` is a state of its own.** A 200 whose listing has no rows is not the same as a working endpoint; a check declares a `rows` counter and `stateForPayload` separates the two. An unrecognised payload shape stays `available`, so a Blizzard field rename cannot invent a regression.
- **The character check needs a real character.** A name nobody owns 404s under a healthy namespace exactly as it does under a broken one, so there is no safe default. Set `NAMESPACE_WATCH_CHARACTER` to a real `{name}-{surname}` slug; unset, that one check reports `skipped`.
- **The first poll never announces.** `lastCheckedAt: null` means "no baseline", and a fresh deployment must record the current state silently or standing the bot up would announce `static` as breaking news.
- **`error`, `blocked` and `skipped` are never announced.** All three mean "we did not look", which is never news about the API. A watcher that narrates outages trains everyone to ignore the channel.
- **`data/namespace-watch.json` is the reason restarts are quiet.** Same justification as `onboarding-warned.json`: without persistence, "announce on change" becomes "announce on every deploy".
## Spam detection

- Detection is **signal counting, not scoring**: each check contributes one human-readable string, and the count is compared against a trust-tier requirement. Resist adding weights.
- Trust tiers come from account age and server tenure only. There is no strike counter and no offender history — that is deliberate, since persisting punishment records would mean a real database.
- Sliding-window state is in memory and self-sweeping. Anything added there must expire, or the maps grow forever.
- **Never act without `enforcement.preflight()`.** It checks bot permissions, the server owner, and role hierarchy. A blocked action still raises an alert; silent failure is the worst outcome.
- New scam patterns need a negative test proving ordinary guild chat does not match. `/spam test` exists for tuning them safely.

## Arena, guild, and enchant audit

- **Never hardcode a PvP season.** `getCurrentSeasonId` reads it from the API; it is 3 today and will not stay that way.
- **Ladders are cached for 10 minutes** in `utils/blizzard/pvp.js`. One bracket is ~5,000 entries and a rank lookup scans all of them, so do not fetch per bracket per invocation without the cache.
- **Only `2v2`, `3v3` and `5v5` exist in TBC.** The API also advertises `blitz-overall`, `shuffle-overall` and `rbg`; those are retail-only and empty.
- **The enchant audit must know which slots TBC can enchant.** Neck, waist, trinkets, shirt and tabard cannot be, and a relic (idol/libram/totem) in the ranged slot cannot either. Flagging them produces permanent false positives and destroys trust in the command. Rings are enchanter-only, so they are reported separately rather than as failures.
- **Sockets are not auditable.** `sockets` is absent from equipped items and null on the item document, so an empty socket is indistinguishable from no socket. Do not add "missing gem" checks; there is no data for them.
- **Guilds have no index endpoint.** Unlike realms, the slug must be derived, so a bad guild name cannot produce suggestions. Report the slug that was tried.

## Weekly reports

- **Snapshots are the feature.** Every delta in a report exists because the previous week's numbers were kept. Nothing in the Blizzard API is per-week. If a change makes snapshots optional, it has removed the point of the command.
- **Previewing must never persist.** `/report now` builds a report without saving a snapshot, because saving consumes the baseline the next report subtracts from — preview on Sunday with persistence on and Monday's scheduled report covers one day instead of seven. Only the scheduled run and `/report post` save, and both reset the week deliberately.
- **A 404 from `pvp-summary` is normal, not a failure.** Measured against a real 240-member guild, 23 members had no PvP summary: bank alts parked at level 1, plus characters whose profile Blizzard has not published. `collectKills` counts those separately from real errors. Reporting them as failures would put a warning on every report and teach people to ignore it.
- **Guild rosters carry a class ID, not a class name.** On Anniversary, `playable_class.name` is absent from roster entries — only `id` is there — so anything printing a class must resolve ids through `getPlayableClassIndex`. (The class breakdown in `/guild` predates this and is empty on Anniversary for exactly this reason.)
- **Ladders are scanned per bracket, never per character.** There is no per-character ladder endpoint, and one bracket is ~5,000 entries, so three cached list scans beat hundreds of requests for a 240-member guild.
- **The schedule is a slot, not a timer.** Each tick asks "has the most recent slot passed without a post since?". That is what makes an offline bot report late rather than never, and a restarting bot report once rather than every five minutes. `frequency` picks the cycle length; `dayOfWeek` is read only when it is `weekly`.
- **Clearing the channel only ever deletes the bot's own messages.** "Clear the channel" means "show only the current report", and a report channel is dedicated, so in practice that is everything in it — but scoping it this way means a misconfigured channel costs nobody their conversation. `bulkDelete` cannot touch anything over fourteen days old, so older messages are deleted singly.
- **The report carries counts, the button carries names.** Two hundred names would bury the rest of the report, so the breakdown goes out as a DM on request. Components belong to a message rather than an embed, so when several guilds share a channel each gets its own button.
- **The breakdown DM lists EVERYONE, on both sides.** Nothing is trimmed to "and 90 more" — the point is to work through the list. It spills across fields, then embeds, then messages, via `utils/embeds.js`; sections that are only names are `inline` columns, sections carrying structure (an account and its characters) stay full width.
- **`packFields` needs a `reserve`.** Titles and descriptions count towards the 6000-character embed budget but are added after the fields are packed, so without reserving for them an embed measured at 5,900 comes out over the limit and Discord rejects the whole message. A test covers this; it was a real bug.
- **"Not on Discord" is three states, not one** (`utils/reports/membership.js`): linked and present, linked but departed, and never linked. They need different follow-up, and `fetchPresentUserIds` returns null rather than an empty set on failure — an empty set would report the entire guild as having left.
- **Times are UTC, and every surface says so.** A timezone library is a dependency this project does not take, and reading the host's local zone would silently shift everyone's report when the box moves.
- **Posting is not an interaction, so `GUILD_ID` has to be checked by hand.** Nothing else stops a second instance sharing the token from double-posting; `publishReports` runs the channel's guild through `isGuildInScope` before sending.
- **The level cap is derived from the roster, never hardcoded.** TBC is 70 today and Anniversary realms advance on Blizzard's schedule.
- **Mentions are an upgrade, never a requirement.** Reports are built from guild rosters and read correctly with `links.json` empty; a link only turns a character name into a mention.

## Onboarding auto-kick

This is the only feature that acts on somebody for something they did **not** do, on a timer. Three rules are non-negotiable:

- **Never act on missing data.** A failed member fetch returns `null`, not `[]` — an empty list reads as "nobody has roles" and is the one misreading that could empty a server. An unknown `joinedTimestamp` is an exemption, never "joined in 1970".
- **The cutoff is the safety rail.** `enabledAt` is stamped when the sweep is switched on, and anyone who joined before it can never be removed. This is what makes enabling safe in a server with hundreds of roleless veterans. It is re-stamped on every off-to-on transition: re-enabling can surprise an admin by doing nothing, never by kicking somebody unexpected.
- **The DM goes out before the kick.** Discord will not deliver a direct message to someone you no longer share a guild with, so reversing the order silently drops every explanation. The kick proceeds whether or not the DM lands.

Also worth keeping:

- **`@everyone` is not a chosen role.** It is always in `roles.cache`, so `describeMember` discounts it; forgetting that would exempt the entire server.
- **Re-check the live member before kicking.** Classification and action are seconds apart, and somebody who picked a role in between must not be removed for not having one.
- **`MAX_KICKS_PER_SWEEP` is a blast radius, not a rate limit.** A wrong grace period or a broken auto-role bot should cost a handful of people and raise an alert, not clear the server.
- **Enabling requires an audit channel.** With no database, that channel is the only record of who was removed and why.
- **Preflight covers kicks too.** `enforcement.preflight` takes `action: 'kick'`; the owner and role-hierarchy rules are identical whatever the reason for acting, and one place knowing them is what stops a second caller getting them wrong.

## Tickets

Ported from the Squadron 42 bot's `tickets/` module. Same behaviour, different storage — that bot uses MySQL and this one has no database, so `utils/tickets/store.js` stands in for `ticket_settings`, `ticket_roles` and `tickets`.

Four things were fixed rather than copied. Do not "restore" them:

- **The lobby channel need not be in a category.** The original reads `lobbyChannel.parent` and refuses to create a ticket when it is null, which makes the whole system fail silently in a server that keeps its support channel at the top level. Here a null parent just means the ticket channel is created at the root too.
- **Nothing is recorded until the channel exists.** The original `INSERT`s the ticket, then creates the channel; a permissions failure leaves a ticket row pointing at nothing. Here `reserveId()` hands out the number (it is part of the channel name) and `openTicket()` is called only once the channel is really there.
- **Manage Server always counts as a moderator.** The original falls back to a permission check *only* when no moderator roles are configured, so adding the first role locks out every admin who does not hold it.
- **There is a per-user cap on open tickets.** Each one is a real channel, and the original has no limit at all.

Other things worth keeping:

- **Custom ids are the routing contract**: `ticket:<action>[:<ticketId>]`, matched by prefix in `handlers/interactionHandler.js`. A component belongs to whatever posted it, not to a slash command, which is why it is not routed through `client.commands`.
- **`handlers/interactionHandler.js` now routes buttons and modals**, and the `GUILD_ID` scope check runs *before* the interaction-type check so a pinned instance ignores another guild's button presses too. Two instances answering one click is the same failure mode as the `10062` race on commands.
- **Ticket ids are never reused.** `normalizeStore` raises `nextId` above the highest id in open *or* closed tickets, because a recycled id would attach a new ticket's buttons to an old ticket's history.
- **The lobby panel is re-posted at startup.** It is an ordinary message and can be deleted or purged; without `ensureLobbyMessage` on ready, the Open Ticket button quietly stops existing.
- **Closed-ticket history is capped** at `MAX_CLOSED_HISTORY`. Everything else in `data/` is settings; this is the one list that would otherwise grow forever.
- **Close answers the interaction before rearranging the channel.** Editing permission overwrites and moving a channel between categories takes long enough to risk the interaction expiring first.

## Locked channels

Three channels are owned outright by the bot — the help post, the ticket lobby, and the audit log — and all of them go through `utils/channelLock.js`. It exists because Discord's permission resolution has a trap in it:

- **Denying `SendMessages` on @everyone is not enough.** It beats a role's SERVER-level permissions, but it does NOT beat a role-specific overwrite on the same channel; those are applied afterwards and win. `postingRoleOverwrites` finds those roles and denies them too. A lock that skips this step looks applied and does nothing.
- **`UseApplicationCommands` is denied deliberately.** A slash command run in the channel posts its reply there, burying the message the lock exists to keep visible.
- **`visibility: 'admins'` hides the channel** instead of making it public, for the audit log. Roles with Manage Server are granted access explicitly — unlike Administrator, Manage Server does **not** bypass a `ViewChannel` denial, and a moderator role that cannot read the log is the obvious failure here.
- **`unlockChannel` clears the allow list as well as the deny list**, or a hidden channel would come back unlocked and still invisible.
- **Administrators bypass all of it.** No bot can prevent that. Every command that applies a lock says so in its reply; do not remove that line to make the output tidier.

## Help post

- **Generated from the loaded commands, never hand-maintained.** Every command exports `help` and `category`; the post is rebuilt from `client.commands` after registration on each startup, so it cannot describe a command the bot no longer has.
- **One message per category, with jump links.** The header is posted first, the sections after, and then the header is edited a second time to add links — the section ids do not exist until they have been posted, so the table of contents is necessarily a second pass.
- **Update in place, or replace wholesale — never patch.** Discord messages cannot be reordered, and a message sent now lands at the bottom. If any stored message is missing, or the number of sections has changed, the whole post is deleted and republished so the sections stay in order.
- **There is deliberately no refresh command.** The post is checked on every boot, and a stored content fingerprint means an unchanged command set writes nothing at all. Without the fingerprint, every restart would rewrite every message and leave an edit on a post nobody touched. The fingerprint is computed WITHOUT the table of contents, whose links contain message ids that do not exist on the first pass.
- **Admin commands are excluded from the posted version** (`forAudience` in content.js). The channel is public; a list of commands almost everyone reading it cannot run is noise. `/help show` includes them for members who can actually use them.
- **A public command can still have admin-only SUBCOMMANDS.** `/iam` is for everybody but `/iam manage assign` is not; `/help show` is for everybody but `/help setup` is not. Those commands export `adminSubcommands`, and `commandField` filters them out of the public post. Matching is on the leading segment, so naming a group covers everything inside it — add the export whenever a public command gains a gated subcommand, or it leaks into the help channel.
- **`/help` carries no default-member-permissions flag**, because `/help show` is for everyone; the administrative subcommands check Manage Server in code.

## Audit log

- **Entries are buffered and flushed together.** Discord allows roughly five messages per five seconds per channel; one send per action would exhaust that during any burst and start dropping the very records the log exists to keep.
- **Plain text lines, not embeds.** A log is read by scanning down it, and twenty embeds in a row is a wall of boxes.
- **Mentions are rendered but suppressed** with `allowedMentions: { parse: [] }`. The log names people constantly; pinging them would make it unusable.
- **Logging must never break the thing it is logging.** `record` never throws and never awaits the send; every failure is a `console.warn`.
- **`verbosity: 'admin'` still records everything automatic.** An unprompted kick or a scheduled report is the whole point of having a log, so the filter only ever drops ordinary lookups.
- This is separate from the spam and onboarding alert channels on purpose: those carry the full reasoning behind one decision, this is the flat chronological feed.

## Admin-only lockdown

- **`config.discord.adminOnly` is ON by default.** Every command requires Manage Server while it is, whatever the command declares for itself. `ADMIN_ONLY=false` lifts it.
- **`PUBLIC_COMMANDS` in `config/index.js` is the undo.** It records which commands were open to everyone before the lock, so restoring is reading a list rather than reconstructing one. Keep it accurate if a public command is added.
- **The lock is applied twice, deliberately.** `buildDefinitions` stamps Manage Server onto every registration so members do not see the commands; `handleInteraction` re-checks, because a guild can override the permission Discord displays. Removing either one leaves a lock that does not hold.

## Mains and nicknames

- **Exactly one main, enforced in `normalizeCharacters`, not trusted from the file.** Two mains give an unstable nickname; none silently stops somebody being counted as a person. The first flagged character wins, and the first character becomes the main when none is flagged.
- **Unlinking a main promotes a replacement**, which falls out of the normalizer rather than being special-cased.
- **The bot cannot rename the server owner — ever — and cannot rename anyone ranked at or above itself.** That covers most officers, so every path reports refusals with their reason instead of failing quietly. This is the single most likely thing to be mistaken for a broken feature.
- **Nicknames are re-applied on `GuildMemberAdd`**, because Discord discards them when somebody leaves.
- **Headcounts are people, unclaimed characters are characters** (`countPeople` in membership.js). Never fold the two together: alts collapse only when somebody has claimed them, and pretending otherwise turns a guess into a stated fact.

## Testing

- `npm test` runs Jest with coverage and an 80% global threshold. Keep it passing.
- Tests live in `__tests__/`, mirroring the source layout. Only `*.test.js` files are collected, so shared helpers can live in `__tests__/helpers/`.
- Never hit the network. Mock `global.fetch` for client tests and `jest.mock` the endpoint modules for command tests.
- Use the fake interaction from `__tests__/helpers/interaction.js` rather than building one inline.
- `__tests__/fixtures/commands/` deliberately contains broken command files; the loader tests rely on them.

## Style

- Two-space indentation, single quotes, semicolons.
- Comments explain *why* something is the way it is, not what the line does. The existing comments about Blizzard's API quirks are the model.
- Emoji are used in console output and user-facing replies (✅ ❌ 🟢 ⚠️); keep that consistent.

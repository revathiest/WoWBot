# Agent notes

Conventions for anyone — human or agent — working in this repository.

This bot serves exactly ONE WoW flavour: **Classic Forever**, patch 1.60.1. That
was a deliberate pivot (2026-11-06) — earlier versions of this file described a
multi-flavour bot (retail, TBC Anniversary, Classic, Classic Era) with Forever as
one option among several. All of that is gone: no `game` picker, no realm
concept anywhere, and three commands (`/token`, `/arena`, `/mythicplus`) were
deleted outright because their whole purpose depends on something this flavour
does not have.

## Shape of the project

- **CommonJS, not ESM.** `require` / `module.exports` throughout. Do not add `"type": "module"`.
- **No database.** Everything from the Blizzard API is fetched per request. Four JSON files under `data/` are the exceptions, and each earned its place:
  - `spam.json` — moderation settings, so `/spam configure` survives a restart.
  - `reports.json` — weekly-report settings: which WoW guilds are tracked (by name and region only — there is no realm), where and when to post.
  - `reports/<guild-key>.json` — last week's snapshot per tracked guild. **This one is load-bearing, not a cache.** The Blizzard API reports only current state — a season's total wins, a lifetime honorable-kill count, today's roster — so "gained 180 rating this week" cannot be computed without keeping last week's numbers to subtract from. Delete these and every report degrades to a first run.
  - `reports/kills-<guild-key>.json` — a short rolling window (`killHistory.js`'s `MAX_ENTRIES`, currently 10) of daily `{ capturedAt, kills }` entries per tracked guild, kept **in addition to** the snapshot above. One previous snapshot is enough for "what changed since the last report", but not for "kills in the last 7 days" — that needs a point from roughly a week back, which a single-snapshot store cannot give you. Names and classes still come from the regular snapshot; this file is deliberately just character key → a number, once a day, so it stays small even for a 250-member guild. Deleted alongside the snapshot on `/report untrack`.
  - `onboarding.json` — settings for the auto-kick sweep, including the cutoff instant that protects existing members.
  - `onboarding-warned.json` — who has already had the "pick a role" reminder DM, so a restarting bot does not DM the same person repeatedly. Self-prunes every sweep.
  - `tickets.json` — ticket lobby settings, moderator roles, open tickets, and closed-ticket history. Replaces the three MySQL tables the ticket system used in the bot it was ported from.
  - `help.json` — which channel the help post lives in, and the ids of the messages that make it up.
  - `audit.json` — the audit log channel and how much to record.
  - `links.json` — Discord user id → the characters that person claimed with `/iam`, or that an admin assigned with `/iam manage assign`. **This is the only user data the bot stores**, it is volunteered rather than harvested, it holds nothing but an id and a `{name, surname, region}` per character, and `/iam forget` deletes a user's entry outright. Keep it that way: do not add display names, activity, or anything the user did not type in themselves.
  - `voice.json` — per-guild "join to create" settings (the trigger channel, and an optional category override), plus one entry per private voice room currently open, keyed by its own channel id, recording its owner. The second half is **load-bearing, not a cache**: it is the only thing that lets the handler recognise "this channel is one of ours" and "whoever just left owns it" after a restart — nothing on a voice channel itself says that.

  Do not add another store without a very good reason.
- **Privileged intents: `MessageContent` and `GuildMembers` are enabled, for spam detection only.** They must be switched on in the Discord Developer Portal or login fails. Do not add further privileged intents, and do not use these two for anything beyond moderation. `GuildVoiceStates` (for `/voice`) is also enabled, but is NOT privileged — it needs no Developer Portal toggle.
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
- Handle `404` inside the command when a specific message helps the user (name the slug that was tried). Let every other error propagate; `handlers/interactionHandler.js` translates it.
- Use `addRegionOption` / `resolveRegion` from `utils/commandOptions.js` so every command takes `region` identically. There is no `game` option anywhere — this bot serves one flavour, so there is nothing to pick.
- A character-taking command uses `resolveCharacterTarget` from `utils/commandOptions.js` — it turns whatever was typed (`Judgement-Judy`, `Judgement Judy`, or `character:Judgement surname:Judy`) into the `{name}-{surname}` slug Blizzard wants, or a user-facing `error` naming what is missing. Never build that slug by hand.

## Discord gotchas

- **Commands are always guild-scoped, never global.** `registerCommands` publishes to every guild in the cache, and `registerGuildJoinHandler` covers guilds joined later. Global commands are cleared after at least one guild succeeds. Do not "simplify" this back to a global `put` — global propagation takes up to an hour.
- **`GUILD_ID` pins an instance.** Blank means serve every guild. Set means register only there and drop events from anywhere else, via `isGuildInScope` in `utils/guildScope.js`, checked at the top of both handlers. This is what lets two deployments share a token; before it existed they raced and the loser got a baffling `10062`.
- **`10062` on a young interaction means a duplicate instance, not slowness.** If the interaction is well inside the 3000ms budget, this process answered in time and something else consumed the token first. `describeDeadInteraction` in `handlers/interactionHandler.js` encodes this; do not "simplify" it back to a plain timeout message.
- **`node --watch` ignores brand-new files.** Commands are required dynamically at ready-time, so adding a file under `commands/` does not restart a `npm run dev` session. The loader's "just drop a file in" convenience does not hold in watch mode.

## Blizzard API gotchas

Everything below is Classic Forever's actual shape — `static-forever-{region}` /
`dynamic-forever-{region}` / `profile-forever-{region}`, patch 1.60.1 — measured
against the live API on 2026-11-06. There is no other flavour in this codebase
to contrast it with any more.

- Namespaces are mandatory on every call: `profile-forever-{region}` for characters and guilds, `dynamic-forever-{region}` for rulesets, `static-forever-{region}` for items. Build them with `buildNamespace` from `config/`, which always inserts the `forever` infix — never concatenate by hand.
- **There are no realms, and there never will be.** `/data/wow/realm/index` and `/data/wow/connected-realm/index` 404 permanently; `/data/wow/search/realm` answers **200 with `pageCount: 0`** — the collection is live and empty, not unpublished. Do not write anything that waits for it to fill.
- **A character is ONE path segment: `{name}-{surname}`, lowercased.** `/profile/wow/character/judgement-judy` → 200, with `realm: null`, a `surname` field, and a `ruleset` of `{ id, name }` in its place. Build the slug with `characterSlug` from `utils/wow.js`; `resolveCharacterTarget` in `utils/commandOptions.js` does this for a command from whatever was typed. Never interpolate a realm into a character path — writing the literal string `"null"` into a URL is a bug that already happened once, in what is now `utils/blizzard/profile.js`.
- **A guild is one segment too.** `/data/wow/guild/circle-of-lore` → 200, and `/roster` under it works. There is no guild index, so a bad name cannot produce suggestions — only the slug that was tried.
- **Rulesets are what this flavour has instead of realms.** `/data/wow/ruleset/index` → 200 with four: `1` PvP, `2` Normal, `3` Roleplay, `15` Roleplay PvP, each carrying a `status` and an `auctions` link. `utils/blizzard/rulesets.js` caches and resolves them. A ruleset is **not** part of a character's address — it hangs off the profile as a property, so you never need one to look a character up. `/realm` and `/realms` report them because that is the whole of what this flavour has to say in place of realm status.
- **The ruleset index gives ids only.** Entries are `{ id, key.href }` — no name, no status — so listing them with names costs one request per ruleset. That is why the assembled list is what gets cached, not the index.
- **The ruleset auction index needs a trailing slash.** `/data/wow/ruleset/{id}/auctions/` works; without the slash it 404s. Nothing else in this API behaves that way, so leave it alone.
- **Characters appear only from level 10, and only after logging out.** A 404 on a character you believe exists is usually one of those two, not a broken namespace. In a 33-member roster, 22 answered `pvp-summary` and the 11 that did not were all below level 10.
- **A 403 and a 404 do NOT mean the same thing.** `403 BLZWEBAPI00000403` means the namespace itself is not recognised or not ours to read — this is how `classic-forever` was ruled out as the wrong namespace name (the real one is `forever`). `404 BLZWEBAPI00000404` means the namespace IS accepted and that specific path simply has no document — a bogus character or guild name 404s this way under a perfectly healthy namespace. A 404 with an **empty body**, by contrast, means the *route itself* does not exist (`/data/wow/nonsense/index`). Checking the body is sharper than checking the status alone.
- **There is no discovery endpoint.** `/data/wow/`, `/data/wow/index`, `/data/` and `/` all 404, including under a namespace that definitely works, and there is no OpenAPI document under `us.api.blizzard.com` or `develop.battle.net`. "Which endpoints are live?" cannot be asked, only tested one known path at a time — which is why `utils/namespaceWatch/checks.js` is a hand-maintained list and must stay in step with the wrappers in `utils/blizzard/`.
- **All four regions serve it**, each with its own region id: 91 US, 93 EU, 92 KR, 94 TW. Characters are region-scoped — `judgement-judy` is EU and 404s in US.
- **`active_spec` and `active_title` are always null**, and `titles` returns `{}`. Render them conditionally; `/character` already does.
- **There is no armory page.** The site's character route has no realm-less shape, so no URL exists to link to. `/character`'s embed simply has no `setURL` call — do not try to construct one.
- **Wowhead has no separate Forever database.** `WOWHEAD_PATH` in `utils/wow.js` is hardcoded to `classic/`, which is correct: Forever is patch 1.60.1, the vanilla era.
- Search endpoints return **localized maps** (`{ en_US: "..." }`) while direct document fetches return plain strings. Run anything user-visible through `localized()`.
- Currency values are in copper. `formatGold()` converts.

### What cannot work, and why — the three deleted commands

`/token`, `/arena` and `/mythicplus` do not exist in this codebase. They were
removed outright rather than kept and made to refuse gracefully, because their
entire reason for existing depends on something 1.60.1 does not have:

- **WoW Token** — vanilla had none; `/data/wow/token/index` 404s.
- **Arena** — arrived in The Burning Crusade. `pvp-season/index` and `pvp-region/index` 404; `pvp-summary` carries only `honorable_kills` and `pvp_rank`, the vanilla honour system (and that part DOES work — it powers the weekly report's kill tracking, via `getCharacterPvpSummary` in `utils/blizzard/profile.js`).
- **Mythic Keystones** — arrived in Legion. The endpoint 200s but returns only `current_period`, with no rating and no runs — nothing a command could show.

Do not re-add any of the three expecting a reasoned refusal to be enough; the
decision made here was to remove the feature, not soften its failure.

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

## Guild and enchant audit

- **Sockets are not auditable.** `sockets` is absent from equipped items and null on the item document, so an empty socket is indistinguishable from no socket. Do not add "missing gem" checks; there is no data for them.
- **Guilds have no index endpoint.** The slug must be derived, so a bad guild name cannot produce suggestions. Report the slug that was tried.
- **`utils/enchants.js`'s slot list was written for TBC and has not been re-verified against 1.60.1.** Its own comments say "Always enchantable in TBC" for `ENCHANTABLE_SLOTS`, which includes `SHOULDER` — shoulder enchants are a later addition in WoW's real history, and nothing in this retrofit confirmed whether Forever's 1.60.1 ruleset has them. If `/audit` is ever seen flagging a shoulder slot as "missing" on a character nobody enchants there, this is the first place to check — not a bug in the audit logic itself. Rings are enchanter-only regardless of era, so they are reported separately rather than as failures.

## Weekly reports

- **A tracked guild is name and region only — there is no realm.** `guildKey` in `utils/reports/config.js` identifies a guild by those two alone; two same-named guilds in different regions stay apart, but there is no third axis to disambiguate further. Any `reports.json` written before this retrofit may carry old `realm`/`game` fields — `normalizeGuild` silently ignores them, which re-keys a pre-existing tracked guild under the new, shorter identity. That is a one-time, harmless migration, not a bug.
- **Snapshots are the feature.** Every delta in a report exists because the previous week's numbers were kept. Nothing in the Blizzard API is per-week. If a change makes snapshots optional, it has removed the point of the command.
- **Previewing must never persist.** `/report now` builds a report without saving a snapshot, because saving consumes the baseline the next report subtracts from — preview on Sunday with persistence on and Monday's scheduled report covers one day instead of seven. Only the scheduled run and `/report post` save, and both reset the week deliberately.
- **A member's roster entry has a surname, and `memberKey`/`characterKey` key on BOTH halves.** Characters have no realm, so without the surname two roster members who happen to share a first name would collapse into one snapshot entry, with kills and levels attributed to whichever was read last.
- **A 404 from `pvp-summary` is normal, not a failure.** It is what a character below level 10, or one that has never logged out, returns — `collectKills` counts those separately from real errors (a 5xx, a timeout). Reporting them as failures would put a warning on every report and teach people to ignore it.
- **Guild rosters carry a class ID, not a class name.** `playable_class.name` is absent from roster entries — only `id` is there — so anything printing a class resolves ids through `getPlayableClassIndex` first.
- **The schedule is a slot, not a timer.** Each tick asks "has the most recent slot passed without a post since?". That is what makes an offline bot report late rather than never, and a restarting bot report once rather than every five minutes. `frequency` picks the cycle length; `dayOfWeek` is read only when it is `weekly`.
- **Clearing the channel only ever deletes the bot's own messages.** "Clear the channel" means "show only the current report", and a report channel is dedicated, so in practice that is everything in it — but scoping it this way means a misconfigured channel costs nobody their conversation. `bulkDelete` cannot touch anything over fourteen days old, so older messages are deleted singly.
- **The report carries counts, the button carries names.** Two hundred names would bury the rest of the report, so the breakdown goes out as a DM on request. Components belong to a message rather than an embed, so when several guilds share a channel each gets its own button.
- **The breakdown DM lists EVERYONE, on both sides.** Nothing is trimmed to "and 90 more" — the point is to work through the list. It spills across fields, then embeds, then messages, via `utils/embeds.js`; sections that are only names are `inline` columns, sections carrying structure (an account and its characters) stay full width.
- **The kill tally runs daily regardless of the report's own `frequency`.** `buildGuildReport` computes and (when persisting) appends it unconditionally — a guild reported on weekly still gets a daily honorable-kill check, because that was the explicit ask: roster changes can wait a week, kill-grinding should not. It rides along on the same post, channel, and hour as the regular report rather than having its own schedule.
- **The kill tally shows all three figures on every line, not one sorted view.** Lifetime, 7-day, and today's gain are all computed by `buildKillTally` (`utils/reports/killTally.js`) and shown together, sorted by today's gain — "toggle between views" was considered and rejected in favour of just showing everything, since that is strictly more informative and avoids doubling the button count per guild.
- **The tally button re-derives, it does not re-fetch.** `handleKillTallyComponent` reads the stored snapshot and kill history rather than hitting the Blizzard API again — the latest kill-history entry IS the snapshot's kills (both were written together when the report posted), so dropping that last entry and treating the snapshot as "current" reproduces exactly what was shown at posting time.
- **`packFields` needs a `reserve`.** Titles and descriptions count towards the 6000-character embed budget but are added after the fields are packed, so without reserving for them an embed measured at 5,900 comes out over the limit and Discord rejects the whole message. A test covers this; it was a real bug.
- **"Not on Discord" is three states, not one** (`utils/reports/membership.js`): linked and present, linked but departed, and never linked. They need different follow-up, and `fetchPresentUserIds` returns null rather than an empty set on failure — an empty set would report the entire guild as having left.
- **Times are UTC, and every surface says so.** A timezone library is a dependency this project does not take, and reading the host's local zone would silently shift everyone's report when the box moves.
- **Posting is not an interaction, so `GUILD_ID` has to be checked by hand.** Nothing else stops a second instance sharing the token from double-posting; `publishReports` runs the channel's guild through `isGuildInScope` before sending.
- **The level cap is derived from the roster, never hardcoded.** Whatever the highest level actually present is, that is the cap shown — no constant to update if Blizzard ever raises it.
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

## Private voice channels

"Join to create": joining a configured trigger voice channel spawns a brand-new voice channel, moves the member into it, and hands them elevated, channel-scoped permissions over it. Leaving closes it.

- **There is no separate "kick everyone" step.** Deleting a voice channel disconnects everyone still in it — that IS what "boots everyone" is. `handleLeave` in `utils/voice/core.js` just calls `channel.delete()`.
- **The room closes when the OWNER leaves, not just when it empties.** These are two different triggers, both checked in `handleLeave`: `ownerLeft` (their room, their rules — gone the moment they step out, even if guests remain) and `empty` (nobody's left, for any reason — a crash, a kick, an owner who never actually got moved in). Either one closes it. A "wait for everyone to leave" rule alone would leave a room open indefinitely if the owner disconnects but a guest's client lags behind, or lets the owner hand their room to someone else by just not leaving — neither is wanted here.
- **Ownership is tracked in `data/voice.json`, not inferred from the channel.** Nothing about a Discord voice channel says "the bot made this" or "this person owns it" — without a persisted record, a restart would turn every open room into an untracked, un-closable orphan. See the `voice.json` entry under "No database" above.
- **The new room inherits permission overwrites from wherever it was spawned** — the configured category, or the trigger channel itself if there is no category — rather than getting a blank slate. A public hangout's trigger produces public rooms; a members-only lounge's trigger produces members-only rooms. `buildOverwrites` in `utils/voice/core.js` strips any inherited overwrite that already targets the new owner or the bot before layering their own on top, so a stale overwrite from the source can never fight the one that matters.
- **The owner's permissions are deliberately channel-scoped, not server-wide.** `ManageRoles` in the overwrite it receives only lets it edit *this channel's* permission overwrites (lock it, block one person) — it grants nothing against the server's actual roles. Giving a member of the server `ManageChannels`/`ManageRoles`/`MoveMembers` as a channel overwrite, rather than a role, is what makes "full control of your own room" safe to hand out automatically.
- **Creating the room and moving the member in are two separate calls, and either can fail independently.** A failed creation warns and gives up. A created room the member could not be moved into (they likely left mid-creation) is deleted immediately rather than left as an empty, ownerless room nobody would ever close.
- **A channel deleted directly — not by someone leaving — still has to be forgotten.** `handlers/voiceHandler.js` also listens for `ChannelDelete` and drops the `voice.json` entry, or a manually-deleted room would leave a permanent stale record.
- **`GuildVoiceStates` is a non-privileged intent.** Unlike `MessageContent`/`GuildMembers`, it needs no Developer Portal toggle — it was simply missing from `index.js` until this feature needed it.

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

- **`config.discord.adminOnly` is ON by default.** Every command requires Manage Server while it is, whatever the command declares for itself. `ADMIN_ONLY=false` lifts it, restoring each command's own declared permissions — public for most, since only a few (`/report`, `/ticket`, `/auditlog`, `/autokick`, `/spam`, `/voice`) declare their own Manage Server restriction.
- **The lock is applied twice, deliberately.** `buildDefinitions` stamps Manage Server onto every registration so members do not see the commands; `handleInteraction` re-checks, because a guild can override the permission Discord displays. Removing either one leaves a lock that does not hold.

## Mains and nicknames

- **Exactly one main, enforced in `normalizeCharacters`, not trusted from the file.** Two mains give an unstable nickname; none silently stops somebody being counted as a person. The first flagged character wins, and the first character becomes the main when none is flagged.
- **Unlinking a main promotes a replacement**, which falls out of the normalizer rather than being special-cased.
- **The bot cannot rename the server owner — ever — and cannot rename anyone ranked at or above itself.** That covers most officers, so every path reports refusals with their reason instead of failing quietly. This is the single most likely thing to be mistaken for a broken feature.
- **Nicknames are re-applied on `GuildMemberAdd`**, because Discord discards them when somebody leaves.
- **Headcounts are people, unclaimed characters are characters** (`countPeople` in membership.js). Never fold the two together: alts collapse only when somebody has claimed them, and pretending otherwise turns a guess into a stated fact.
- **A linked main is also a lookup shortcut.** `/character` with no character typed resolves the caller's own main via `resolveCharacterTarget({ ..., fallbackToMain: true })` in `utils/commandOptions.js`, and uses THAT character's own stored region ahead of the bot's configured default — an explicit `region` option still wins over both. No other character-taking command does this; it is opt-in per call, not a change to the shared resolver's default behaviour.

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

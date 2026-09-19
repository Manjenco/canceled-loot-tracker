# Canceled Loot Tracker — Web App

## What this project is
The web app component of the Canceled guild loot tracker.
- Handles all complex UI — loot council, BIS submission, roster, history, seasons, admin
- **Cloudflare D1 (SQLite) is the database** (source of truth); all reads/writes go through `src/lib/db.js`
- Discord OAuth is how users authenticate
- Warcraft Logs sync populates attendance, worn-BIS, and tier-snapshot data
- Supports multiple raid teams from a single instance, and multiple **seasons** (data is season-partitioned)

The Discord bot (panel posting, RCLC import, brief notifications) lives in a
separate repo: `loot-tracker-bot`.

> **History:** this app was originally backed by Google Sheets. It has since migrated to
> Cloudflare Workers + D1. `src/lib/sheets.js` is the **legacy** Sheets layer and is retained
> only for the one-time "migrate from sheets" admin import — it is **not** the live data path.
> Everything current goes through `src/lib/db.js`.

## Architecture

### Web app — the real UI
A single Cloudflare Worker serves both the Hono API (`/api/...`) and the built React client
(served under the `/loot` base path). Officers and raiders log in with Discord OAuth; the app
resolves their team and role after login. Most pages require login; there is no public page yet
(a public `/sales` storefront is designed but not built — see `docs/sales-feature-design.md`).

**Client routes** (`src/web/client/src/App.jsx`):
| Route | Who | What |
|-------|-----|------|
| `/` | Raider | Dashboard — own loot history + BIS status + SimC import |
| `/bis` | Raider | Submit / edit BIS list (slot-by-slot form) |
| `/council` | Officer | Loot council — pick boss/item, ranked candidates |
| `/roster` | Officer | Add/edit characters, bench/active, spec management |
| `/bis/review` | Officer | Approve or reject pending BIS submissions |
| `/import`, `/loot-history` | Officer | RCLC import + full loot log |
| `/admin` | Officer | Team admin hub |
| `/admin/team-config` | Officer | Per-team config |
| `/admin/default-bis` | Global officer | Default BIS editor (per spec) |
| `/admin/global-config` | Global officer | Guild-wide config + WCL bonus-ID detection |
| `/admin/seasons` | Global officer | Season registry (zone IDs, Track Base, etc.) |
| `/admin/item-db` | Global officer | Item DB + Tier Items sync |

**Roles:** `requireAuth` (logged in) → `isOfficer` (per-team officer) → `isGlobalOfficer`
(guild-wide). Resolved from Discord guild membership + roles on our server after OAuth.

**Hosting:** Cloudflare Workers (`canceledwow.com`). Cron triggers run the WCL sync on a schedule
(prod: every 10 min, see `wrangler.toml [triggers]`).

## Stack
- **Runtime:** Cloudflare Workers (V8 isolates) with `nodejs_compat`; ESM modules
- **Server:** Hono router (`src/web/server/index.js` + `routes/`)
- **Client:** React 18 + Vite. Dev: Vite on :3000 proxies `/api` → Wrangler on :3001. Prod: built
  to `dist/loot` (base `/loot/`) and served via the Worker `[assets]` binding.
- **Auth:** Discord OAuth2 + a session cookie (`sessionMiddleware` sets it globally; `requireAuth`
  enforces it per-router/route)
- **Data:** Cloudflare D1 (SQLite) via `src/lib/db.js` — the only place that touches D1
- **Local dev:** `wrangler dev` (Miniflare); local D1 lives in `.wrangler/state/...`. Secrets in
  `.dev.vars` locally, Worker secrets in prod (e.g. `WCL_CLIENT_SECRET`). Config in `wrangler.toml`.
  See the `local_dev_command` memory for the single command that runs the full stack.
- **Migrations:** in-process registry in `src/lib/migrations.js` (recorded in `schema_migrations`),
  run from Admin. `schema.sql` is the source of truth for fresh DBs; the `migrations/` dir (wrangler
  CLI) is legacy/unused by the app runner.

## Project structure
```
src/
  lib/
    db.js                — ALL D1 reads/writes + the in-memory cache layer
    migrations.js        — in-process D1 migration registry (append-only; check()-gated)
    specs.js             — spec/class constants, armor/weapon rules, track ranges,
                           getClassForSpec, getCharSpecs, resolveVeteranStarts, WOW_SPEC_ID_TO_NAME
    wcl-sync.js          — Warcraft Logs sync: attendance, worn BIS, tier snapshots
    wcl.js               — WCL GraphQL API client
    wago.js              — DB2 / wago.tools helpers (item + bonus-ID datamining)
    item-seeder.js       — maps DB2 rows → item_db rows (incl. tier tokens/pieces)
    bis-parser.js        — parse Wowhead/Maxroll BIS guides + the catalyze block
    bis-match.js         — BIS matching + raid-BIS inference
    rclc.js              — RCLC CSV parser + loot-entry builder
    sheets.js            — LEGACY Google Sheets layer (migration import only; not live)
  web/
    server/
      index.js           — Hono entry point (mounts route groups, session, cors)
      routes/            — one file per group: auth, me, dashboard, bis, council, loot,
                           roster, admin, admin-items, tier-items, debug
      middleware/        — requireAuth, session
    client/
      src/ App.jsx, pages/, components/ (ItemSelect, Layout…), hooks/ (useMe…)
      vite.config.js     — base /loot/ (build), proxy /api → :3001 (dev)
schema.sql               — full D1 schema (fresh-DB source of truth)
migrations/              — legacy wrangler CLI migrations (0001–0003); app uses src/lib/migrations.js
scripts/                 — seeders + maintenance (seed-item-db, run-wcl-sync, etc.)
wrangler.toml            — Worker config: D1 binding (DB), assets, cron, compat flags
```

## Data model (D1)

One D1 database. Every table is either **guild-wide** or **team-scoped** (`team_id`), and most
operational/reference data is **season-scoped** (`season_id`). `schema.sql` is the authoritative
column list; the notes below capture semantics, not exact column order.

**Guild-wide tables:** `teams`, `global_config`, `seasons`, `item_db`, `default_bis`,
`spec_bis_config`, `tier_items`, `season_sources`, `transfers`.
**Team-scoped tables:** `team_config`, `roster`, `loot_log`, `bis_submissions`, `raids`,
`raid_encounters`, `tier_snapshot`, `worn_bis`, `loot_summary`, `rclc_response_map`.
Plus `schema_migrations` (migration bookkeeping).

### Seasons (guild-wide) — the partitioning axis
`seasons` holds one row per season. **Current season** resolution (`getCurrentSeason`):
1. a manual override (`is_current = 1`) if set, else
2. the newest non-`pre_release` season whose `start_date` has passed, else
3. any non-pre-release season, else any season.

Per-season config lives on the season row (set in Admin → Seasons), not global config:
- `start_date` — cutoff for historical/WCL queries
- `zone_ids` — pipe-separated WCL zone IDs for this season's raid; **blank pauses WCL sync**
- `veteran_bonus_id` — this season's Veteran-track start bonus ID ("Track Base"); scopes upgrade-track
  detection to this season so Worn BIS resets each season (see Worn BIS). Falls back to the global
  multi-season list when unset.
- `token_slot_words` — tier-token flavor-word → slot map
- `mplus_wse` — current M+ WorldStateExpression gate (DB2)
- `pre_release` — seed the Item DB from the latest (PTR) DB2 build instead of newest live

Reads/writes take a `seasonId`; the API resolves the **viewed** season via `viewSeasonId(c, db)`
(top-bar selector) for reads, while writes/sync target the **current** season.

### roster (team) — characters
- `id` (autoincrement) is the stable identity; renames only touch `char_name`. `legacy_char_id`
  holds the old Sheets UUID (migration only; NULL for new chars).
- `class`, `spec` (primary), `secondary_specs` (pipe-separated), `pending_primary_spec` (awaiting
  officer approval). See `getCharSpecs()` — it dedupes and strips the primary from secondaries.
- `role` is derived from spec on read (`specToRole`); don't rely on the stored column.
- `status`: Active | Bench | Inactive. `owner_id` (Discord id), `owner_nick`.
- `server` — realm; normally empty, set only to disambiguate two same-named chars on a team.
- `deleted` — soft-delete flag; all roster reads filter `deleted = 0`. The name-uniqueness index
  `idx_roster_name_server` is **partial (`WHERE deleted = 0`)** so a deleted char's name can be reused.
- Spec changes: raiders request a primary swap (`pending_primary_spec`), officers approve/reject;
  officers can also force a primary directly. All go through a shared swap (promote → demote old
  primary to secondary → clear pending) so a spec never lands in both primary and secondary.

### loot_log (team, season) — awarded loot
- `recipient_char_id` → `roster.id` (name is a display fallback). `recipient_id` = Discord id.
- `upgrade_type`: BIS | Non-BIS | Tertiary. BIS/Non-BIS count toward totals (by N/H/M difficulty);
  Tertiary is recorded but excluded from totals.
- Primary import path: RCLC CSV (`/import` → `rclc.js` `buildLootEntries`). `loot_summary` is a
  materialized per-char aggregate, rebuilt on write.

### bis_submissions (team, season)
- Keyed by `char_id`; `char_name` kept for readability. Upsert key `(season, team, char, slot)`.
- `status`: Pending | Approved | Rejected. `true_bis` = Overall BIS, `raid_bis` = Raid BIS (optional).
- Effective BIS per slot: approved personal submission > spec default (`default_bis`) fallback.

### item_db (guild-wide, season)
- `(season_id, item_id)` unique. Columns: name, slot, source_type (Raid | Mythic+), source_name,
  instance, difficulty, armor_type, is_tier_token.
- `armor_type`: Cloth | Leather | Mail | Plate | Accessory | Tier Token. Accessory =
  armor-agnostic slots (neck/ring/trinket/back/weapon). Equippable tier pieces are seeded with
  `is_tier_token = 1` (from `tier_items`) since tokens, not pieces, drop; the council drop picker
  excludes source "Tier Set". Seeded via Admin → Sync Loot Tables (DB2/wago). Crafted items are not seeded.

### tier_items (guild-wide, season)
- `(class, slot, item_id)` per season — this season's equippable tier pieces (13 classes × 5 slots).
  Seeded via Admin → Sync Tier Items. Drives the council tier-piece view and the BIS-dropdown
  tier-piece allow-list (`tierPieceIds`, filtered by the character's class).

### worn_bis (team, season) — best-worn tracks
- One row per char × spec × slot. Records the **highest upgrade track ever worn** per BIS category
  (OverallBISTrack / RaidBISTrack / OtherTrack). Tracks never decrease (best-ever, merged each sync).
- Spec from WCL CombatantInfo `specID` (`WOW_SPEC_ID_TO_NAME`), else roster primary.
- **Season reset:** season-scoped, so a new season starts empty. Track detection is scoped to the
  season's own Veteran block via `seasons.veteran_bonus_id` (so prior-season gear reads Unknown and
  drops out). If that's unset, it falls back to the global multi-season list `wcl_track_veteran_ids`,
  which classifies gear from any season and therefore does **not** reset — set the season's Track
  Base in Admin → Seasons. `resolveVeteranStarts()` encodes this (used by the WCL sync and the
  dashboard SimC importer). Because it's best-ever, changing the Track Base does not lower already-
  stored rows: use Admin → **Reset Worn BIS Data**, then **Resync Worn BIS**, in that order.

### tier_snapshot (team, season)
- One row per char, upserted each sync — current state, not history. `tier_detail` = pipe-separated
  `slot:track` pairs. Used by the council view to show tier-piece status per candidate.

### raids / raid_encounters (team, season)
- `raids.id` = WCL report code (dedup key); `attendeeIds` pipe-separated Discord ids. Populated by
  the WCL cron sync. `raid_encounters` = one row per boss per report (kill %, pulls).

### rclc_response_map (team) — RCLC button → internal type
- Maps RCLC button labels to BIS | Non-BIS | Tertiary (and whether counted). Unmapped → Non-BIS.
- **Two accessors, one cache key** (`getRclcResponseMapRows` → array; `getRclcResponseMap` → Map).
  They must NOT register separate `cachedRead` loaders on the same key — that caused a shape
  collision (loot import got an array, `responseMap.get` threw). The Map accessor derives from the
  rows accessor. See the cache-layer note below.

### global_config (guild-wide, key/value)
- `guild_id`, `web_app_url`, `season_start`, `wcl_client_id`, `wcl_zone_ids` (legacy global fallback
  for season `zone_ids`), `wcl_veteran_bonus_id` (legacy single Track Base; superseded per-season),
  `wcl_track_veteran_ids` (auto-detected multi-season Veteran starts; the fallback that does NOT
  reset Worn BIS), `wcl_crafted_bonus_ids`, `spec_id_overrides`, `token_slot_overrides`.
  `WCL_CLIENT_SECRET` is an env/Worker secret, never in config.

### team_config (team, key/value)
- `officer_role_id`, `team_role_id`, channel IDs, `raid_days/time/instance`, `current_difficulty`,
  `wcl_guild_id` (WCL treats each team as its own guild), `wcl_last_check`, `wcl_pending_reports`.

## D1 cache layer (`src/lib/db.js`) — always consider this
D1 reads go through an in-memory cache (per Worker isolate, per process in tests):
- `cachedRead(key, ttl, loader)` — returns the cached value for `key` if present, otherwise runs
  `loader`; has in-flight dedup. TTLs: `LONG` (~4h: item_db, default_bis, spec_bis_config,
  tier_items), `SHORT` (~30m: roster, team_config, rclc_map, raids, tier_snapshot, worn_bis,
  current_season), `BRIEF`/others for hot data.
- `cacheInvalidate(key)` / `cacheInvalidatePrefix(prefix)` — every write function must invalidate the
  keys it affects. Note prefixes are `startsWith` matches: **`'roster'` (no colon) clears
  `roster:`, `roster_member:`, and `roster_pending_spec:`** — invalidate the family, not one member.
- **Cache keys must be unique per return shape.** Two functions caching different shapes under the
  same key will hand each other the wrong type (the RCLC map bug). If two accessors share data,
  derive one from the other rather than giving each its own loader on the same key.

## Loot council view (web app `/council`)
Per-candidate raw data: BIS drops (N/H/M), Non-BIS drops (N/H/M), Tertiary (total), raids attended,
Overall/Raid BIS match for the slot, current worn tracks, tier-piece status (for tokens), and
secondary-spec matches. Default filter: candidates with Raid BIS set for the slot; "show all
eligible" toggle widens it.

**Candidate scoring (`Council.jsx`).** Candidates are ranked by a score, highest first:
- `base = tierDistPts·(tokens) + bisMatchPoints + trackDelta·weight` — a lexicographic ordering
  (tier distribution ≫ BIS-match tier ≫ upgrade size), currently via large multipliers.
- Multiplied by fairness factors: **A** (attendance: `0.5 + 0.5·att/maxAtt`) and **L** (loot need:
  `1/(1+lootPerRaid)`, account-wide, weighted by `heroicWeight`/`normalWeight`/`nonBisWeight`).
- Hard-sinks (score floored) for a strict downgrade or an item the candidate already owns at/above
  the drop's track. Tier tokens use a parallel `scoreCurioCandidates`.
- Tunable knobs today: tier-distribution priority + the three loot weights. (The BIS/upgrade
  magnitudes are currently hardcoded; a tuning effort is exploring bringing the tiers closer so
  upgrade size and fairness reorder more — see the loot-score tuner artifact.)

## BIS sentinels
Valid in TrueBIS/RaidBIS; never stored in the Item DB.

| Sentinel    | Valid in          | Meaning                             | Matches a drop when…                                        |
|-------------|-------------------|-------------------------------------|-------------------------------------------------------------|
| `<Crafted>` | TrueBIS only      | Best item is crafted, not droppable | Never — informational                                       |
| `<Tier>`    | TrueBIS + RaidBIS | Tier set piece for this slot        | Dropped item `is_tier_token` = TRUE and slot matches        |
| `<Catalyst>`| TrueBIS + RaidBIS | Any catalyst-eligible drop          | Dropped item slot matches AND ArmorType matches character   |

- Tier slots (Head, Shoulders, Chest, Hands, Legs): `<Tier>` available, `<Catalyst>` not.
- Non-tier armor (Neck, Back, Wrists, Waist, Feet): `<Catalyst>` available, `<Tier>` not.
- Accessory slots (Rings, Trinkets, Weapon, Off-Hand): neither.
- The BIS form only offers valid sentinels per slot; validate on submit too.

**Armor type by class:** Cloth = Mage/Priest/Warlock · Leather = Druid/Demon Hunter/Monk/Rogue ·
Mail = Evoker/Hunter/Shaman · Plate = Death Knight/Paladin/Warrior. (`specs.js` is authoritative.)

## BIS display labels
Store `TrueBIS`/`RaidBIS`; **display** them as **"Overall BIS"** / **"Raid BIS"** everywhere.

## Upgrade type taxonomy
| RCLC Button  | Internal | Counted? |
|--------------|----------|----------|
| BIS          | BIS      | Yes (by N/H/M) |
| Item Upgrade | Non-BIS  | Yes (by N/H/M) |
| Tertiary     | Tertiary | No — shown separately |

## Key design decisions (don't re-litigate)
- **Loot history stays with the team.** On transfer the player starts fresh; old-team history is
  untouched. `transfers` is an audit log only.
- **Crafted items are not tracked** in Item DB or Loot Log; `<Crafted>` is a BIS sentinel only.
- **RCLC is the primary loot import** (via the bot); web `/import` is the fallback.
- **Attendance comes from Warcraft Logs** (cron sync); direct edits are an interim fallback.
- **Sentinel availability is enforced in the UI** and re-validated on submit.
- **The council does rank candidates** by a score (see above). The score is decision *support* — it
  orders the table; officers still make the call. (This supersedes the earlier "no priority score"
  decision from the Sheets era.)

## Code style conventions
- ESM throughout; async/await, no raw Promise chains.
- All D1 access goes through `src/lib/db.js` — never touch the D1 binding elsewhere; new `get*`
  functions use `cachedRead`, new writers call `cacheInvalidate*`.
- Route handlers live in `src/web/server/routes/` — one file per group; error responses are
  `{ error: 'message' }` JSON with an appropriate status.
- Migrations are append-only in `src/lib/migrations.js` with a `check()` that no-ops on already-
  applied schemas; update `schema.sql` in the same change for fresh DBs.

## Guild branding
- Name: **Canceled** · Primary `#CC1010` (crimson) · Surface `#1A1A1A` · Background `#0D0D0D`
- Motif: ❌ emoji · Vibe: dark, direct, no fluff

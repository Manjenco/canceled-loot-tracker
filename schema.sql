-- ─────────────────────────────────────────────────────────────────────────────
-- Canceled Loot Tracker — D1 Schema
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Guild-wide tables (master sheet equivalents) ──────────────────────────────

CREATE TABLE teams (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE global_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- Season registry — one row per season; only one may have is_current = 1
CREATE TABLE seasons (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL DEFAULT 'Season 1',
  start_date TEXT    NOT NULL DEFAULT '',  -- ISO date, e.g. "2025-01-21"
  is_current INTEGER NOT NULL DEFAULT 0,   -- 1 = active season
  mplus_wse  INTEGER DEFAULT NULL          -- current M+ WorldStateExpressionID gate (DB2); per season
);

-- Raid and M+ item database, seeded via /admin → Sync Loot Tables
CREATE TABLE item_db (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id     INTEGER NOT NULL DEFAULT 1 REFERENCES seasons(id),
  item_id       TEXT    NOT NULL,  -- Blizzard item ID
  name          TEXT    NOT NULL,
  slot          TEXT    NOT NULL,
  source_type   TEXT    NOT NULL,  -- Raid | Mythic+
  source_name   TEXT    NOT NULL,
  instance      TEXT    NOT NULL,
  difficulty    TEXT    NOT NULL,
  armor_type    TEXT    NOT NULL,  -- Cloth | Leather | Mail | Plate | Accessory | Tier Token
  is_tier_token INTEGER NOT NULL DEFAULT 0,
  UNIQUE (season_id, item_id)
);

CREATE INDEX idx_item_db_slot     ON item_db(season_id, slot);
CREATE INDEX idx_item_db_instance ON item_db(season_id, source_type, instance);

-- Spec BIS defaults, seeded via /admin
CREATE TABLE default_bis (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id        INTEGER NOT NULL DEFAULT 1 REFERENCES seasons(id),
  spec             TEXT    NOT NULL,
  slot             TEXT    NOT NULL,
  true_bis         TEXT    NOT NULL DEFAULT '',
  true_bis_item_id INTEGER REFERENCES item_db(id),
  raid_bis         TEXT    NOT NULL DEFAULT '',
  raid_bis_item_id INTEGER REFERENCES item_db(id),
  source           TEXT    NOT NULL DEFAULT '',  -- Icy Veins | Wowhead | Maxroll | Class Discord | Manual
  UNIQUE (season_id, spec, slot, source)
);

CREATE INDEX idx_default_bis_spec ON default_bis(season_id, spec);

-- Per-spec preferred BIS source override
CREATE TABLE spec_bis_config (
  season_id INTEGER NOT NULL DEFAULT 1 REFERENCES seasons(id),
  spec      TEXT    NOT NULL,
  source    TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (season_id, spec)
);

-- Current season tier piece item IDs, seeded via /admin → Sync Tier Items
CREATE TABLE tier_items (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id INTEGER NOT NULL DEFAULT 1 REFERENCES seasons(id),
  class     TEXT    NOT NULL,
  slot      TEXT    NOT NULL,
  item_id   TEXT    NOT NULL,
  UNIQUE (season_id, class, slot)
);

-- Per-season item-source manifest — the set of Blizzard journal instances (raid /
-- M+) that define a season's item pool. Re-pulling from these is how the Item DB is
-- kept in sync (additively today; diff/apply later). One row per source + difficulty.
CREATE TABLE season_sources (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id   INTEGER NOT NULL DEFAULT 1 REFERENCES seasons(id),
  source_type TEXT    NOT NULL DEFAULT 'raid',   -- raid | mythic_plus
  source_id   INTEGER NOT NULL,                  -- Blizzard journal instance id
  difficulty  TEXT    NOT NULL DEFAULT 'MYTHIC', -- MYTHIC | HEROIC | NORMAL | LOOKING_FOR_RAID | MYTHIC_KEYSTONE
  label       TEXT    NOT NULL DEFAULT '',       -- human-readable instance name
  enabled     INTEGER NOT NULL DEFAULT 1,
  added_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (season_id, source_id, difficulty)
);

CREATE INDEX idx_season_sources_season ON season_sources(season_id);

-- Cross-team transfer audit log
CREATE TABLE transfers (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  char_name TEXT    NOT NULL,
  from_team INTEGER NOT NULL REFERENCES teams(id),
  to_team   INTEGER NOT NULL REFERENCES teams(id),
  date      TEXT    NOT NULL,
  reason    TEXT    NOT NULL DEFAULT ''
);

-- ── Team-scoped tables ────────────────────────────────────────────────────────

-- Team-specific config key/value pairs (officer_role_id, raid_days, wcl_guild_id, etc.)
CREATE TABLE team_config (
  team_id INTEGER NOT NULL REFERENCES teams(id),
  key     TEXT    NOT NULL,
  value   TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (team_id, key)
);

-- Characters and their owners
-- Rename via UPDATE on char_name only — all foreign keys reference id (integer), not name
-- legacy_char_id: the UUID from Google Sheets, used during migration only; NULL for new characters
CREATE TABLE roster (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id         INTEGER NOT NULL REFERENCES teams(id),
  char_name       TEXT    NOT NULL,
  legacy_char_id  TEXT    UNIQUE,
  class      TEXT    NOT NULL,
  spec       TEXT    NOT NULL,
  role       TEXT    NOT NULL,  -- auto-derived from spec, never written directly
  status     TEXT    NOT NULL DEFAULT 'Active',  -- Active | Bench | Inactive
  owner_id   TEXT    NOT NULL DEFAULT '',        -- Discord user ID (snowflake)
  owner_nick          TEXT    NOT NULL DEFAULT '',
  server              TEXT    NOT NULL DEFAULT '',  -- only set when name conflicts exist
  secondary_specs     TEXT    NOT NULL DEFAULT '',  -- pipe-separated spec names
  pending_primary_spec TEXT   NOT NULL DEFAULT '',  -- spec awaiting officer approval
  attendance_adjustment INTEGER NOT NULL DEFAULT 0,  -- manual correction added to WCL attendance count
  deleted               INTEGER NOT NULL DEFAULT 0   -- 1 = soft-deleted; hidden from all roster reads
);

CREATE UNIQUE INDEX idx_roster_name_server ON roster(team_id, char_name, server);
CREATE INDEX        idx_roster_team_status ON roster(team_id, status);
CREATE INDEX        idx_roster_team_owner  ON roster(team_id, owner_id);

-- All loot awarded to a team
-- recipient_char_id is the FK to roster; recipient_name is stored for display/fallback
-- (unresolved "no roster match" entries have NULL recipient_char_id)
CREATE TABLE loot_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  -- No REFERENCES seasons(id): this column is added via ALTER TABLE in migration
  -- 0005, and SQLite forbids ALTER ADD COLUMN of a REFERENCES column with a
  -- non-NULL default. Kept FK-less here so fresh and migrated DBs match exactly.
  season_id         INTEGER NOT NULL DEFAULT 1,
  team_id           INTEGER NOT NULL REFERENCES teams(id),
  date              TEXT    NOT NULL,
  boss              TEXT    NOT NULL,
  item_name         TEXT    NOT NULL,
  difficulty        TEXT    NOT NULL DEFAULT '',  -- Normal | Heroic | Mythic
  recipient_id      TEXT    NOT NULL DEFAULT '',  -- Discord user ID
  recipient_name    TEXT    NOT NULL DEFAULT '',  -- raw character name from import
  recipient_char_id INTEGER REFERENCES roster(id),
  upgrade_type      TEXT    NOT NULL DEFAULT '',  -- BIS | Non-BIS | Tertiary
  notes             TEXT    NOT NULL DEFAULT '',
  ignored           INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_loot_log_team_char ON loot_log(team_id, recipient_char_id);
CREATE INDEX idx_loot_log_team_date ON loot_log(team_id, date);
CREATE INDEX idx_loot_log_season    ON loot_log(season_id, team_id, date);

-- Player BIS submissions
CREATE TABLE bis_submissions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  -- No REFERENCES seasons(id) — added via ALTER in migration 0005; see loot_log note.
  season_id        INTEGER NOT NULL DEFAULT 1,
  team_id          INTEGER NOT NULL REFERENCES teams(id),
  char_id          INTEGER REFERENCES roster(id),
  char_name        TEXT    NOT NULL DEFAULT '',  -- stored for display/fallback
  spec             TEXT    NOT NULL,
  slot             TEXT    NOT NULL,
  true_bis         TEXT    NOT NULL DEFAULT '',  -- item name or sentinel
  raid_bis         TEXT    NOT NULL DEFAULT '',
  rationale        TEXT    NOT NULL DEFAULT '',
  status           TEXT    NOT NULL DEFAULT 'Pending',  -- Pending | Approved | Rejected
  submitted_at     TEXT    NOT NULL DEFAULT '',
  reviewed_by      TEXT    NOT NULL DEFAULT '',         -- officer Discord user ID
  officer_note     TEXT    NOT NULL DEFAULT '',
  true_bis_item_id TEXT    DEFAULT NULL,  -- Blizzard item ID string; no FK (client-supplied)
  raid_bis_item_id TEXT    DEFAULT NULL
);

CREATE UNIQUE INDEX idx_bis_submissions_upsert ON bis_submissions(season_id, team_id, char_id, slot);
CREATE INDEX        idx_bis_team_char_status   ON bis_submissions(season_id, team_id, char_id, status);

-- Raid sessions (one row per WCL report)
-- raid_id = WCL report code (e.g. "AbCdEf12") — natural key used for dedup
CREATE TABLE raids (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  -- No REFERENCES seasons(id) — added via ALTER in migration 0005; see loot_log note.
  season_id  INTEGER NOT NULL DEFAULT 1,
  raid_id    TEXT    NOT NULL,
  team_id    INTEGER NOT NULL REFERENCES teams(id),
  date       TEXT    NOT NULL,
  instance   TEXT    NOT NULL,
  difficulty TEXT    NOT NULL,
  UNIQUE (raid_id, team_id)
);

CREATE INDEX idx_raids_team_date ON raids(team_id, date);
CREATE INDEX idx_raids_season    ON raids(season_id, team_id, date);

-- Raid attendance — normalised out of the pipe-separated AttendeeIds column
CREATE TABLE raid_attendees (
  raid_id INTEGER NOT NULL REFERENCES raids(id),
  user_id TEXT    NOT NULL,  -- Discord user ID
  PRIMARY KEY (raid_id, user_id)
);

CREATE INDEX idx_raid_attendees_user ON raid_attendees(user_id);

-- Per-boss results per WCL report
CREATE TABLE raid_encounters (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  raid_id      INTEGER NOT NULL REFERENCES raids(id),
  encounter_id INTEGER NOT NULL,
  boss_name    TEXT    NOT NULL,
  pulls        INTEGER NOT NULL DEFAULT 0,
  killed       INTEGER NOT NULL DEFAULT 0,
  best_pct     REAL    NOT NULL DEFAULT 0,
  UNIQUE (raid_id, encounter_id)
);

-- Current tier piece status per character — upserted on every WCL sync
-- tier_detail = pipe-separated slot:track pairs e.g. "Head:Mythic|Chest:Hero"
CREATE TABLE tier_snapshot (
  season_id  INTEGER NOT NULL DEFAULT 1 REFERENCES seasons(id),
  char_id    INTEGER NOT NULL REFERENCES roster(id),
  raid_id    INTEGER REFERENCES raids(id),
  tier_count INTEGER NOT NULL DEFAULT 0,
  tier_detail TEXT   NOT NULL DEFAULT '',
  updated_at TEXT    NOT NULL,
  PRIMARY KEY (season_id, char_id)
);

-- Highest upgrade track ever worn per character × season × slot × spec
CREATE TABLE worn_bis (
  season_id         INTEGER NOT NULL DEFAULT 1 REFERENCES seasons(id),
  char_id           INTEGER NOT NULL REFERENCES roster(id),
  slot              TEXT    NOT NULL,
  spec              TEXT    NOT NULL DEFAULT '',
  overall_bis_track TEXT    NOT NULL DEFAULT '',  -- Veteran | Champion | Hero | Mythic
  raid_bis_track    TEXT    NOT NULL DEFAULT '',
  other_track       TEXT    NOT NULL DEFAULT '',
  updated_at        TEXT    NOT NULL,
  PRIMARY KEY (season_id, char_id, slot, spec)
);

-- RCLC button → internal upgrade type mapping
CREATE TABLE rclc_response_map (
  team_id           INTEGER NOT NULL REFERENCES teams(id),
  rclc_button       TEXT    NOT NULL,
  internal_type     TEXT    NOT NULL,
  counted_in_totals INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (team_id, rclc_button)
);

-- Officer overrides for spec default BIS — keyed by season × spec × slot × source.
CREATE TABLE default_bis_overrides (
  season_id        INTEGER NOT NULL DEFAULT 1 REFERENCES seasons(id),
  spec             TEXT NOT NULL,
  slot             TEXT NOT NULL,
  source           TEXT NOT NULL DEFAULT '',
  true_bis         TEXT NOT NULL DEFAULT '',
  true_bis_item_id TEXT         DEFAULT NULL,
  raid_bis         TEXT NOT NULL DEFAULT '',
  raid_bis_item_id TEXT         DEFAULT NULL,
  PRIMARY KEY (season_id, spec, slot, source)
);

-- Pre-aggregated loot counts per character × season (materialized by rebuildLootSummary)
CREATE TABLE loot_summary (
  season_id     INTEGER NOT NULL DEFAULT 1 REFERENCES seasons(id),
  team_id       INTEGER NOT NULL REFERENCES teams(id),
  char_id       INTEGER NOT NULL REFERENCES roster(id),
  owner_id      TEXT    NOT NULL DEFAULT '',
  bis_mythic    INTEGER NOT NULL DEFAULT 0,
  bis_heroic    INTEGER NOT NULL DEFAULT 0,
  bis_normal    INTEGER NOT NULL DEFAULT 0,
  nonbis_mythic INTEGER NOT NULL DEFAULT 0,
  nonbis_heroic INTEGER NOT NULL DEFAULT 0,
  nonbis_normal INTEGER NOT NULL DEFAULT 0,
  tertiary      INTEGER NOT NULL DEFAULT 0,
  offspec       INTEGER NOT NULL DEFAULT 0,
  last_updated  TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (season_id, team_id, char_id)
);

CREATE INDEX IF NOT EXISTS idx_loot_summary_owner ON loot_summary(season_id, team_id, owner_id);

-- Tracks which schema migrations have been applied (via the admin DB Migrations UI or runMigrations()).
-- Bootstrapped automatically by getAppliedMigrations() — not required to exist before first use.
CREATE TABLE IF NOT EXISTS schema_migrations (
  name       TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Sentinel rows — satisfy FK constraints ────────────────────────────────────
-- team_id=0 / char_id=0 rows are excluded from all normal queries via
-- WHERE id > 0 on teams and WHERE team_id = ? on roster.
INSERT OR IGNORE INTO teams  (id, name)                                                VALUES (0, '__default__');
INSERT OR IGNORE INTO roster (id, team_id, char_name, class, spec, role, owner_id, owner_nick) VALUES (0, 0, '__default__', '', '', '', '', '');

-- Initial season — required so DEFAULT 1 on season_id columns satisfies FK constraints.
-- Update name and start_date via the season management admin page before going live.
INSERT OR IGNORE INTO seasons (id, name, start_date, is_current) VALUES (1, 'Season 1', '', 1);

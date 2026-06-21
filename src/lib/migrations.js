/**
 * migrations.js — In-process D1 migration registry.
 *
 * Each entry has:
 *   name        Filename-style identifier — used as the primary key in schema_migrations.
 *   description Human-readable summary shown in the admin UI.
 *   check       Async (db) → boolean — returns true if the migration has already been
 *               applied (either via this runner or via a manual `wrangler d1 execute`).
 *               Allows safely running the migration button on databases that were set up
 *               from schema.sql directly, without getting spurious errors.
 *   sql         The SQL to run when not already applied.  Passed to db.exec() which
 *               handles multi-statement strings.  Do NOT include leading/trailing
 *               whitespace-only lines — some D1 versions choke on them.
 *
 * Append new entries to the END of the array.  Never reorder or delete entries —
 * the check function is the source of truth for "already applied", and the name
 * is recorded permanently in schema_migrations once applied.
 */

export const MIGRATIONS = [
  {
    name: '0001_fix_bis_item_id_columns',
    description: 'Change bis_submissions item ID columns from INTEGER FK to TEXT (Blizzard IDs)',
    check: async (db) => {
      // Applied if true_bis_item_id is TEXT rather than INTEGER
      const row = await db.prepare(
        "SELECT type FROM pragma_table_info('bis_submissions') WHERE name = 'true_bis_item_id'"
      ).first();
      return row?.type?.toUpperCase() === 'TEXT';
    },
    sql: `
ALTER TABLE bis_submissions RENAME TO bis_submissions_old;
CREATE TABLE bis_submissions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id          INTEGER NOT NULL REFERENCES teams(id),
  char_id          INTEGER REFERENCES roster(id),
  char_name        TEXT    NOT NULL DEFAULT '',
  spec             TEXT    NOT NULL,
  slot             TEXT    NOT NULL,
  true_bis         TEXT    NOT NULL DEFAULT '',
  raid_bis         TEXT    NOT NULL DEFAULT '',
  rationale        TEXT    NOT NULL DEFAULT '',
  status           TEXT    NOT NULL DEFAULT 'Pending',
  submitted_at     TEXT    NOT NULL DEFAULT '',
  reviewed_by      TEXT    NOT NULL DEFAULT '',
  officer_note     TEXT    NOT NULL DEFAULT '',
  true_bis_item_id TEXT    DEFAULT NULL,
  raid_bis_item_id TEXT    DEFAULT NULL
);
INSERT INTO bis_submissions SELECT * FROM bis_submissions_old;
CREATE UNIQUE INDEX idx_bis_submissions_upsert ON bis_submissions(team_id, char_id, slot);
CREATE INDEX        idx_bis_team_char_status   ON bis_submissions(team_id, char_id, status);
DROP TABLE bis_submissions_old;
`.trim(),
  },

  {
    name: '0002_loot_summary',
    description: 'Create loot_summary materialized aggregate table',
    check: async (db) => {
      const row = await db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'loot_summary'"
      ).first();
      return !!row;
    },
    sql: `
CREATE TABLE IF NOT EXISTS loot_summary (
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
  PRIMARY KEY (team_id, char_id)
);
CREATE INDEX IF NOT EXISTS idx_loot_summary_owner ON loot_summary(team_id, owner_id);
`.trim(),
  },

  {
    name: '0003_attendance_adjustment',
    description: 'Add attendance_adjustment column to roster for manual corrections',
    check: async (db) => {
      const row = await db.prepare(
        "SELECT 1 FROM pragma_table_info('roster') WHERE name = 'attendance_adjustment'"
      ).first();
      return !!row;
    },
    sql: `ALTER TABLE roster ADD COLUMN attendance_adjustment INTEGER NOT NULL DEFAULT 0`,
  },
  {
    name: '0004_roster_soft_delete',
    description: 'Add deleted flag to roster for soft-delete support',
    check: async (db) => {
      const row = await db.prepare(
        "SELECT 1 FROM pragma_table_info('roster') WHERE name = 'deleted'"
      ).first();
      return !!row;
    },
    sql: `ALTER TABLE roster ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0`,
  },

  {
    name: '0005_seasons',
    description: 'Add seasons table and season_id FK to all operational/reference data tables',
    check: async (db) => {
      const row = await db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'seasons'"
      ).first();
      return !!row;
    },
    sql: `
PRAGMA defer_foreign_keys = ON;
CREATE TABLE seasons (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL DEFAULT 'Season 1',
  start_date TEXT    NOT NULL DEFAULT '',
  is_current INTEGER NOT NULL DEFAULT 0
);
INSERT INTO seasons (id, name, start_date, is_current)
VALUES (1, 'Season 1', COALESCE((SELECT value FROM global_config WHERE key = 'season_start'), ''), 1);
ALTER TABLE item_db RENAME TO _item_db_old;
CREATE TABLE item_db (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id     INTEGER NOT NULL DEFAULT 1 REFERENCES seasons(id),
  item_id       TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  slot          TEXT    NOT NULL,
  source_type   TEXT    NOT NULL,
  source_name   TEXT    NOT NULL,
  instance      TEXT    NOT NULL,
  difficulty    TEXT    NOT NULL,
  armor_type    TEXT    NOT NULL,
  is_tier_token INTEGER NOT NULL DEFAULT 0,
  UNIQUE (season_id, item_id)
);
INSERT INTO item_db (id, season_id, item_id, name, slot, source_type, source_name, instance, difficulty, armor_type, is_tier_token)
  SELECT id, 1, item_id, name, slot, source_type, source_name, instance, difficulty, armor_type, is_tier_token FROM _item_db_old;
DROP TABLE _item_db_old;
CREATE INDEX idx_item_db_slot     ON item_db(season_id, slot);
CREATE INDEX idx_item_db_instance ON item_db(season_id, source_type, instance);
ALTER TABLE default_bis RENAME TO _default_bis_old;
CREATE TABLE default_bis (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id        INTEGER NOT NULL DEFAULT 1 REFERENCES seasons(id),
  spec             TEXT    NOT NULL,
  slot             TEXT    NOT NULL,
  true_bis         TEXT    NOT NULL DEFAULT '',
  true_bis_item_id INTEGER REFERENCES item_db(id),
  raid_bis         TEXT    NOT NULL DEFAULT '',
  raid_bis_item_id INTEGER REFERENCES item_db(id),
  source           TEXT    NOT NULL DEFAULT '',
  UNIQUE (season_id, spec, slot, source)
);
INSERT INTO default_bis (id, season_id, spec, slot, true_bis, true_bis_item_id, raid_bis, raid_bis_item_id, source)
  SELECT d.id, 1, d.spec, d.slot, d.true_bis,
    CASE WHEN d.true_bis_item_id IS NOT NULL AND EXISTS (SELECT 1 FROM item_db WHERE id = d.true_bis_item_id)
         THEN d.true_bis_item_id ELSE NULL END,
    d.raid_bis,
    CASE WHEN d.raid_bis_item_id IS NOT NULL AND EXISTS (SELECT 1 FROM item_db WHERE id = d.raid_bis_item_id)
         THEN d.raid_bis_item_id ELSE NULL END,
    d.source
  FROM _default_bis_old d;
DROP TABLE _default_bis_old;
CREATE INDEX idx_default_bis_spec ON default_bis(season_id, spec);
ALTER TABLE spec_bis_config RENAME TO _spec_bis_config_old;
CREATE TABLE spec_bis_config (
  season_id INTEGER NOT NULL DEFAULT 1 REFERENCES seasons(id),
  spec      TEXT    NOT NULL,
  source    TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (season_id, spec)
);
INSERT INTO spec_bis_config (season_id, spec, source) SELECT 1, spec, source FROM _spec_bis_config_old;
DROP TABLE _spec_bis_config_old;
ALTER TABLE tier_items RENAME TO _tier_items_old;
CREATE TABLE tier_items (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id INTEGER NOT NULL DEFAULT 1 REFERENCES seasons(id),
  class     TEXT    NOT NULL,
  slot      TEXT    NOT NULL,
  item_id   TEXT    NOT NULL,
  UNIQUE (season_id, class, slot)
);
INSERT INTO tier_items (id, season_id, class, slot, item_id) SELECT id, 1, class, slot, item_id FROM _tier_items_old;
DROP TABLE _tier_items_old;
ALTER TABLE default_bis_overrides RENAME TO _default_bis_overrides_old;
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
INSERT INTO default_bis_overrides (season_id, spec, slot, source, true_bis, true_bis_item_id, raid_bis, raid_bis_item_id)
  SELECT 1, spec, slot, source, true_bis, true_bis_item_id, raid_bis, raid_bis_item_id FROM _default_bis_overrides_old;
DROP TABLE _default_bis_overrides_old;
ALTER TABLE loot_log ADD COLUMN season_id INTEGER NOT NULL DEFAULT 1 REFERENCES seasons(id);
CREATE INDEX idx_loot_log_season ON loot_log(season_id, team_id, date);
ALTER TABLE bis_submissions ADD COLUMN season_id INTEGER NOT NULL DEFAULT 1 REFERENCES seasons(id);
DROP INDEX idx_bis_submissions_upsert;
DROP INDEX idx_bis_team_char_status;
CREATE UNIQUE INDEX idx_bis_submissions_upsert ON bis_submissions(season_id, team_id, char_id, slot);
CREATE INDEX        idx_bis_team_char_status   ON bis_submissions(season_id, team_id, char_id, status);
ALTER TABLE raids ADD COLUMN season_id INTEGER NOT NULL DEFAULT 1 REFERENCES seasons(id);
CREATE INDEX idx_raids_season ON raids(season_id, team_id, date);
ALTER TABLE tier_snapshot RENAME TO _tier_snapshot_old;
CREATE TABLE tier_snapshot (
  season_id   INTEGER NOT NULL DEFAULT 1 REFERENCES seasons(id),
  char_id     INTEGER NOT NULL REFERENCES roster(id),
  raid_id     INTEGER REFERENCES raids(id),
  tier_count  INTEGER NOT NULL DEFAULT 0,
  tier_detail TEXT    NOT NULL DEFAULT '',
  updated_at  TEXT    NOT NULL,
  PRIMARY KEY (season_id, char_id)
);
INSERT INTO tier_snapshot (season_id, char_id, raid_id, tier_count, tier_detail, updated_at)
  SELECT 1, char_id,
    CASE WHEN raid_id IS NOT NULL AND EXISTS (SELECT 1 FROM raids WHERE id = raid_id)
         THEN raid_id ELSE NULL END,
    tier_count, tier_detail, updated_at FROM _tier_snapshot_old
  WHERE char_id IN (SELECT id FROM roster);
DROP TABLE _tier_snapshot_old;
ALTER TABLE worn_bis RENAME TO _worn_bis_old;
CREATE TABLE worn_bis (
  season_id         INTEGER NOT NULL DEFAULT 1 REFERENCES seasons(id),
  char_id           INTEGER NOT NULL REFERENCES roster(id),
  slot              TEXT    NOT NULL,
  spec              TEXT    NOT NULL DEFAULT '',
  overall_bis_track TEXT    NOT NULL DEFAULT '',
  raid_bis_track    TEXT    NOT NULL DEFAULT '',
  other_track       TEXT    NOT NULL DEFAULT '',
  updated_at        TEXT    NOT NULL,
  PRIMARY KEY (season_id, char_id, slot, spec)
);
INSERT INTO worn_bis (season_id, char_id, slot, spec, overall_bis_track, raid_bis_track, other_track, updated_at)
  SELECT 1, char_id, slot, spec, overall_bis_track, raid_bis_track, other_track, updated_at FROM _worn_bis_old
  WHERE char_id IN (SELECT id FROM roster);
DROP TABLE _worn_bis_old;
ALTER TABLE loot_summary RENAME TO _loot_summary_old;
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
INSERT INTO loot_summary (season_id, team_id, char_id, owner_id, bis_mythic, bis_heroic, bis_normal, nonbis_mythic, nonbis_heroic, nonbis_normal, tertiary, offspec, last_updated)
  SELECT 1, team_id, char_id, owner_id, bis_mythic, bis_heroic, bis_normal, nonbis_mythic, nonbis_heroic, nonbis_normal, tertiary, offspec, last_updated FROM _loot_summary_old
  WHERE char_id IN (SELECT id FROM roster)
    AND team_id IN (SELECT id FROM teams);
DROP TABLE _loot_summary_old;
CREATE INDEX idx_loot_summary_owner ON loot_summary(season_id, team_id, owner_id);
`.trim(),
  },
];

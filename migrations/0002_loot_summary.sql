-- Materialized per-character loot aggregate table.
-- Populated/updated by rebuildLootSummary() after every loot_log write.
-- Replaces full-table scans in council and loot history routes.

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
